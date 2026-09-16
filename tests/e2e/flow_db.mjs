import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 派生指标「库口径」（`config.json` 的 `sensor.derive.source=database`，默认即此）验证：
 *  1) 上报若干帧 → `liu_liang1` = 最新落库帧累计值 + 本帧流量 × 间隔；`heat_rate`/`avg_flow`
 *     由窗口内的落库帧算出（本帧也计入样本）
 *  2) `GET /api/sensor/flow/total`（不传时间 / 传时间）→ 按落库帧积分得到的流量总计
 *  3) `POST /api/sensor/flow/reset` → 最新落库帧的累计值被改写为 0，随后从 0 重新累加
 * 用法：起服务（默认配置）→ `node tests/e2e/flow_db.mjs`
 */
const D_NO = 'E2E_FLOW_DB'
const API = 'http://127.0.0.1:10452/api'
const FLOW_RATE = 60 // L/min ⇒ 1 L/s
const FRAME_MS = 1200 // 帧间隔：每帧累计 ≈ 60 × 1.2/60 = 1.2L
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowStr = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const checks = []
const check = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `（${extra}）` : ''}`)
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
/** 累计流量列（mapper: api_name=liu_liang1 → db_name） */
const totalCol =
  (await q("SELECT db_name FROM sensor_data_mapper WHERE api_name = 'liu_liang1' LIMIT 1"))[0]
    ?.db_name ?? 'field5'
const lastRow = async () =>
  (
    await q(
      `SELECT ${totalCol} AS total, c_time FROM sensor_data WHERE d_no = ? ORDER BY id DESC LIMIT 1`,
      [D_NO],
    )
  )[0] ?? null

const resetBlock = () =>
  fetch(`${API}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)

const postReset = async (d_no) => {
  const response = await fetch(`${API}/sensor/flow/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no }),
  })
  return { status: response.status, body: await response.json() }
}

const getTotal = async (params) => {
  const response = await fetch(`${API}/sensor/flow/total?${new URLSearchParams(params)}`)
  return { status: response.status, body: await response.json() }
}

// ---------- 准备：清库 + 关自动控制 + 接 WS 收实时帧 ----------
await resetBlock()
for (const table of ['sensor_data', 'direct', 'error_msg', 'control_log', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q('INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW())', [
  'auto',
  '0',
  D_NO,
  'water',
  '0',
  D_NO,
])

const ws = new WebSocket('ws://127.0.0.1:10452/api/ws')
let latest = null
ws.on('message', (raw) => {
  const message = JSON.parse(String(raw))
  if (message?.event === 'data' && message.data?.d_no === D_NO) latest = message.data
})
await new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
})

const pub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => pub.on('connect', resolve))
let tempOut = 25
const publish = () =>
  new Promise((resolve) => {
    tempOut += 1 // 每帧 +1°C ⇒ 加热速度 ≈ 50°C/min（1.2s 一帧）
    pub.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: nowStr(),
        temp_in: 20,
        temp_out: tempOut,
        heat_Y1: 0,
        water_Y2: 0,
        flow_rate: FLOW_RATE,
        pressure: 5,
      }),
      resolve,
    )
  })

// ---------- 1) 上报 4 帧：累计值逐帧 +1.2L，指标由落库帧算出 ----------
const totals = []
for (let i = 0; i < 4; i++) {
  await publish()
  await sleep(FRAME_MS)
  totals.push(Number(latest?.liu_liang1 ?? NaN))
}
const frames = await q(
  `SELECT ${totalCol} AS total FROM sensor_data WHERE d_no = ? ORDER BY id ASC`,
  [D_NO],
)
console.log('每帧累计流量:', JSON.stringify(totals))
console.log('落库累计流量:', JSON.stringify(frames.map((row) => Number(row.total))))
check('4 帧全部落库', frames.length === 4, `实际 ${frames.length}`)
check('第 1 帧从 0 起算', totals[0] === 0, `实际 ${totals[0]}`)
// c_time 为秒级：帧间隔算出来是 1~2s ⇒ 每帧累计 1~2L
check(
  '逐帧按「上帧落库值 + 流量 × 间隔」累加（1~2L/帧）',
  totals
    .slice(1)
    .every((value, index) => value - totals[index] > 0.9 && value - totals[index] < 2.1),
  JSON.stringify(totals),
)
check(
  '4 帧累计 ≈ 3 个间隔 × 1L/s（2.9~6.1L）',
  totals[3] > 2.9 && totals[3] < 6.1,
  `实际 ${totals[3]}`,
)
check('WS 值 = 最新落库值', await lastRow().then((row) => Number(row.total) === totals[3]))

const heatRate = Number(latest?.heat_rate)
const avgFlow = Number(latest?.avg_flow)
check('加热速度由落库帧算出（≈50°C/min）', heatRate > 30 && heatRate < 70, `实际 ${heatRate}`)
check('平均水流由落库帧算出（≈60L/min）', avgFlow > 55 && avgFlow < 65, `实际 ${avgFlow}`)

// ---------- 2) 流量总计查询：不传时间 = 全段积分 ----------
const all = await getTotal({ d_no: D_NO })
console.log('flow/total（全段）:', JSON.stringify(all.body?.data))
check('查询返回 200', all.status === 200)
check(
  '全段积分 = 实时累计值（同一口径：间隔取帧时间差）',
  Math.abs(Number(all.body?.data?.total) - totals[3]) < 0.05,
  `积分 ${all.body?.data?.total} / 实时 ${totals[3]}`,
)
check(
  'start/end 缺省取落库首末时刻',
  Boolean(all.body?.data?.start) && Boolean(all.body?.data?.end),
)

const firstAt = (
  await q(`SELECT c_time FROM sensor_data WHERE d_no = ? ORDER BY id ASC LIMIT 1`, [D_NO])
)[0].c_time
const fromFirst = await getTotal({ d_no: D_NO, start: nowStrOf(firstAt) })
check(
  '传 start（首帧时刻）时不早于全段积分',
  Number(fromFirst.body?.data?.total) > 0 &&
    Number(fromFirst.body?.data?.total) <= Number(all.body?.data?.total) + 0.01,
  `实际 ${fromFirst.body?.data?.total}`,
)

const badTime = await getTotal({ d_no: D_NO, start: 'oops' })
const noDevice = await getTotal({})
check('start 格式非法 → 400', badTime.status === 400, `实际 ${badTime.status}`)
check('缺少 d_no → 400', noDevice.status === 400, `实际 ${noDevice.status}`)

// ---------- 3) 清零：改写最新落库帧 → 随后从 0 重新累加 ----------
const cleared = await postReset(D_NO)
check(
  '清零返回 200 且含该设备',
  cleared.status === 200 && cleared.body?.data?.devices?.includes(D_NO),
)
const afterClear = await lastRow()
check('最新落库帧累计值已改写为 0', Number(afterClear?.total) === 0, `实际 ${afterClear?.total}`)

const resetAt = nowStr()
await publish()
await sleep(FRAME_MS)
const restarted = Number(latest?.liu_liang1)
check('清零后从 0 重新累加（首帧 1~2L）', restarted > 0 && restarted < 2.2, `实际 ${restarted}`)

const sinceReset = await getTotal({ d_no: D_NO, start: resetAt })
check(
  '清零后按时间段查询只算清零之后的部分',
  Number(sinceReset.body?.data?.total) < Number(all.body?.data?.total),
  `清零后 ${sinceReset.body?.data?.total} < 清零前 ${all.body?.data?.total}`,
)

const missingDevice = await postReset('E2E_FLOW_DB_NONE')
check(
  '无数据的设备：清零不报错但不出现在结果里',
  missingDevice.status === 200 && missingDevice.body?.data?.devices?.length === 0,
  JSON.stringify(missingDevice.body?.data),
)

// ---------- 4) 断点间隔封顶：一对相隔 10 分钟的合成帧，最多按 max_gap_seconds(60s) 计入 ----------
const gapStart = new Date(Date.now() - 20 * 60_000)
const gapEnd = new Date(gapStart.getTime() + 10 * 60_000)
await q(
  `INSERT INTO sensor_data (d_no, c_time, field1, field6, ${totalCol}) VALUES (?,?,?,?,?),(?,?,?,?,?)`,
  [D_NO, nowStrOf(gapStart), 25, 600, 0, D_NO, nowStrOf(gapEnd), 25, 600, 0],
)
const gapped = await getTotal({ d_no: D_NO, start: nowStrOf(gapStart), end: nowStrOf(gapEnd) })
check(
  '断点间隔按 max_gap_seconds 封顶（10 分钟只算 1 分钟 ⇒ ≈600L；不封顶会是 6000L）',
  Number(gapped.body?.data?.total) > 500 && Number(gapped.body?.data?.total) < 700,
  `实际 ${gapped.body?.data?.total}`,
)

// ---------- 收尾 ----------
await resetBlock()
for (const table of ['sensor_data', 'direct', 'error_msg', 'control_log', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
ws.close()
pub.end(true)
await db.end()

fs.writeFileSync(
  'tmp/flow_db_result.json',
  JSON.stringify({ totals, heatRate, avgFlow, all: all.body?.data, restarted }, null, 1),
)

if (checks.some((item) => !item.ok)) {
  console.log(
    'FAILED:',
    checks
      .filter((item) => !item.ok)
      .map((item) => item.name)
      .join(' | '),
  )
  process.exit(1)
}
console.log('E2E_FLOW_DB_OK')
process.exit(0)

/** 时间值（Date/字符串）→ 'YYYY-MM-DD HH:mm:ss' */
function nowStrOf(value) {
  const d = value instanceof Date ? value : new Date(String(value))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
