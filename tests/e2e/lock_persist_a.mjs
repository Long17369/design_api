import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 锁持久化验证 · 阶段 A（触发堵塞锁定）：
 *  ① WS 收到新事件 lock（locked:true / active:['blocked'] / reason）
 *  ② WS 收到兼容事件 direct（config_id='lock' value='1'）
 *  ③ device_locks 表落库（含 deny / snapshot）
 * 运行前需先启动服务；阶段 B 在重启服务后运行（验证重启恢复）。
 */
const D_NO = 'E2E_LOCK'
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

await fetch(`${API}/control/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ d_no: D_NO }),
}).catch(() => undefined)
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '1', D_NO, 'heat', '1', D_NO, 'water', '1', D_NO],
)
await q('DELETE FROM device_locks WHERE d_no = ?', [D_NO])

const events = []
const ws = new WebSocket('ws://127.0.0.1:10452/ws')
ws.on('message', (buf) => {
  try {
    events.push(JSON.parse(buf.toString()))
  } catch {
    /* 忽略非 JSON */
  }
})
await new Promise((resolve) => ws.on('open', resolve))
await sleep(300)

const pub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => pub.on('connect', resolve))
await new Promise((resolve) =>
  pub.publish(
    'data/',
    JSON.stringify({
      id: D_NO,
      time: nowStr(),
      temp_in: 20,
      temp_out: 20,
      heat_Y1: 1,
      water_Y2: 0,
      flow_rate: 5,
      pressure: 0,
    }),
    resolve,
  ),
)
await sleep(2000)

const lockEvents = events.filter((e) => e.event === 'lock')
const directEvents = events.filter((e) => e.event === 'direct')
const lock = lockEvents.at(-1)
// 兼容事件可能被后续控制类 direct 通知覆盖，故按 config_id 过滤查找
const legacy = [...directEvents].reverse().find((e) => e.data?.config_id === 'lock')
const rows = await q('SELECT * FROM device_locks WHERE d_no = ?', [D_NO])

const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check(
  '① WS 收到 lock 事件（locked=true / blocked）',
  lock?.data?.locked === true && lock?.data?.active?.includes('blocked'),
)
check(
  '② WS 收到兼容 direct 事件（config_id=lock value=1）',
  legacy?.data?.config_id === 'lock' && legacy?.data?.value === '1',
)
check(
  '③ device_locks 落库（含 deny/snapshot）',
  rows.length === 1 && rows[0].deny === '{"water":true}' && !!rows[0].snapshot,
)
check(
  '④ 响应 reason 为告警码',
  typeof lock?.data?.type === 'string' && lock.data.type === 'blocked',
)

console.log('\nlock 事件:', JSON.stringify(lock))
console.log('兼容 direct 事件:', JSON.stringify(legacy))
console.log('device_locks 行:', JSON.stringify(rows[0] ?? null))

ws.close()
pub.end(true)
await db.end()
fs.writeFileSync('tmp/lock_persist_a_result.json', JSON.stringify({ lock, legacy, rows }, null, 2))
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
console.log('LOCK_PERSIST_A_OK')
process.exit(0)
