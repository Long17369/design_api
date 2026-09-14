import fs from 'node:fs'
import mysql from 'mysql2/promise'

/**
 * 历史图表降采样端到端（GET /api/{source}/chart）：
 *  ① 时间桶 AVG 正确（同桶多行取平均、桶标签取桶内最大 c_time、按时间升序）
 *  ② 非数据列不出现在结果里（id/d_no/c_time 之外只返回 fieldN）
 *  ③ 参数校验：缺 start/end、格式错误、start>end、buckets<=0 → 400
 *  ④ 其它数据源（control → control_log）同样可用
 * 说明：直接构造 sensor_data/control_log 行，保证 AVG 结果可预期。
 */
const API = 'http://127.0.0.1:10452/api'
const D_NO = 'E2E_CHART'
const D_NO2 = 'E2E_CHART2'

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8')).database
const db = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.username,
  password: cfg.password,
  database: cfg.database_name,
})
const q = async (sql, params = []) => (await db.query(sql, params))[0]
const get = async (url) => {
  const res = await fetch(url)
  return { status: res.status, body: await res.json() }
}

// ---------- 准备数据 ----------
for (const table of ['sensor_data', 'control_log'])
  await q(`DELETE FROM ${table} WHERE d_no LIKE 'E2E_CHART%'`)
const rows = [
  ['00:00:00', '1', '100'],
  ['00:00:04', '2', '200'],
  ['00:00:08', '3', '300'],
  ['00:00:12', '10', '1000'],
  ['00:00:16', '20', '2000'],
  ['00:00:19', '30', '3000'],
]
for (const [time, f3, f5] of rows) {
  await q('INSERT INTO sensor_data (d_no, c_time, field3, field5) VALUES (?, ?, ?, ?)', [
    D_NO,
    `2026-09-12 ${time}`,
    f3,
    f5,
  ])
}
await q('INSERT INTO control_log (d_no, c_time, field1, field2) VALUES (?,?,?,?),(?,?,?,?)', [
  D_NO2,
  '2026-09-12 00:00:05',
  '10',
  'auto',
  D_NO2,
  '2026-09-12 00:00:15',
  '30',
  'auto',
])

const result = {}

// ---------- ① 时间桶 AVG（buckets=2 → 步长 10s） ----------
result.phase1 = await get(
  `${API}/sensor/chart?d_no=${D_NO}&start=${encodeURIComponent('2026-09-12 00:00:00')}` +
    `&end=${encodeURIComponent('2026-09-12 00:00:19')}&buckets=2`,
)

// ---------- ② 不返回非数据列 ----------
result.keys = result.phase1.body?.data?.[0] ? Object.keys(result.phase1.body.data[0]) : []

// ---------- ②.5 空格用 '+' 编码（前端 URLSearchParams 形式）同样可用 ----------
result.plusEncoding = await get(
  `${API}/sensor/chart?d_no=${D_NO}&start=2026-09-12+00%3A00%3A00&end=2026-09-12+00%3A00%3A19&buckets=2`,
)

// ---------- ③ 参数校验 ----------
const enc = encodeURIComponent
result.validation = {
  missing: (await get(`${API}/sensor/chart?d_no=${D_NO}`)).status,
  badFormat: (
    await get(
      `${API}/sensor/chart?start=${enc('2026/09/12 00:00:00')}&end=${enc('2026-09-12 00:10:00')}`,
    )
  ).status,
  reversed: (
    await get(
      `${API}/sensor/chart?start=${enc('2026-09-12 00:10:00')}&end=${enc('2026-09-12 00:00:00')}`,
    )
  ).status,
  badBuckets: (
    await get(
      `${API}/sensor/chart?start=${enc('2026-09-12 00:00:00')}&end=${enc('2026-09-12 00:10:00')}&buckets=0`,
    )
  ).status,
}

// ---------- ④ 其它数据源 ----------
result.phase4 = await get(
  `${API}/control/chart?d_no=${D_NO2}&start=${enc('2026-09-12 00:00:00')}&end=${enc('2026-09-12 00:00:19')}&buckets=1`,
)

// ---------- 清理 ----------
for (const table of ['sensor_data', 'control_log'])
  await q(`DELETE FROM ${table} WHERE d_no LIKE 'E2E_CHART%'`)
await db.end()
fs.writeFileSync('tmp/chart_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
const points = result.phase1.body?.data ?? []
check('① 返回 2 个时间桶', result.phase1.status === 200 && points.length === 2)
check(
  '① 桶 1：c_time 取桶内最大、field3=2、field5=200',
  points[0]?.c_time === '2026-09-12 00:00:08' &&
    Number(points[0]?.field3) === 2 &&
    Number(points[0]?.field5) === 200,
)
check(
  '① 桶 2：c_time=00:00:19、field3=20、field5=2000',
  points[1]?.c_time === '2026-09-12 00:00:19' &&
    Number(points[1]?.field3) === 20 &&
    Number(points[1]?.field5) === 2000,
)
check('① 结果按时间升序', points[0]?.c_time < points[1]?.c_time)
check(
  '② 只返回 c_time + fieldN（无 id/d_no）',
  result.keys.includes('c_time') &&
    result.keys.includes('field3') &&
    !result.keys.includes('id') &&
    !result.keys.includes('d_no'),
)
check(
  '② 时间参数用 + 编码（前端 URLSearchParams）同样可用',
  result.plusEncoding.status === 200 && result.plusEncoding.body?.data?.length === 2,
)
check(
  '③ 参数校验全部 400',
  Object.values(result.validation).every((status) => status === 400),
)
check(
  '④ control 源可用（2 个桶，field1 依次 10/30）',
  result.phase4.status === 200 &&
    result.phase4.body?.data?.length === 2 &&
    Number(result.phase4.body?.data?.[0]?.field1) === 10 &&
    Number(result.phase4.body?.data?.[1]?.field1) === 30,
)

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
console.log('E2E_CHART_OK')
process.exit(0)
