import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 水泵空转保护端到端（原 pumpIdle 已并入 flow_zero 组件）：
 *  ① 流量短暂归零后恢复 → 去抖重置，不动作
 *  ② 泵运行中流量持续归零 ≥ pump_idle_seconds → 关加热（联动）+ 关泵 + 黄色告警
 *  ③ 持续归零 → 幂等，不再重复告警/下发
 * 配置走设备级覆盖（立即生效）；同时把 flow_unchanged_seconds 调大，避免累计流量不变判定干扰。
 */
const D_NO = 'E2E_IDLE'
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
const alarmCount = async (...codes) =>
  Number(
    (
      await q(
        `SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field2 IN (${codes.map(() => '?').join(',')})`,
        [D_NO, ...codes],
      )
    )[0].c,
  )

const reset = () =>
  fetch(`${API}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)

await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES ' +
    '(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  [
    'auto',
    '1',
    D_NO,
    'heat',
    '1',
    D_NO,
    'water',
    '1',
    D_NO,
    'pump_idle_seconds',
    '3',
    D_NO,
    'flow_unchanged_seconds',
    '600',
    D_NO,
  ],
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
await publish({ flow_rate: 5 })
await sleep(11_000)

// ---------- ① 短暂归零后恢复 → 不动作 ----------
frames.length = 0
await publish({ flow_rate: 0 })
await sleep(1000)
await publish({ flow_rate: 5 })
await sleep(1200)
result.phase1 = {
  water: await value('water'),
  frames: [...frames],
  alarms: await alarmCount('pump_idle'),
}

// ---------- ② 持续归零 ≥3s → 关泵 + 告警 ----------
frames.length = 0
for (let i = 0; i < 5; i++) {
  await publish({ flow_rate: 0 })
  await sleep(1000)
}
await sleep(500)
result.phase2 = {
  water: await value('water'),
  heat: await value('heat'),
  frames: [...frames],
  alarms: await alarmCount('pump_idle'),
  reason: (
    await q(
      'SELECT field5 FROM control_log WHERE d_no = ? AND field5 LIKE ? ORDER BY id DESC LIMIT 1',
      [D_NO, '%空转%'],
    )
  )[0]?.field5,
}

// ---------- ③ 持续归零 → 幂等 ----------
frames.length = 0
for (let i = 0; i < 3; i++) {
  await publish({ flow_rate: 0 })
  await sleep(1000)
}
result.phase3 = { frames: [...frames], alarms: await alarmCount('pump_idle') }

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
sub.end(true)
pub.end(true)
await db.end()
fs.writeFileSync('tmp/pump_idle_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check(
  '① 短暂归零（未到去抖时长）不动作',
  result.phase1.water === '1' && result.phase1.frames.length === 0 && result.phase1.alarms === 0,
)
check(
  '② 持续归零 → 关加热 + 关泵（顺序 heat→water）',
  result.phase2.water === '0' &&
    result.phase2.heat === '0' &&
    JSON.stringify(result.phase2.frames) === JSON.stringify(['010600070000', '010600060000']),
)
check(
  '② 产生 pump_idle 告警且记录空转原因',
  result.phase2.alarms === 1 && String(result.phase2.reason).includes('空转'),
)
check(
  '③ 持续归零幂等（不再下发/告警）',
  result.phase3.frames.length === 0 && result.phase3.alarms === 1,
)

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
console.log('E2E_PUMP_IDLE_OK')
process.exit(0)
