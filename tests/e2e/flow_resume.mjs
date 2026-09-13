import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 累计流量持久化（重启续算）验证：
 *  阶段 A（服务运行中）：上报若干帧 → 累计流量写入 sensor_data（由 mapper 决定列名）
 *  阶段 B（重启服务后）：上报一帧 → 累计流量应从最后落库值续算，而不是归零
 * 用法：先跑 A（--phase=a）→ 重启服务 → 再跑 B（--phase=b）
 */
const D_NO = 'E2E_RESUME'
const phase = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=a').split('=')[1]
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
/** 累计流量所在列（mapper: api_name=liu_liang1 → db_name） */
const col =
  (await q("SELECT db_name FROM sensor_data_mapper WHERE api_name = 'liu_liang1' LIMIT 1"))[0]
    ?.db_name ?? 'field5'
const lastTotal = async () =>
  (
    await q(`SELECT ${col} AS total FROM sensor_data WHERE d_no = ? ORDER BY id DESC LIMIT 1`, [
      D_NO,
    ])
  )[0]?.total ?? null

const reset = () =>
  fetch('http://127.0.0.1:10452/api/control/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)

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
        heat_Y1: 0,
        water_Y2: 0,
        flow_rate: 60,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

if (phase === 'a') {
  await reset()
  for (const table of ['sensor_data']) await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
  await q(
    'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW())',
    ['auto', '0', D_NO, 'water', '0', D_NO],
  )
  // 两帧之间需有时间差才能累计
  await publish()
  await sleep(1500)
  await publish()
  await sleep(1500)
  await publish()
  await sleep(600)
  const total = await lastTotal()
  console.log(JSON.stringify({ phase: 'a', column: col, total }))
  fs.writeFileSync('tmp/e2e_flow_resume_a.json', JSON.stringify({ column: col, total }))
  pub.end(true)
  await db.end()
  process.exit(0)
}

// ---------- 阶段 B：重启后续算 ----------
const before = Number((await lastTotal()) ?? 0)
// 首帧只用于恢复基准（无前帧不累计），第二帧才继续累加
await publish()
await sleep(1500)
await publish()
await sleep(800)
const after = Number((await lastTotal()) ?? 0)

await reset()
for (const table of ['sensor_data', 'direct', 'error_msg', 'control_log', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
pub.end(true)
await db.end()

const result = { before, after }
fs.writeFileSync('tmp/e2e_flow_resume_b.json', JSON.stringify(result))
console.log(JSON.stringify(result))

const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check('重启前已累计出正数', before > 0)
check('重启后从最后落库值续算（不归零）', after >= before)
check('新帧继续累加（严格大于重启前）', after > before)

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
console.log('E2E_FLOW_RESUME_OK')
process.exit(0)
