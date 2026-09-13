import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * PID 控温端到端（PWM 开关加热，短周期便于验证）：
 *  ① 目标 30 / 实测 20（Kp=0.05 → 占空比 0.5，周期 6s）→ 周期起始开加热
 *  ② 半周期后（>3s）→ 关加热
 *  ③ 下个周期起始（>6s）→ 重新开加热
 * 配置走设备级覆盖（pid_enabled / pid_target / pid_kp / pid_cycle 等）。
 */
const D_NO = 'E2E_PID'
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

await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES ' +
    new Array(12).fill('(?,?,?,NOW())').join(','),
  [
    'auto',
    '1',
    D_NO,
    'heat',
    '0',
    D_NO,
    'water',
    '1',
    D_NO,
    'pid_enabled',
    '1',
    D_NO,
    'pid_target',
    '30',
    D_NO,
    'pid_kp',
    '0.05',
    D_NO,
    'pid_ki',
    '0',
    D_NO,
    'pid_kd',
    '0',
    D_NO,
    'pid_cycle',
    '6',
    D_NO,
    'pid_sensor',
    '2',
    D_NO,
    'flow_unchanged_seconds',
    '600',
    D_NO,
    'pump_idle_seconds',
    '0',
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

// 基准帧 + 等过水泵启动宽限期
await publish()
await sleep(11_000)

// 静止超过一个周期（pid_cycle=6s）：使下一帧必定开启新周期，避免上一轮状态影响
await sleep(7_000)

const result = { phase1: {}, phase2: {}, phase3: {} }

// ---------- ① 新周期起始 → 开加热 ----------
await publish()
await sleep(1000)
result.phase1 = { heat: await value('heat'), frames: [...frames] }

// ---------- ② 半周期后（>3s）→ 关加热 ----------
await sleep(3000)
await publish() // 引擎由上报驱动：需新帧才会重新评估占空比
await sleep(1000)
result.phase2 = { heat: await value('heat'), frames: [...frames] }

// ---------- ③ 下个周期（>6s）→ 重新开加热 ----------
await sleep(3500)
await publish()
await sleep(1000)
result.phase3 = { heat: await value('heat'), frames: [...frames] }

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
sub.end(true)
pub.end(true)
await db.end()
fs.writeFileSync('tmp/pid_temp_result.json', JSON.stringify(result, null, 2))

const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
const allFrames = [...result.phase1.frames, ...result.phase2.frames, ...result.phase3.frames]
check('① 周期起始 → 开加热', result.phase1.heat === '1')
check(
  '② 半周期后 → 关加热（070000）',
  result.phase2.heat === '0' && allFrames.includes('010600070000'),
)
check('③ 下个周期 → 重新开加热', result.phase3.heat === '1' && allFrames.includes('010600070001'))

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
console.log('E2E_PID_TEMP_OK')
process.exit(0)
