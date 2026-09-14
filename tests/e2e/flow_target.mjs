import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 累计流量目标端到端（真实 MQTT 上报）：
 *  ① 累计流量跨越目标 → 关水泵（060000），且**先联动关加热**（070000 在前）
 *  ② 继续上报（累计流量继续增长）→ 不再下发（跨越标记幂等）
 * 配置走**设备级覆盖**（POST /api/direct/update，逐帧生效），不依赖全局默认值缓存，
 * 因此不要求服务刚启动。
 */
const D_NO = 'E2E_FLOWTARGET'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = (offsetSec) => {
  const d = new Date(Date.now() + offsetSec * 1000)
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

/** 通过接口改配置（设备级覆盖，立即生效） */
const update = (config_id, value) =>
  fetch('http://127.0.0.1:10452/api/direct/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id, value, d_no: D_NO }),
  }).then((r) => r.json())

/** 复位该设备（清堵塞标记 + 释放保护锁）：清除上一次运行残留在服务进程内的锁 */
const reset = () =>
  fetch('http://127.0.0.1:10452/api/control/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)
await reset()

for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
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
    'flow_target_enabled',
    '1',
    D_NO,
    'total_flow_target',
    '2',
    D_NO,
  ],
)

const frames = []
const sub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => sub.on('connect', resolve))
await new Promise((resolve) => sub.subscribe('control/', { qos: 0 }, resolve))
sub.on('message', (topic, buf) => frames.push(JSON.parse(buf.toString()).mb))

const pub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => pub.on('connect', resolve))
/** 上报一帧（水泵报运行，流量 60 L/min；先等过启动宽限期） */
const publish = (offsetSec) =>
  new Promise((resolve) => {
    pub.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: stamp(offsetSec),
        temp_in: 20,
        temp_out: 25,
        heat_Y1: 1,
        water_Y2: 1,
        flow_rate: 60,
        pressure: 5,
      }),
      resolve,
    )
  })

const result = {}

// 基准帧（建立 lastTime，不累计）+ 等过水泵启动宽限期（默认 10s）
await publish(-60)
await sleep(11_000)

// ---------- ① 跨越目标（60L ≥ 2L）→ 关泵（先联动关加热） ----------
// 前置条件：累计流量在**进程内**累加、不随删库重置 → 本用例需在服务刚启动时运行
if ((await value('water')) === '0') {
  throw new Error('前置条件失败：累计流量已达过目标，请在服务刚启动时运行本用例')
}
frames.length = 0
await publish(0)
await sleep(1500)
result.phase1 = {
  water: await value('water'),
  heat: await value('heat'),
  frames: [...frames],
  flowLogs: Number(
    (
      await q(
        "SELECT COUNT(*) AS c FROM control_log WHERE d_no = ? AND field5 LIKE '%累计流量达目标%'",
        [D_NO],
      )
    )[0].c,
  ),
  relayLogs: Number(
    (
      await q("SELECT COUNT(*) AS c FROM control_log WHERE d_no = ? AND field5 LIKE '%联动%'", [
        D_NO,
      ])
    )[0].c,
  ),
}

// ---------- ② 继续上报 → 幂等，不再下发 ----------
frames.length = 0
await publish(60)
await sleep(1500)
result.phase2 = {
  water: await value('water'),
  frames: [...frames],
  flowLogs: Number(
    (
      await q(
        "SELECT COUNT(*) AS c FROM control_log WHERE d_no = ? AND field5 LIKE '%累计流量达目标%'",
        [D_NO],
      )
    )[0].c,
  ),
}

// ---------- 清理 ----------
await reset()

for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()
fs.writeFileSync('tmp/flow_target_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

const fail = (msg) => {
  throw new Error(msg)
}
if (result.phase1.water !== '0') fail(`① 达目标应关泵，实际 water=${result.phase1.water}`)
if (JSON.stringify(result.phase1.frames) !== JSON.stringify(['010600070000', '010600060000']))
  fail(`① 应先关加热再关泵，实际 ${JSON.stringify(result.phase1.frames)}`)
if (result.phase1.heat !== '0') fail(`① 关泵应连带关加热，实际 heat=${result.phase1.heat}`)
if (result.phase1.flowLogs !== 2)
  fail(`① 控制记录应 2 条（关加热+关泵），实际 ${result.phase1.flowLogs}`)
if (result.phase1.relayLogs !== 1) fail(`① 应记录 1 条联动原因，实际 ${result.phase1.relayLogs}`)
if (result.phase2.frames.length !== 0)
  fail(`② 达成后不应再下发，实际 ${JSON.stringify(result.phase2.frames)}`)
if (result.phase2.flowLogs !== 2) fail(`② 达成后不应再写控制记录，实际 ${result.phase2.flowLogs}`)

console.log('E2E_FLOW_TARGET_OK')
sub.end()
pub.end()
process.exit(0)
