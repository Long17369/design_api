import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * WS 推送验证（真实 MQTT 上报）：
 *  ① data   —— 上报一帧后前端收到实时数据（含 heat_rate / avg_flow / 累计流量）
 *  ② direct —— 手动改指令：成功推 success:true + source:'manual'
 *  ③ direct —— 非法配置码：推 success:false + error（且 HTTP 400）
 *  ④ direct —— 堵塞保护自动下发：推 source:'auto'
 */
const API = 'http://127.0.0.1:10452/api'
const D_NO = 'E2E_WS'
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
const blockedValue = async () =>
  (await q('SELECT id FROM device_locks WHERE d_no = ? AND type = ? LIMIT 1', [D_NO, 'blocked']))[0]
    ? '1'
    : '0'

// ---------- 准备 ----------
// 约定：起止各复位一次设备 —— 保护锁存在服务进程内存里，删库行不会释放锁
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
await q('INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW())', [
  'auto',
  '1',
  D_NO,
  'heat',
  '1',
  D_NO,
])

const msgs = []
const ws = new WebSocket('ws://127.0.0.1:10452/')
ws.on('message', (buf) => {
  try {
    msgs.push(JSON.parse(buf.toString()))
  } catch {
    /* 忽略非 JSON */
  }
})
await new Promise((resolve) => ws.on('open', resolve))
await sleep(300)

const mq = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => mq.on('connect', resolve))
const publish = (over = {}) =>
  new Promise((resolve) => {
    mq.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: nowStr(),
        temp_in: 20,
        temp_out: 30,
        heat_Y1: 1,
        water_Y2: 0,
        flow_rate: 5,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

const result = {}

// ---------- ① data 推送 ----------
let from = msgs.length
await publish()
await sleep(1200)
result.data = msgs.slice(from).find((m) => m.event === 'data') ?? null

// ---------- ② 手动改指令 → direct success ----------
from = msgs.length
const r2 = await fetch(`${API}/direct/update`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config_id: 'heat', value: '0', d_no: D_NO }),
})
await sleep(300)
result.manual = {
  status: r2.status,
  event: msgs.slice(from).find((m) => m.event === 'direct') ?? null,
}

// ---------- ③ 非法配置码 → direct 失败 ----------
from = msgs.length
const r3 = await fetch(`${API}/direct/update`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config_id: 'not_exist_code', value: '1', d_no: D_NO }),
})
const body3 = await r3.json()
await sleep(300)
result.fail = {
  status: r3.status,
  body: body3,
  event: msgs.slice(from).find((m) => m.event === 'direct') ?? null,
}

// ---------- ④ 堵塞保护自动下发 → source: auto ----------
from = msgs.length
await publish({ pressure: 0 })
for (let i = 0; i < 40 && (await blockedValue()) !== '1'; i++) await sleep(100)
await sleep(500)
result.auto = {
  blocked: await blockedValue(),
  events: msgs
    .slice(from)
    .filter((m) => m.event === 'direct' && m.data?.config_id !== 'lock')
    .map((m) => m.data),
  lockEvents: msgs
    .slice(from)
    .filter((m) => m.event === 'lock')
    .map((m) => m.data),
  alarms: msgs
    .slice(from)
    .filter((m) => m.event === 'alarm')
    .map((m) => m.data?.code),
}

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()
fs.writeFileSync('tmp/ws_push_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const fail = (msg) => {
  throw new Error(msg)
}
if (!result.data) fail('① 未收到 data 推送')
const d = result.data.data
if (d.d_no !== D_NO) fail(`① data.d_no 应 ${D_NO}，实际 ${d.d_no}`)
for (const key of [
  'timestamp',
  'wen_du1',
  'wen_du2',
  'jia_re',
  'shui_beng',
  'liu_liang1',
  'liu_liang2',
  'pressure',
  'heat_rate',
  'avg_flow',
])
  if (d[key] === undefined) fail(`① data 缺少字段 ${key}`)

if (result.manual.status !== 200) fail(`② 手动改指令应 200，实际 ${result.manual.status}`)
const m2 = result.manual.event?.data
if (!m2) fail('② 未收到 direct 事件')
if (m2.config_id !== 'heat' || m2.value !== '0' || m2.success !== true || m2.source !== 'manual')
  fail(`② direct 事件不符: ${JSON.stringify(m2)}`)

if (result.fail.status !== 400) fail(`③ 非法配置码应 400，实际 ${result.fail.status}`)
const m3 = result.fail.event?.data
if (!m3 || m3.success !== false || !m3.error)
  fail(`③ 失败应推 success:false + error: ${JSON.stringify(m3)}`)

if (result.auto.blocked !== '1') fail('④ 未触发堵塞保护')
if (!result.auto.lockEvents.some((e) => e.locked === true && e.active?.includes('blocked')))
  fail(`④ 未收到 lock 事件: ${JSON.stringify(result.auto.lockEvents)}`)
const autoEvents = result.auto.events
if (autoEvents.length !== 2) fail(`④ 自动控制应推 2 条 direct，实际 ${autoEvents.length}`)
if (!autoEvents.every((e) => e.source === 'auto' && e.success === true && e.value === '0'))
  fail(`④ 自动下发事件不符: ${JSON.stringify(autoEvents)}`)
if (!result.auto.alarms.includes('pressure_zero')) fail('④ 未收到堵塞告警')

console.log('E2E_WS_PUSH_OK')
ws.close()
mq.end()
process.exit(0)
