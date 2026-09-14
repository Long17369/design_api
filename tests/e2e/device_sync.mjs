import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 设备状态同步端到端（source='device'）：
 *  ① 指令 heat=0/water=0，设备持续上报 heat_Y1=1/water_Y2=1 ≥ N 帧 → 以设备为准回写指令
 *     （direct 值变 1、control_log 记 device、WS 推 direct(source=device) + device_sync 告警）
 *  ② 同步后指令与上报一致 → 不再重复同步
 *  ③ 指令变化（设备上报滞后）→ 重新计数，N 帧内不同步
 * 配置走设备级覆盖（device_sync_frames=3），全局默认 0（关闭）。
 */
const D_NO = 'E2E_SYNC'
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
const syncLogs = async () =>
  Number(
    (
      await q("SELECT COUNT(*) AS c FROM control_log WHERE d_no = ? AND field1 = 'device'", [D_NO])
    )[0].c,
  )

const reset = () =>
  fetch(`${API}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)
const update = (config_id, value) =>
  fetch(`${API}/direct/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id, value, d_no: D_NO }),
  }).then((r) => r.status)

await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES ' +
    '(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '1', D_NO, 'heat', '0', D_NO, 'water', '0', D_NO, 'device_sync_frames', '3', D_NO],
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
        temp_in: 20,
        temp_out: 25,
        heat_Y1: '1',
        water_Y2: '1',
        flow_rate: 5,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

const result = {}

// 基准帧（水泵刚启动会进宽限期；本用例只验证状态同步，与宽限期无关）
await publish()

// ---------- ① 连续 3 帧不一致 → 同步 ----------
const from1 = events.length
for (let i = 0; i < 3; i++) {
  await publish()
  await sleep(1000)
}
await sleep(1200)
result.phase1 = {
  heat: await value('heat'),
  water: await value('water'),
  logs: await syncLogs(),
  directEvent:
    events
      .slice(from1)
      .filter((e) => e.event === 'direct' && e.data?.source === 'device')
      .at(-1) ?? null,
  alarm: events.slice(from1).find((e) => e.data?.code === 'device_sync') ?? null,
}

// ---------- ② 已一致 → 不再重复同步 ----------
for (let i = 0; i < 3; i++) {
  await publish()
  await sleep(800)
}
result.phase2 = { logs: await syncLogs() }

// ---------- ③ 指令变化 → 重新计数（3 帧内不同步） ----------
await update('heat', '0')
await update('water', '0')
const before3 = await syncLogs()
for (let i = 0; i < 2; i++) {
  await publish()
  await sleep(900)
}
result.phase3 = { logsBefore: before3, logsAfter: await syncLogs() }

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
pub.end(true)
ws.close()
await db.end()
fs.writeFileSync('tmp/device_sync_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check(
  '① 连续 3 帧不一致 → 以设备为准回写 heat/water=1',
  result.phase1.heat === '1' && result.phase1.water === '1' && result.phase1.logs === 2,
)
check(
  '① WS 推 direct(source=device) 且告警 device_sync',
  result.phase1.directEvent?.data?.source === 'device' &&
    result.phase1.alarm?.data?.code === 'device_sync',
)
check('② 已一致 → 不再重复同步', result.phase2.logs === 2)
check('③ 指令变化 → 3 帧内不同步（计数重置）', result.phase3.logsAfter === result.phase3.logsBefore)

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
console.log('E2E_DEVICE_SYNC_OK')
process.exit(0)
