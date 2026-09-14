import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 指令下发验证（订阅 control/ 抓报文）：
 *  ① 手动改 heat/water 的 on/off → 对应 Modbus 帧
 *  ② 未登记报文的指令码（auto）→ 不下发
 *  ③ 堵塞保护自动下发 → 先关加热再关水泵（防干烧顺序）
 */
const API = 'http://127.0.0.1:10452/api'
const D_NO = 'E2E_DISPATCH'
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

/** 复位该设备（清堵塞标记 + 释放保护锁）：清除上一次运行残留在服务进程内的锁 */
const reset = () =>
  fetch('http://127.0.0.1:10452/api/control/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)
await reset()

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
sub.on('message', (topic, buf) => {
  let payload
  try {
    payload = JSON.parse(buf.toString())
  } catch {
    payload = buf.toString()
  }
  frames.push({ topic, payload })
})

const setValue = async (config_id, value) => {
  const res = await fetch(`${API}/direct/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id, value, d_no: D_NO }),
  })
  await sleep(250)
  return res.status
}

const take = () => frames.splice(0, frames.length)
take()

const result = {}

// ---------- ① 手动下发 ----------
result.heatOn = { status: await setValue('heat', '1'), frames: take() }
result.heatOff = { status: await setValue('heat', '0'), frames: take() }
result.waterOn = { status: await setValue('water', '1'), frames: take() }
result.waterOff = { status: await setValue('water', '0'), frames: take() }

// ---------- ② 未登记报文的指令码不下发 ----------
result.auto = { status: await setValue('auto', '1'), frames: take() }

// ---------- ③ 堵塞保护自动下发 ----------
const pub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => pub.on('connect', resolve))
await new Promise((resolve) =>
  pub.publish(
    'data/',
    JSON.stringify({
      id: D_NO,
      time: nowStr(),
      temp_in: 20,
      temp_out: 30,
      heat_Y1: 1,
      water_Y2: 0,
      flow_rate: 5,
      pressure: 0,
    }),
    resolve,
  ),
)
await sleep(1500)
result.blocked = {
  blocked: (
    await q('SELECT id FROM device_locks WHERE d_no = ? AND type = ?', [D_NO, 'blocked'])
  )[0]
    ? '1'
    : '0',
  frames: take(),
}

// ---------- 清理 ----------
await reset()

for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()
fs.writeFileSync('tmp/dispatch_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const fail = (msg) => {
  throw new Error(msg)
}
const one = (step) => {
  const list = result[step].frames
  if (list.length !== 1) fail(`${step} 期望 1 条下发，实际 ${list.length}: ${JSON.stringify(list)}`)
  if (list[0].topic !== 'control/') fail(`${step} topic 应为 control/，实际 ${list[0].topic}`)
  return list[0].payload
}
const expectFrame = (step, mb) => {
  const p = one(step)
  if (p.mb !== mb || p.sn !== 1 || p.ack !== 0 || p.crc !== 1 || p.uart !== 8)
    fail(`${step} 报文不符: ${JSON.stringify(p)}`)
}

expectFrame('heatOn', '010600070001')
expectFrame('heatOff', '010600070000')
expectFrame('waterOn', '010600060001')
expectFrame('waterOff', '010600060000')
if (result.auto.frames.length !== 0)
  fail(`auto 不该下发，实际 ${JSON.stringify(result.auto.frames)}`)
if (result.blocked.blocked !== '1') fail('堵塞未触发')
const bf = result.blocked.frames.map((f) => f.payload.mb)
if (bf.length !== 2 || bf[0] !== '010600070000' || bf[1] !== '010600060000')
  fail(`堵塞下发应「先关加热再关水泵」，实际 ${JSON.stringify(bf)}`)

console.log('E2E_DISPATCH_OK')
sub.end()
pub.end()
process.exit(0)
