import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 关泵连带关加热（两层防护）端到端：
 *  ① 状态兜底·指令值：指令 water=0 而 heat=1 → 上报帧触发「立即关加热」
 *  ② 状态兜底·上报值：指令 water=1 但上报水泵停 → 同样立即关加热
 *  ③ 引擎统一规则：关泵决策（flowTarget 达目标）自动在前面补「关加热」，
 *     且 control_log 记为「…（关泵联动关加热）」
 */
const D_NO = 'E2E_PHC'
const API = 'http://127.0.0.1:10452/api'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowStr = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8')).database
const db = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.username,
  password: cfg.password,
  database: cfg.database_name,
})
const q = async (sql, params = []) => (await db.query(sql, params))[0]
const value = async (configId) =>
  (
    await q('SELECT value FROM direct WHERE d_no = ? AND config_id = ? LIMIT 1', [D_NO, configId])
  )[0]?.value ?? null
const reset = () =>
  fetch(`${API}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)
const update = (config_id, value) =>
  fetch(`${API}/direct/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id, value, d_no: D_NO }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '1', D_NO, 'heat', '1', D_NO, 'water', '1', D_NO],
)

const frames = []
const sub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => sub.on('connect', resolve))
await new Promise((resolve) => sub.subscribe('control/', { qos: 0 }, resolve))
sub.on('message', (topic, buf) => frames.push(JSON.parse(buf.toString()).mb))

const pub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => pub.on('connect', resolve))
const publish = (over = {}) =>
  new Promise((resolve) => {
    pub.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: nowStr(),
        temp_in: 20,
        temp_out: 25,
        heat_Y1: 1,
        water_Y2: 1,
        flow_rate: 5,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

const result = {}

// 基准帧 + 等过水泵启动宽限期
await publish({ water_Y2: 1 })
await sleep(11_000)

// ---------- ① 兜底：指令 water=0 而 heat=1 ----------
await update('water', '0')
await sleep(400)
frames.length = 0
await publish({ water_Y2: 1 })
await sleep(1200)
result.phase1 = { heat: await value('heat'), frames: [...frames] }

// ---------- ② 兜底：上报水泵停（指令仍为 1） ----------
await update('heat', '1')
await update('water', '1')
await sleep(400)
frames.length = 0
await publish({ water_Y2: 0 })
await sleep(1200)
result.phase2 = { heat: await value('heat'), frames: [...frames] }
result.phase2Reason = (
  await q('SELECT field5 FROM control_log WHERE d_no = ? AND field2 = ? ORDER BY id DESC LIMIT 1', [
    D_NO,
    'heat',
  ])
)[0]?.field5

// ---------- ③ 统一规则：关泵决策前自动补关加热（flowTarget 触发关泵） ----------
// 先恢复「上报水泵运行」并等过启动宽限期（阶段②上报过泵停，重启会重新进入宽限期）
await publish({ water_Y2: 1 })
await sleep(11_000)
await update('heat', '1')
await update('water', '1')
await update('flow_target_enabled', '1')
await update('total_flow_target', '2')
await sleep(400)
frames.length = 0
await publish({ flow_rate: 60 })
await publish({ flow_rate: 60 })
await sleep(1500)
result.phase3 = { heat: await value('heat'), water: await value('water'), frames: [...frames] }
result.phase3RelayLog = (
  await q(
    "SELECT field5 FROM control_log WHERE d_no = ? AND field5 LIKE '%联动%' ORDER BY id DESC LIMIT 1",
    [D_NO],
  )
)[0]?.field5

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
sub.end(true)
pub.end(true)
await db.end()
fs.writeFileSync('tmp/pump_heat_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check(
  '① 指令泵停 → 自动关加热',
  result.phase1.heat === '0' && result.phase1.frames.includes('010600070000'),
)
check(
  '② 上报泵停 → 自动关加热（记安全规则）',
  result.phase2.heat === '0' &&
    result.phase2.frames.includes('010600070000') &&
    String(result.phase2Reason).includes('安全规则'),
)
check(
  '③ 关泵决策先关加热（顺序 heat→water）',
  JSON.stringify(result.phase3.frames) === JSON.stringify(['010600070000', '010600060000']) &&
    result.phase3.heat === '0' &&
    result.phase3.water === '0',
)
check('③ control_log 记录联动原因', String(result.phase3RelayLog).includes('关泵联动关加热'))

console.log('\n汇总:', JSON.stringify(result))
if (checks.some((c) => !c.ok)) {
  console.log(
    'FAILED:',
    checks
      .filter((c) => !c.ok)
      .map((c) => c.name)
      .join(' | '),
  )
  process.exit(1)
}
console.log('E2E_PUMP_HEAT_OK')
process.exit(0)
