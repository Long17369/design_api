import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 设备离线告警端到端（真实 MQTT + WS，5s 定时扫描）：
 *  ① 超过 sensor_offline_seconds 未上报 → 写 error_msg(category='offline') + WS 告警
 *  ② 继续离线 → 不重复告警（按扫描周期去重）
 *  ③ 恢复上报 → 推送 type='reset' 的恢复事件（前端清除横幅）
 *  ④ 恢复后再次离线 → 可再次告警
 * 阈值走设备级覆盖（sensor_offline_seconds=5）。
 */
const D_NO = 'E2E_OFF'
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
const offlineRows = async () =>
  Number(
    (
      await q(
        "SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field2 = 'sensor_offline' AND field3 = 'offline'",
        [D_NO],
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
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '0', D_NO, 'heat', '0', D_NO, 'water', '0', D_NO],
)

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

const pub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => pub.on('connect', resolve))
const publish = () =>
  new Promise((resolve) => {
    pub.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: nowStr(),
        temp_in: 20,
        temp_out: 25,
        heat_Y1: 0,
        water_Y2: 0,
        flow_rate: 0,
        pressure: 5,
      }),
      resolve,
    )
  })

/** 等某个条件在超时内成立 */
const waitFor = async (fn, timeout = 20_000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await sleep(500)
  }
  return false
}

const result = {}

// 先写入设备级离线阈值，再上报一帧（该帧会把阈值快照进离线监控）
const setCfg = () =>
  fetch(`${API}/direct/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id: 'sensor_offline_seconds', value: '5', d_no: D_NO }),
  }).then((r) => r.status)
result.setCfg = await setCfg()
await publish()

// ---------- ① 超时未上报 → 离线告警 ----------
const from1 = events.length
const fired = await waitFor(async () => (await offlineRows()) === 1, 25_000)
result.phase1 = {
  fired,
  rows: await offlineRows(),
  event: events.slice(from1).find((e) => e.data?.code === 'sensor_offline') ?? null,
}

// ---------- ② 继续离线 → 不重复告警 ----------
await sleep(7000)
result.phase2 = { rows: await offlineRows() }

// ---------- ③ 恢复上报 → type='reset' ----------
const from3 = events.length
await publish()
await sleep(1500)
result.phase3 = {
  event: events.slice(from3).find((e) => e.data?.code === 'sensor_online') ?? null,
}

// ---------- ④ 再次离线 → 可再次告警 ----------
const twice = await waitFor(async () => (await offlineRows()) === 2, 25_000)
result.phase4 = { rows: await offlineRows(), twice }

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
pub.end(true)
ws.close()
await db.end()
fs.writeFileSync('tmp/sensor_offline_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check('① 超时未上报 → 离线告警入库（category=offline）', result.phase1.rows === 1)
check(
  '① WS 收到 sensor_offline 告警（warning）',
  result.phase1.event?.data?.code === 'sensor_offline' &&
    result.phase1.event?.data?.level === 'warning',
)
check('② 持续离线不重复告警', result.phase2.rows === 1)
check('③ 恢复上报 → 推送 type=reset 事件', result.phase3.event?.data?.type === 'reset')
check('④ 再次离线 → 可再次告警', result.phase4.rows === 2)

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
console.log('E2E_SENSOR_OFFLINE_OK')
process.exit(0)
