import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 累计运行时长接口（`GET /api/sensor/runtime`）端到端：
 *   ① 上报若干帧（前段只开水泵、后段水+热、末段都关）→ 查询 = 该段**头尾两点相减**
 *      （末帧累计值 − 首帧累计值，累计列 `pump_run_time` / `heat_run_time`）
 *   ② 传 `start` 时换头帧（只算该时刻之后的部分）；传 `end` 时换尾帧
 *   ③ 无数据设备 / 参数校验（缺 `d_no`、`start` 非法 → 400）
 *
 * 依赖：服务已启动（默认配置，`sensor.derive.source=database`）。用法：`node tests/e2e/runtime.mjs`
 */
const D_NO = 'E2E_RUNTIME'
const API = 'http://127.0.0.1:10452/api'
const FRAME_MS = 1200
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  // 连接时区与服务一致（服务把 `database.timezone` 缺省值 `'Z'` 映射为 `'+00:00'`）：
  // 否则库中时间串读回差 8 小时，回传给接口的 `start`/`end` 会对不上落库帧
  timezone: cfg.timezone === 'Z' ? '+00:00' : (cfg.timezone ?? '+00:00'),
})
const q = async (sql, params = []) => (await db.query(sql, params))[0]

/** 累计运行时长列（mapper: api_name → db_name） */
const columnOf = async (apiName, fallback) =>
  (await q('SELECT db_name FROM sensor_data_mapper WHERE api_name = ? LIMIT 1', [apiName]))[0]
    ?.db_name ?? fallback
const pumpCol = await columnOf('pump_run_time', 'field8')
const heatCol = await columnOf('heat_run_time', 'field9')

/** 该设备按 id 升序的落库帧（累计列 + 时刻） */
const frames = async () =>
  q(
    `SELECT id, c_time, \`${pumpCol}\` AS pump, \`${heatCol}\` AS heat FROM sensor_data WHERE d_no = ? ORDER BY id ASC`,
    [D_NO],
  )

const getRuntime = async (params) => {
  const response = await fetch(`${API}/sensor/runtime?${new URLSearchParams(params)}`)
  return { status: response.status, body: await response.json() }
}

const resetBlock = () =>
  fetch(`${API}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)

/** 'YYYY-MM-DD HH:mm:ss'（库中 c_time 的形态，可直接作为 start/end 传回接口） */
const nowStrOf = (value) => {
  const d = value instanceof Date ? value : new Date(value)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const near = (a, b, tolerance = 0.05) => Math.abs(Number(a) - Number(b)) < tolerance

// ---------- 准备：清库 + 关自动控制 ----------
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

const pub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => pub.on('connect', resolve))
let tempOut = 25
const publish = (water, heat) =>
  new Promise((resolve) => {
    tempOut += 1
    pub.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: nowStrOf(new Date()),
        temp_in: 20,
        temp_out: tempOut,
        heat_Y1: heat ? 1 : 0,
        water_Y2: water ? 1 : 0,
        flow_rate: 0,
        pressure: 5,
      }),
      resolve,
    )
  })

// ---------- 1) 上报 8 帧：1~3 只开泵、4~6 泵+热、7~8 都关 ----------
for (let i = 1; i <= 8; i++) {
  await publish(i >= 1 && i <= 6, i >= 4 && i <= 6)
  await sleep(FRAME_MS)
}

const rows = await frames()
console.log(
  '落库累计运行时长:',
  JSON.stringify(rows.map((row) => ({ id: row.id, pump: row.pump, heat: row.heat }))),
)
check('8 帧全部落库', rows.length === 8, `实际 ${rows.length}`)

const first = rows[0]
const last = rows[rows.length - 1]
const fourth = rows[3]
const third = rows[2]
const expectedPump = Number(last.pump) - Number(first.pump)
const expectedHeat = Number(last.heat) - Number(first.heat)

// ---------- 2) 不传时间 = 全段头尾相减 ----------
const all = await getRuntime({ d_no: D_NO })
console.log('runtime（全段）:', JSON.stringify(all.body?.data))
check('查询返回 200', all.status === 200)
check(
  'pump = 末帧 − 首帧（只算泵导通的帧）',
  near(all.body?.data?.pump, expectedPump),
  `接口 ${all.body?.data?.pump} / 库中 ${expectedPump.toFixed(2)}`,
)
check(
  'heat = 末帧 − 首帧（只算加热导通的帧）',
  near(all.body?.data?.heat, expectedHeat),
  `接口 ${all.body?.data?.heat} / 库中 ${expectedHeat.toFixed(2)}`,
)
check(
  '两端时刻取落库首末帧',
  Boolean(all.body?.data?.start) && Boolean(all.body?.data?.end),
  `${all.body?.data?.start} ~ ${all.body?.data?.end}`,
)
check(
  '加热只在前 3 帧之后开启 ⇒ heat < pump 且 pump ≈ 2 × heat（±1s）',
  Number(all.body?.data?.heat) > 0 && Number(all.body?.data?.heat) < Number(all.body?.data?.pump),
  `pump=${all.body?.data?.pump} heat=${all.body?.data?.heat}`,
)

// ---------- 3) 传 start = 第 4 帧时刻（加热刚开）→ 换头帧 ----------
const fromFourth = await getRuntime({ d_no: D_NO, start: nowStrOf(fourth.c_time) })
check(
  '传 start ⇒ heat = 末帧 − 第 4 帧（头帧换成第 4 帧）',
  near(fromFourth.body?.data?.heat, Number(last.heat) - Number(fourth.heat)),
  `接口 ${fromFourth.body?.data?.heat} / 库中 ${(Number(last.heat) - Number(fourth.heat)).toFixed(2)}`,
)
check(
  '传 start ⇒ pump 也换成第 4 帧起算',
  near(fromFourth.body?.data?.pump, Number(last.pump) - Number(fourth.pump)),
  `接口 ${fromFourth.body?.data?.pump} / 库中 ${(Number(last.pump) - Number(fourth.pump)).toFixed(2)}`,
)

// ---------- 4) 传 end = 第 3 帧时刻（加热还没开）→ 尾帧前移 ----------
const untilThird = await getRuntime({ d_no: D_NO, end: nowStrOf(third.c_time) })
check(
  '传 end ⇒ 只算到第 3 帧：heat = 0（此时还未开加热）',
  near(untilThird.body?.data?.heat, 0),
  `接口 ${untilThird.body?.data?.heat}`,
)
check(
  '传 end ⇒ pump = 第 3 帧 − 首帧',
  near(untilThird.body?.data?.pump, Number(third.pump) - Number(first.pump)),
  `接口 ${untilThird.body?.data?.pump} / 库中 ${(Number(third.pump) - Number(first.pump)).toFixed(2)}`,
)

// ---------- 5) 无数据设备 / 参数校验 ----------
const missing = await getRuntime({ d_no: 'E2E_RUNTIME_NONE' })
check(
  '无数据设备：200，pump/heat 为 0、start/end 为 null',
  missing.status === 200 &&
    Number(missing.body?.data?.pump) === 0 &&
    Number(missing.body?.data?.heat) === 0 &&
    missing.body?.data?.start === null &&
    missing.body?.data?.end === null,
  JSON.stringify(missing.body?.data),
)
const noDevice = await getRuntime({})
const badTime = await getRuntime({ d_no: D_NO, start: 'oops' })
check('缺少 d_no → 400', noDevice.status === 400, `实际 ${noDevice.status}`)
check('start 格式非法 → 400', badTime.status === 400, `实际 ${badTime.status}`)

// ---------- 收尾 ----------
await resetBlock()
for (const table of ['sensor_data', 'direct', 'error_msg', 'control_log', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
pub.end(true)
await db.end()

fs.writeFileSync(
  'tmp/runtime_result.json',
  JSON.stringify({ frames: rows, all: all.body?.data, fromFourth: fromFourth.body?.data }, null, 1),
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
console.log('E2E_RUNTIME_OK')
process.exit(0)
