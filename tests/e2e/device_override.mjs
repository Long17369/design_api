import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 设备级配置覆盖端到端（真实 MQTT 上报 + HTTP 改配置）：
 *  ① 设备级 temp_max=25（全局默认 35）→ 30°C 就关加热（说明设备值优先，且即时生效）
 *  ② 设备级 temp_min=28（全局默认 10）→ 27°C 就开加热
 *  ③ 设备级 temp_max=50 → 40°C 不关加热（覆盖方向反过来也成立）
 *  ④ 清掉设备级行 → 仍读全局默认值（35/10）
 * 关键：全程**不重启服务进程**，即验证「前端改设备配置立即生效」。
 */
const D_NO = 'E2E_OVR'
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
  ['auto', '1', D_NO, 'heat', '0', D_NO, 'water', '1', D_NO],
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
        temp_out: 20,
        heat_Y1: 0,
        water_Y2: 1,
        flow_rate: 5,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

const result = {}

// 基准帧 + 等过水泵启动宽限期（pump_start_grace 默认 10s）
await publish({ temp_out: 30 })
await sleep(11_000)

// ---------- ① 设备级 temp_max=25 → 30°C 关加热 ----------
result.set1 = await update('temp_max', '25')
result.setHeat1 = await update('heat', '1')
await sleep(400)
frames.length = 0
await publish({ temp_out: 30 })
await sleep(1200)
result.phase1 = { heat: await value('heat'), frames: [...frames] }

// ---------- ② 设备级 temp_min=28 → 27°C 开加热 ----------
result.set2 = await update('temp_min', '28')
await update('heat', '0')
await sleep(400)
frames.length = 0
await publish({ temp_out: 27, water_Y2: 1 })
await sleep(1200)
result.phase2 = { heat: await value('heat'), frames: [...frames] }

// ---------- ③ 设备级 temp_max=50 → 40°C 不关加热 ----------
result.set3 = await update('temp_max', '50')
await update('heat', '1')
await sleep(400)
frames.length = 0
await publish({ temp_out: 40 })
await sleep(1200)
result.phase3 = { heat: await value('heat'), frames: [...frames] }

// ---------- ④ 清掉设备级 temp_max → 回退全局默认 35 → 40°C 关加热 ----------
await q('DELETE FROM direct WHERE d_no = ? AND config_id = ?', [D_NO, 'temp_max'])
await update('heat', '1')
await sleep(400)
frames.length = 0
await publish({ temp_out: 40 })
await sleep(1200)
result.phase4 = { heat: await value('heat'), frames: [...frames] }

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}

check(
  '① 设备级 temp_max 生效（30°C 关加热）',
  result.phase1.heat === '0' && result.phase1.frames.includes('010600070000'),
)
check(
  '② 设备级 temp_min 生效（27°C 开加热）',
  result.phase2.heat === '1' && result.phase2.frames.includes('010600070001'),
)
check(
  '③ 设备级 temp_max=50 覆盖全局（40°C 不关加热）',
  result.phase3.heat === '1' && !result.phase3.frames.includes('010600070000'),
)
check(
  '④ 无设备值回退全局默认（40°C 关加热）',
  result.phase4.heat === '0' && result.phase4.frames.includes('010600070000'),
)

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
sub.end(true)
pub.end(true)
await db.end()

fs.writeFileSync('tmp/device_override_result.json', JSON.stringify(result, null, 2))
const failed = checks.filter((c) => !c.ok)
console.log(`\n${result ? '结果已写入 tmp/device_override_result.json' : ''}`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((c) => c.name).join(' | '))
  process.exit(1)
}
console.log('E2E_DEVICE_OVERRIDE_OK')
process.exit(0)
