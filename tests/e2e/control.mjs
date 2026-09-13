import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 手动控制接口端到端（HTTP POST /api/control）：
 *  ① auto=0 → 200：写 direct + 下发 control/ 帧 + WS direct 通知 + control_log(manual)
 *  ② auto=1 → 400 且不落库（旧项目规则：on/off 都禁）
 *  ③ 缺 target → 400
 *  ④ 非法 action → 400
 */
const API = 'http://127.0.0.1:10452/api'
const D_NO = 'E2E_CONTROL'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  '0',
  D_NO,
])

// MQTT 订阅 control/ 抓下发帧
const frames = []
const sub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => sub.on('connect', resolve))
await new Promise((resolve) => sub.subscribe('control/', { qos: 0 }, resolve))
sub.on('message', (topic, buf) => frames.push(JSON.parse(buf.toString()).mb))

// WS 收集 direct 事件
const pushes = []
const ws = new WebSocket('ws://127.0.0.1:10452/')
ws.on('message', (buf) => {
  try {
    pushes.push(JSON.parse(buf.toString()))
  } catch {
    /* 忽略 */
  }
})
await new Promise((resolve) => ws.on('open', resolve))
await sleep(300)

const post = async (body) => {
  const res = await fetch(`${API}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await sleep(300)
  return { status: res.status, body: await res.json() }
}

const result = {}

// ---------- ① 正常下发 ----------
frames.length = 0
pushes.length = 0
result.ok = await post({ target: 'heat', action: 'on', d_no: D_NO })
result.ok.heat = await value('heat')
result.ok.frames = [...frames]
result.ok.directEvents = pushes.filter((p) => p.event === 'direct').map((p) => p.data)
result.ok.logs = await q(
  'SELECT field1, field2, field3, field4, field5 FROM control_log WHERE d_no = ?',
  [D_NO],
)

// ---------- ② auto=1 → 拒绝 ----------
await q("UPDATE direct SET value = '1' WHERE d_no = ? AND config_id = 'auto'", [D_NO])
result.autoOn = await post({ target: 'heat', action: 'off', d_no: D_NO })
result.autoOn.heat = await value('heat')
result.autoOn.logs = await q('SELECT COUNT(*) AS c FROM control_log WHERE d_no = ?', [D_NO])
await q("UPDATE direct SET value = '0' WHERE d_no = ? AND config_id = 'auto'", [D_NO])

// ---------- ③ 缺 target / ④ 非法 action ----------
result.missingTarget = await post({ action: 'on', d_no: D_NO })
result.badAction = await post({ target: 'heat', action: 'toggle', d_no: D_NO })

await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()
fs.writeFileSync('tmp/control_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

const fail = (msg) => {
  throw new Error(msg)
}
if (result.ok.status !== 200) fail(`① 应 200，实际 ${result.ok.status}`)
if (!result.ok.body?.data?.message) fail('① 响应应含 message')
if (result.ok.heat !== '1') fail(`① heat 应写为 1，实际 ${result.ok.heat}`)
if (result.ok.frames.length !== 1 || result.ok.frames[0] !== '010600070001')
  fail(`① 应下发开加热帧，实际 ${JSON.stringify(result.ok.frames)}`)
if (result.ok.directEvents.length !== 1 || result.ok.directEvents[0].source !== 'manual')
  fail(`① 应收到 1 条 manual 的 direct 通知，实际 ${JSON.stringify(result.ok.directEvents)}`)
const log = result.ok.logs[0]
if (!log || log.field1 !== 'manual' || log.field5 !== '手动控制')
  fail(`① control_log 不符：${JSON.stringify(log)}`)

if (result.autoOn.status !== 400) fail(`② auto=1 应 400，实际 ${result.autoOn.status}`)
if (!String(result.autoOn.body?.error?.message).includes('自动控制已开启'))
  fail(`② 错误信息不符：${JSON.stringify(result.autoOn.body)}`)
if (result.autoOn.heat !== '1') fail('② auto=1 时不应改动 direct')
if (result.autoOn.logs[0].c !== 1) fail('② auto=1 时不应新增 control_log')

if (result.missingTarget.status !== 400)
  fail(`③ 缺 target 应 400，实际 ${result.missingTarget.status}`)
if (result.badAction.status !== 400) fail(`④ 非法 action 应 400，实际 ${result.badAction.status}`)

console.log('E2E_CONTROL_OK')
sub.end()
ws.close()
process.exit(0)
