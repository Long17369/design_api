import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 堵塞保护端到端验证：
 *  ① MQTT 上报 pressure=0 → 触发 pressure_zero → 加锁 + 持久化 blocked='1' + 告警
 *  ② 数据恢复正常 → 不自动解除、不重复告警
 *  ③ 被锁时禁止开启水泵（direct/update → 400）
 *  ④ POST /api/control/reset → 清标记 + 释放锁 + 按快照恢复 + 广播 reset 事件
 */
const API = 'http://127.0.0.1:10452/api'
const D_NO = 'E2E_BLOCK'
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
// blocked 已由锁通道持久化到 device_locks（direct.blocked 已移除），此处统一映射为 '1'/'0'
const directValue = async (configId) => {
  if (configId === 'blocked') {
    const rows = await q('SELECT id FROM device_locks WHERE d_no = ? AND type = ? LIMIT 1', [
      D_NO,
      'blocked',
    ])
    return rows[0] ? '1' : '0'
  }
  return (
    (
      await q('SELECT value FROM direct WHERE d_no = ? AND config_id = ? LIMIT 1', [D_NO, configId])
    )[0]?.value ?? null
  )
}

// ---------- 准备：设备指令值（heat=1, water=0, auto=1） ----------
/** 复位该设备（清堵塞标记 + 释放保护锁）：清除上一次运行残留在服务进程内的锁 */
const reset = () =>
  fetch('http://127.0.0.1:10452/api/control/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)
await reset()

await q('DELETE FROM direct WHERE d_no = ?', [D_NO])
await q('DELETE FROM error_msg WHERE d_no = ?', [D_NO])
await q('DELETE FROM control_log WHERE d_no = ?', [D_NO])
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '1', D_NO, 'heat', '1', D_NO, 'water', '0', D_NO],
)

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
const publishFrame = (over = {}) =>
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

const result = { phase: {} }

// ---------- ① 触发堵塞（压力归零） ----------
let from = msgs.length
await publishFrame({ pressure: 0 })
await sleep(1800)
result.phase1 = {
  alarms: msgs.slice(from).filter((m) => m.event === 'alarm'),
  blocked: await directValue('blocked'),
  heat: await directValue('heat'),
  water: await directValue('water'),
  blockErrors: Number(
    (await q("SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field3 = 'block'", [D_NO]))[0]
      .c,
  ),
  controlLogs: Number(
    (await q('SELECT COUNT(*) AS c FROM control_log WHERE d_no = ?', [D_NO]))[0].c,
  ),
  sensorRows: Number(
    (await q('SELECT COUNT(*) AS c FROM sensor_data WHERE d_no = ?', [D_NO]))[0].c,
  ),
}

// ---------- ② 数据恢复：不自动解除、不重复告警 ----------
const errBefore = result.phase1.blockErrors
from = msgs.length
await publishFrame({ pressure: 5, flow_rate: 5 })
await sleep(1800)
result.phase2 = {
  alarms: msgs.slice(from).filter((m) => m.event === 'alarm'),
  blocked: await directValue('blocked'),
  blockErrors: Number(
    (await q("SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field3 = 'block'", [D_NO]))[0]
      .c,
  ),
}

// ---------- ③ 被锁时禁止开启水泵 ----------
const res3 = await fetch(`${API}/direct/update`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config_id: 'water', value: '1', d_no: D_NO }),
})
result.phase3 = { status: res3.status, body: await res3.json(), water: await directValue('water') }

// ---------- ④ 手动复位 ----------
from = msgs.length
const res4 = await fetch(`${API}/control/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ d_no: D_NO }),
})
result.phase4 = {
  status: res4.status,
  body: await res4.json(),
}
await sleep(1000)
result.phase4.events = msgs.slice(from).filter((m) => m.event === 'alarm')
result.phase4.blocked = await directValue('blocked')
result.phase4.heat = await directValue('heat')
result.phase4.water = await directValue('water')
result.phase4.manualLogs = Number(
  (await q("SELECT COUNT(*) AS c FROM control_log WHERE d_no = ? AND field1 = 'manual'", [D_NO]))[0]
    .c,
)

fs.writeFileSync('tmp/blocked_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const fail = (msg) => {
  throw new Error(msg)
}
if (result.phase1.alarms.length !== 1) fail(`① 期望 1 条告警，实际 ${result.phase1.alarms.length}`)
if (result.phase1.alarms[0]?.data?.code !== 'pressure_zero') fail('① 告警码应为 pressure_zero')
if (result.phase1.blocked !== '1') fail(`① blocked 应为 1，实际 ${result.phase1.blocked}`)
if (result.phase1.heat !== '0' || result.phase1.water !== '0') fail('① 应关加热 + 关水泵')
if (result.phase1.blockErrors !== 1) fail(`① error_msg 应 1 条，实际 ${result.phase1.blockErrors}`)
if (result.phase1.controlLogs !== 2)
  fail(`① control_log 应 2 条，实际 ${result.phase1.controlLogs}`)
if (result.phase1.sensorRows < 1) fail('① 上报应落库 sensor_data')

if (result.phase2.alarms.length !== 0) fail('② 数据恢复不应产生新告警')
if (result.phase2.blocked !== '1') fail('② 数据恢复不应自动解除堵塞')
if (result.phase2.blockErrors !== errBefore) fail('② 不应新增堵塞记录')

if (result.phase3.status !== 400) fail(`③ 被锁应拒绝开启水泵(400)，实际 ${result.phase3.status}`)
if (result.phase3.water !== '0') fail('③ 被锁时水泵不应被开启')

if (result.phase4.status !== 200) fail(`④ 复位应 200，实际 ${result.phase4.status}`)
if (result.phase4.blocked !== '0') fail(`④ blocked 应清 0，实际 ${result.phase4.blocked}`)
if (result.phase4.heat !== '1') fail(`④ 应按快照恢复加热为 1，实际 ${result.phase4.heat}`)
if (result.phase4.water !== '0') fail(`④ 无水快照不应开启水泵，实际 ${result.phase4.water}`)
if (result.phase4.manualLogs !== 1)
  fail(`④ 复位恢复应写 1 条 manual 控制记录，实际 ${result.phase4.manualLogs}`)
if (!result.phase4.events.some((m) => m.data?.type === 'reset')) fail('④ 未收到 reset 广播事件')

console.log('E2E_BLOCKED_OK')
ws.close()
mq.end()
await db.end()
