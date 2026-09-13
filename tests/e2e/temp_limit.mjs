import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'

/**
 * 恒温保护端到端（真实 MQTT 上报）：
 *  ① temp_out 超上限 → 关加热（下发 070000）
 *  ② temp_out 低于下限且水泵指令开 → 开加热（下发 070001）
 *  ③ 重复同帧（幂等）→ 不再下发
 *  ④ 低于下限但水泵指令关 → 不开加热（防干烧）
 * 说明：判定会被水泵启动宽限期（默认 10s）跳过，故先上报一帧水泵运行并等宽限期过去，
 *       不修改任何配置（避免与引擎的 60s 配置缓存相互干扰）。
 */
const D_NO = 'E2E_TEMP'
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
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '1', D_NO, 'heat', '1', D_NO, 'water', '1', D_NO],
)

const frames = []
const sub = mqtt.connect('mqtt://localhost:1883')
await new Promise((resolve) => sub.on('connect', resolve))
await new Promise((resolve) => sub.subscribe('control/', { qos: 0 }, resolve))
sub.on('message', (topic, buf) => frames.push(JSON.parse(buf.toString()).mb))

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
        temp_out: 20,
        heat_Y1: 1,
        water_Y2: 1,
        flow_rate: 5,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

const result = {}

// 基准帧：上报水泵运行，等启动宽限期（pump_start_grace 默认 10s）过去
await publish({ temp_out: 20 })
await sleep(11_000)

// ---------- ① 超上限 → 关加热 ----------
frames.length = 0
await publish({ temp_out: 40 })
await sleep(1200)
result.phase1 = { heat: await value('heat'), frames: [...frames] }

// ---------- ② 低于下限 + 水泵开 → 开加热 ----------
frames.length = 0
await publish({ temp_out: 5 })
await sleep(1200)
result.phase2 = { heat: await value('heat'), frames: [...frames] }

// ---------- ③ 重复同帧 → 幂等 ----------
frames.length = 0
await publish({ temp_out: 5 })
await sleep(1200)
result.phase3 = { heat: await value('heat'), frames: [...frames] }

// ---------- ④ 低于下限 + 水泵指令关 → 不开加热 ----------
await fetch('http://127.0.0.1:10452/api/direct/update', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config_id: 'water', value: '0', d_no: D_NO }),
})
await fetch('http://127.0.0.1:10452/api/direct/update', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config_id: 'heat', value: '0', d_no: D_NO }),
})
await sleep(400)
frames.length = 0
await publish({ temp_out: 5, water_Y2: 0 })
await sleep(1200)
result.phase4 = { heat: await value('heat'), frames: [...frames] }

// ---------- 清理 ----------
await reset()

for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()
fs.writeFileSync('tmp/temp_limit_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

const fail = (msg) => {
  throw new Error(msg)
}
if (result.phase1.heat !== '0') fail(`① 超上限应关加热，实际 heat=${result.phase1.heat}`)
if (result.phase1.frames.length !== 1 || result.phase1.frames[0] !== '010600070000')
  fail(`① 应下发关加热帧，实际 ${JSON.stringify(result.phase1.frames)}`)
if (result.phase2.heat !== '1')
  fail(`② 低于下限（水泵开）应开加热，实际 heat=${result.phase2.heat}`)
if (result.phase2.frames.length !== 1 || result.phase2.frames[0] !== '010600070001')
  fail(`② 应下发开加热帧，实际 ${JSON.stringify(result.phase2.frames)}`)
if (result.phase3.frames.length !== 0)
  fail(`③ 重复帧不应再下发，实际 ${JSON.stringify(result.phase3.frames)}`)
if (result.phase4.heat !== '0') fail(`④ 水泵指令关闭时不应开加热，实际 heat=${result.phase4.heat}`)
if (result.phase4.frames.length !== 0)
  fail(`④ 不应下发任何帧，实际 ${JSON.stringify(result.phase4.frames)}`)

console.log('E2E_TEMP_LIMIT_OK')
sub.end()
pub.end()
process.exit(0)
