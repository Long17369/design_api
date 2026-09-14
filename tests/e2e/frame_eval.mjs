import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 引擎「每帧评估 + 组件自去重」语义验证（过压保护为样本）：
 *  ① 连续 3 帧过压 → 只应产生 1 次告警 + heat/water 各 1 次控制（各 1 帧下发）
 *  ② 再过 3 帧（仍过压、已全部关闭）→ 应无新增告警 / 控制 / 下发
 */
const D_NO = 'E2E_FRAME'
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
const counts = async () => ({
  controlLogs: Number(
    (await q('SELECT COUNT(*) AS c FROM control_log WHERE d_no = ?', [D_NO]))[0].c,
  ),
  alarms: Number(
    (await q("SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field3 = 'block'", [D_NO]))[0]
      .c,
  ),
})

for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q('INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW())', [
  'auto',
  '1',
  D_NO,
])

const frames = []
const sub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => sub.on('connect', resolve))
await new Promise((resolve) => sub.subscribe('control/', { qos: 0 }, resolve))
sub.on('message', (topic, buf) => frames.push({ topic, payload: JSON.parse(buf.toString()) }))

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
        water_Y2: 0,
        flow_rate: 5,
        pressure: 30,
        ...over,
      }),
      resolve,
    )
  })

const result = {}

// ---------- ① 连续 3 帧过压 ----------
frames.length = 0
for (let i = 0; i < 3; i++) {
  await publish()
  await sleep(400)
}
await sleep(600)
result.phase1 = { ...(await counts()), frames: frames.map((f) => f.payload.mb) }

// ---------- ② 再过 3 帧（仍过压） ----------
frames.length = 0
for (let i = 0; i < 3; i++) {
  await publish()
  await sleep(400)
}
await sleep(600)
result.phase2 = { ...(await counts()), frames: frames.map((f) => f.payload.mb) }

for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()
fs.writeFileSync('tmp/frame_eval_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

const fail = (msg) => {
  throw new Error(msg)
}
if (result.phase1.alarms !== 1) fail(`① 过压告警应 1 条，实际 ${result.phase1.alarms}`)
if (result.phase1.controlLogs !== 2) fail(`① 控制记录应 2 条，实际 ${result.phase1.controlLogs}`)
if (result.phase1.frames.length !== 2)
  fail(`① 下发行应 2 帧，实际 ${JSON.stringify(result.phase1.frames)}`)
if (result.phase2.alarms !== 1) fail(`② 持续过压不应新增告警，实际 ${result.phase2.alarms}`)
if (result.phase2.controlLogs !== 2)
  fail(`② 持续过压不应新增控制，实际 ${result.phase2.controlLogs}`)
if (result.phase2.frames.length !== 0)
  fail(`② 持续过压不应再下发，实际 ${JSON.stringify(result.phase2.frames)}`)

console.log('E2E_FRAME_EVAL_OK')
sub.end()
pub.end()
process.exit(0)
