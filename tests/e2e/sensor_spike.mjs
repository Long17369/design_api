import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import WebSocket from 'ws'

/**
 * 数据质量标记 invalid 端到端（阈值配置化 + 多帧累计防抖）：
 *  ① 正常帧 → WS data 无 invalid
 *  ② 首次跳变（未达累积帧数）→ 仍无 invalid（防抖）
 *  ③ 连续第 2 帧跳变（达到 sensor_spike_frames）→ invalid=true
 *  ④ 恢复正常变化 → invalid 清除
 * 前置：全局 direct_config.sensor_spike_enabled=1（由外部脚本设置后重启服务）。
 */
const D_NO = 'E2E_SPIKE'
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

const spikeEnabled = (
  await q("SELECT default_value FROM direct_config WHERE code = 'sensor_spike_enabled'")
)[0]?.default_value
const spikeFrames = Number(
  (await q("SELECT default_value FROM direct_config WHERE code = 'sensor_spike_frames'"))[0]
    ?.default_value ?? 0,
)
if (spikeEnabled !== '1' || spikeFrames <= 0) {
  console.error(
    '前置条件失败：请先把 direct_config.sensor_spike_enabled 设为 1（frames>0）并重启服务',
  )
  process.exit(1)
}

for (const table of ['sensor_data']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}

const datas = []
const ws = new WebSocket('ws://127.0.0.1:10452/ws')
ws.on('message', (buf) => {
  try {
    const msg = JSON.parse(buf.toString())
    if (msg.event === 'data' && msg.data?.d_no === D_NO) datas.push(msg.data)
  } catch {
    /* 忽略非 JSON */
  }
})
await new Promise((resolve) => ws.on('open', resolve))
await sleep(300)

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
        temp_out: 30,
        heat_Y1: 0,
        water_Y2: 0,
        flow_rate: 5,
        pressure: 5,
        ...over,
      }),
      resolve,
    )
  })

const last = () => datas.at(-1)

// ---------- ① 正常帧 ----------
await publish()
await sleep(600)
const phase1 = { invalid: last()?.invalid, tempOut: last()?.wen_du2 }

// ---------- ② 首次跳变（防抖，未达帧数） ----------
await publish({ temp_out: 50 }) // 跳变 20 > 阈值 10
await sleep(600)
const phase2 = { invalid: last()?.invalid }

// ---------- ③ 连续第二帧跳变 → invalid ----------
await publish({ temp_out: 70 })
await sleep(600)
const phase3 = { invalid: last()?.invalid, tempOut: last()?.wen_du2 }

// ---------- ④ 恢复正常变化 → invalid 清除 ----------
await publish({ temp_out: 71 })
await sleep(600)
const phase4 = { invalid: last()?.invalid }

for (const table of ['sensor_data']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
pub.end(true)
ws.close()
await db.end()

const result = { spikeEnabled, spikeFrames, phase1, phase2, phase3, phase4 }
fs.writeFileSync('tmp/sensor_spike_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))

const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check('① 正常帧无 invalid', !phase1.invalid)
check('② 单帧跳变被防抖（无 invalid）', !phase2.invalid)
check('③ 连续跳变达阈值 → invalid=true', phase3.invalid === true)
check('④ 恢复正常变化 → invalid 清除', !phase4.invalid)

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
console.log('E2E_SENSOR_SPIKE_OK')
process.exit(0)
