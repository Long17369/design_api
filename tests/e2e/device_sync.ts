import fs from 'node:fs'
import mqtt from 'mqtt'
import mysql from 'mysql2/promise'
import { WebSocket } from 'ws'
import { Config } from '@core/config'
import { API_BASE, WS_PATH } from '@gateways/utils'

/**
 * 设备状态同步端到端（`source='device'`，按**上报帧**对账）：
 *  ① 指令 heat=1/water=1（直接写库，避免下发「开」），设备连续上报 0/0 ⇒
 *     连续 frames 帧不一致 → 以设备为准回写 0（direct 值变 0、control_log 记 device、
 *     WS 推 direct(source=device) + device_sync 告警）
 *  ② 「指令初见帧」不回写：留一帧给设备执行新指令（避免刚下发的控制被滞后上报顶回去）
 *  ③ 已一致 → 不再重复同步；指令再变化（改库）→ 同样先让一帧再按 frames 帧判定
 *
 * 配置取 `E2E_CONFIG`（默认 `config.json`）的 `direct.device_sync`——全局开关，
 * 没有设备级覆盖；未开启（enabled=false 或 frames≤0）时直接退出。
 * 用例只把值同步成 0（下发「关」），不会启动设备。
 *
 * 用法：`pnpm exec tsx tests/e2e/device_sync.ts`
 *      `E2E_CONFIG=tmp/e2e_device_sync.config.json pnpm exec tsx tests/e2e/device_sync.ts`
 */
const CONFIG_PATH = process.env.E2E_CONFIG ?? 'config.json'
const D_NO = 'E2E_SYNC'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const nowStr = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const config = new Config(CONFIG_PATH)
const sync = config.direct.device_sync
if (!sync?.enabled || sync.frames <= 0) {
  console.log(`跳过：${CONFIG_PATH} 的 direct.device_sync 未开启（enabled=${sync?.enabled}）`)
  process.exit(2)
}
const frames = sync.frames

const cfg = config.database
const conn = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.username,
  password: cfg.password,
  database: cfg.database_name,
})
const q = async (sql: string, params: unknown[] = []) =>
  (await conn.query(sql, params))[0] as Array<Record<string, unknown>>
const value = async (configId: string) =>
  ((
    await q('SELECT value FROM direct WHERE d_no = ? AND config_id = ? LIMIT 1', [D_NO, configId])
  )[0]?.value as string) ?? null
const controlLogs = async () =>
  Number(
    (
      await q("SELECT COUNT(*) AS c FROM control_log WHERE d_no = ? AND field1 = 'device'", [D_NO])
    )[0]?.c ?? 0,
  )

const HTTP = `http://127.0.0.1:${config.port}${API_BASE}`
const reset = () =>
  fetch(`${HTTP}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)
const clean = async () => {
  for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
    await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
  }
}

// ---------- 准备 ----------
await reset()
await clean()
// 指令置 1（直连库：不经 HTTP/下发，避免真机被真的开启），设备上报 0 → 制造「指令 vs 上报」不一致
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES ' +
    '(?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '0', D_NO, 'heat', '1', D_NO, 'water', '1', D_NO],
)

const events: Array<{ event?: string; data?: Record<string, unknown> }> = []
const ws = new WebSocket(`ws://127.0.0.1:${config.port}${WS_PATH}`)
ws.on('message', (buf) => {
  try {
    events.push(JSON.parse(buf.toString()) as Record<string, unknown>)
  } catch {
    /* 忽略非 JSON */
  }
})
await new Promise((resolve) => ws.on('open', resolve))

const broker = `mqtt://${config.mqtt.mqtt_host}:${config.mqtt.mqtt_port}`
const pub = mqtt.connect(broker)
await new Promise((resolve) => pub.on('connect', resolve))
// 监听下发报文：本用例应当只出现「关」帧（…0000）
const dispatched: string[] = []
await new Promise((resolve) => pub.subscribe('control/', { qos: 0 }, resolve))
pub.on('message', (_topic, buf) => {
  try {
    dispatched.push((JSON.parse(buf.toString()) as { mb: string }).mb)
  } catch {
    /* 忽略非 JSON */
  }
})

/** 上报一帧（heat_Y1/water_Y2 = 0，即设备实际已停） */
const publish = async () => {
  await new Promise((resolve) =>
    pub.publish(
      'data/',
      JSON.stringify({
        id: D_NO,
        time: nowStr(),
        temp_in: 20,
        temp_out: 25,
        pressure: 5,
        flow_rate: 5,
        heat_Y1: 0,
        water_Y2: 0,
      }),
      resolve,
    ),
  )
  await sleep(1200)
}

const result: Record<string, unknown> = {}

// ---------- ① 初见帧不回写，累计到 frames 帧才回写 ----------
const from1 = events.length
await publish()
result.phase1FirstFrame = { heat: await value('heat'), logs: await controlLogs() }

for (let i = 0; i < frames; i++) await publish()
await sleep(1500)
result.phase1Synced = {
  heat: await value('heat'),
  water: await value('water'),
  logs: await controlLogs(),
  directEvents: events
    .slice(from1)
    .filter((e) => e.event === 'direct' && e.data?.source === 'device').length,
  alarm: events.slice(from1).find((e) => e.data?.code === 'device_sync')?.data ?? null,
}

// ---------- ② 已一致 → 不再重复同步 ----------
for (let i = 0; i < 3; i++) await publish()
await sleep(1000)
result.phase2 = { logs: await controlLogs() }

// ---------- ③ 指令再变化（改库）→ 先让一帧，再按 frames 帧判定 ----------
const before3 = await controlLogs()
await q('UPDATE direct SET value = ? WHERE d_no = ? AND config_id IN (?, ?)', [
  '1',
  D_NO,
  'heat',
  'water',
])
await publish()
result.phase3FirstFrame = { logs: await controlLogs() }
for (let i = 0; i < frames; i++) await publish()
await sleep(1500)
result.phase3Synced = { heat: await value('heat'), logs: await controlLogs(), before: before3 }

// ---------- 清理 ----------
await reset()
await clean()
pub.end(true)
ws.close()
await conn.end()
fs.writeFileSync('tmp/device_sync_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks: Array<{ name: string; ok: boolean }> = []
const check = (name: string, ok: boolean) => {
  checks.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}
const p1 = result.phase1Synced as {
  heat: string | null
  water: string | null
  logs: number
  directEvents: number
  alarm: unknown
}
const p2 = result.phase2 as { logs: number }
const p3f = result.phase3FirstFrame as { logs: number }
const p3 = result.phase3Synced as { heat: string | null; logs: number; before: number }
const first = result.phase1FirstFrame as { heat: string | null; logs: number }

check(
  `① 初见帧不回写（留一帧给设备执行）：指令仍 ${first.heat}、control_log ${first.logs} 条`,
  first.heat === '1' && first.logs === 0,
)
check(
  `① 连续 ${frames} 帧不一致 → 以设备为准回写 heat/water=0 且记 2 条 device 记录`,
  p1.heat === '0' && p1.water === '0' && p1.logs === 2,
)
check('① WS 推 direct(source=device) + device_sync 告警', p1.directEvents >= 1 && !!p1.alarm)
check('② 已一致 → 不再重复同步', p2.logs === 2)
check(
  `③ 指令再变化 → 先让一帧（仍 ${p3f.logs} 条）再按 ${frames} 帧判定（转出 ${p3.logs} 条）`,
  p3f.logs === p3.before && p3.logs === p3.before + 2 && p3.heat === '0',
)
check(
  '安全：本用例只下发了「关」帧',
  dispatched.every((mb) => !mb.endsWith('0001')),
)

console.log('\n下发报文:', dispatched.join(', ') || '(无)')
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
