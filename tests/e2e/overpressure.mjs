import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 过压保护·冷却期端到端（真实 MQTT + HTTP + WS）：
 *  ① 超压 → 关加热关泵 + 加 overpressure 冷却锁（device_locks 落库 + WS lock 事件）
 *  ② 冷却期内 → 开泵被锁拦截（HTTP 400 保护性锁定）
 *  ③ 冷却期满但压力仍高 → 冷却期顺延（expires_at 变大，锁不解除）
 *  ④ 冷却期满且压力回落 → 解锁（记录清除 + locked:false）并按快照恢复运行（resume）
 * 配置走设备级覆盖（立即生效）。
 */
const D_NO = 'E2E_OVP'
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
const lockRow = async () =>
  (await q('SELECT * FROM device_locks WHERE d_no = ? AND type = ?', [D_NO, 'overpressure']))[0] ??
  null

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
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES ' +
    '(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
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
    'overpressure_limit',
    '5',
    D_NO,
    'overpressure_delay',
    '3',
    D_NO,
    'overpressure_auto_release',
    '1',
    D_NO,
    'overpressure_on_release',
    'resume',
    D_NO,
  ],
)

const frames = []
const sub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => sub.on('connect', resolve))
await new Promise((resolve) => sub.subscribe('control/', { qos: 0 }, resolve))
sub.on('message', (topic, buf) => frames.push(JSON.parse(buf.toString()).mb))

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
        heat_Y1: 1,
        water_Y2: 1,
        flow_rate: 5,
        pressure: 1,
        ...over,
      }),
      resolve,
    )
  })

const result = {}

// 基准帧 + 等过水泵启动宽限期
await publish({ pressure: 1 })
await sleep(11_000)

// ---------- ① 超压 → 关加热关泵 + 冷却锁 ----------
frames.length = 0
const from = events.length
await publish({ pressure: 10 })
await sleep(1500)
const row1 = await lockRow()
result.phase1 = {
  heat: await value('heat'),
  water: await value('water'),
  frames: [...frames],
  lock: row1,
  lockEvent: events.slice(from).find((e) => e.event === 'lock')?.data ?? null,
}

// ---------- ② 冷却期内开泵被拦截 ----------
result.phase2 = await update('water', '1')

// ---------- ③ 期满（压力仍高）→ 冷却期顺延 ----------
await sleep(3000)
const before = await lockRow()
await publish({ pressure: 10 })
await sleep(800)
const after = await lockRow()
result.phase3 = {
  expiresBefore: before?.expires_at ?? null,
  expiresAfter: after?.expires_at ?? null,
}

// ---------- ④ 期满且压力回落 → 解锁 + 恢复运行 ----------
await sleep(3000)
frames.length = 0
const from4 = events.length
await publish({ pressure: 1 })
await sleep(1500)
result.phase4 = {
  heat: await value('heat'),
  water: await value('water'),
  frames: [...frames],
  lock: await lockRow(),
  lockEvent: events.slice(from4).find((e) => e.event === 'lock')?.data ?? null,
}

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
sub.end(true)
pub.end(true)
ws.close()
await db.end()
fs.writeFileSync('tmp/overpressure_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check(
  '① 超压 → 关加热关泵（顺序 heat→water）',
  result.phase1.heat === '0' &&
    result.phase1.water === '0' &&
    JSON.stringify(result.phase1.frames) === JSON.stringify(['010600070000', '010600060000']),
)
check('① 冷却锁已落库（含到期时间）', !!result.phase1.lock && !!result.phase1.lock.expires_at)
check(
  '① WS 收到 lock 事件（overpressure/锁定中）',
  result.phase1.lockEvent?.locked === true && result.phase1.lockEvent?.type === 'overpressure',
)
check(
  '② 冷却期内开泵被拒（400 保护性锁定）',
  result.phase2.status === 400 && JSON.stringify(result.phase2.body).includes('保护性锁定'),
)
check(
  '③ 压力仍高 → 冷却期顺延（到期时间变大）',
  !!result.phase3.expiresBefore &&
    !!result.phase3.expiresAfter &&
    Number(result.phase3.expiresAfter) > Number(result.phase3.expiresBefore),
)
check(
  '④ 压力回落 → 解锁并按快照恢复（heat/water=1）',
  result.phase4.lock === null &&
    result.phase4.heat === '1' &&
    result.phase4.water === '1' &&
    JSON.stringify(result.phase4.frames) === JSON.stringify(['010600070001', '010600060001']),
)
check('④ WS 收到解锁事件（locked:false）', result.phase4.lockEvent?.locked === false)

console.log('\n汇总:', JSON.stringify(result, null, 2))
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
console.log('E2E_OVERPRESSURE_OK')
process.exit(0)
