import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 逆温差预警端到端（真实 MQTT + WS）：
 *  ① 加热中出水 < 进水 − Δ 持续 N 秒 → 写入 error_msg 并 WS 推 alarm（不控制设备）
 *  ② 持续逆温差 → 只告警一次（幂等）
 *  ③ 恢复正常后再出现 → 可再次告警
 */
const D_NO = 'E2E_RT'
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
const alarmCount = async () =>
  Number(
    (
      await q("SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field2 = 'reverse_temp'", [
        D_NO,
      ])
    )[0].c,
  )
const heatValue = async () =>
  (await q('SELECT value FROM direct WHERE d_no = ? AND config_id = ? LIMIT 1', [D_NO, 'heat']))[0]
    ?.value ?? null

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
    'reverse_temp_seconds',
    '3',
    D_NO,
    'flow_unchanged_seconds',
    '600',
    D_NO,
  ],
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
const publish = (over = {}) =>
  new Promise((resolve) => {
    pub.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: nowStr(),
        temp_in: 30,
        temp_out: 32,
        heat_Y1: 1,
        water_Y2: 1,
        flow_rate: 5,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

const NORMAL = { temp_in: '30', temp_out: '32' }
const REVERSE = { temp_in: '30', temp_out: '20' }
const result = {}

// 基准帧 + 等过水泵启动宽限期
await publish(NORMAL)
await sleep(11_000)

// ---------- ① 持续逆温差 ≥3s → 告警 ----------
const from1 = events.length
for (let i = 0; i < 5; i++) {
  await publish(REVERSE)
  await sleep(1000)
}
result.phase1 = {
  alarms: await alarmCount(),
  heat: await heatValue(),
  alarmEvent:
    events.slice(from1).find((e) => e.event === 'alarm' && e.data?.code === 'reverse_temp') ?? null,
}

// ---------- ② 持续逆温差 → 幂等 ----------
for (let i = 0; i < 3; i++) {
  await publish(REVERSE)
  await sleep(1000)
}
result.phase2 = { alarms: await alarmCount() }

// ---------- ③ 恢复后再出现 → 可再次告警 ----------
for (let i = 0; i < 2; i++) {
  await publish(NORMAL)
  await sleep(800)
}
for (let i = 0; i < 5; i++) {
  await publish(REVERSE)
  await sleep(1000)
}
result.phase3 = { alarms: await alarmCount() }

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
pub.end(true)
ws.close()
await db.end()
fs.writeFileSync('tmp/reverse_temp_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check(
  '① 逆温差持续 → 告警写入 error_msg 且 WS 推送',
  result.phase1.alarms === 1 && result.phase1.alarmEvent?.data?.code === 'reverse_temp',
)
check('① 预警不控制设备（加热保持开启）', result.phase1.heat === '1')
check('② 持续期间只告警一次', result.phase2.alarms === 1)
check('③ 恢复后可再次告警', result.phase3.alarms === 2)

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
console.log('E2E_REVERSE_TEMP_OK')
process.exit(0)
