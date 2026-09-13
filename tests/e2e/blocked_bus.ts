import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { bus } from '@core/bus'
import { Config } from '@core/config'
import { Database } from '@core/database'
import { lockManager } from '@core/locks'
import { AutoControlModule } from '@modules/autoControl'
import { DirectModule } from '@modules/directModule'
import { LockModule } from '@modules/lockModule'
import { WsData } from '@/types/types'

/**
 * 堵塞保护端到端（总线级，绕开 MQTT 入站那一段）：
 *  ① 上报 pressure=0 → pressure_zero 判定 → 加阻塞锁 + 持久化 device_locks + 关泵关加热 + 告警
 *  ② 数据恢复 → 不自动解除、不重复告警
 *  ③ 被锁时禁止开启水泵（DirectModule.setValue 抛错）
 *  ④ resetBlock → 释放锁（锁通道删除持久化记录）+ 按快照恢复 + 广播 reset 事件
 */
const D_NO = 'E2E_BUS'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const nowStr = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const config = new Config('@root/config.json')
const database = new Database()
database.setConfig(config.database)
const direct = new DirectModule()
direct.setDatabase(database)
const autoControl = new AutoControlModule()
autoControl.setDatabase(database)
autoControl.setDirectModule(direct)
const lockModule = new LockModule()
lockModule.setDatabase(database)

// 等数据库就绪
await database.executeQuery({ table: 'direct', limit: '1' })

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
// blocked 已由锁通道持久化到 device_locks（direct.blocked 已移除），此处统一映射为 '1'/'0'
const directValue = async (configId: string) => {
  if (configId === 'blocked') {
    const rows = await q('SELECT id FROM device_locks WHERE d_no = ? AND type = ? LIMIT 1', [
      D_NO,
      'blocked',
    ])
    return rows[0] ? '1' : '0'
  }
  return (
    ((
      await q('SELECT value FROM direct WHERE d_no = ? AND config_id = ? LIMIT 1', [D_NO, configId])
    )[0]?.value as string) ?? null
  )
}
const count = async (sql: string, params: unknown[] = []) =>
  Number((await q(sql, params))[0]?.c ?? 0)

// ---------- 准备 ----------
// 进程内复位：锁存在内存（本脚本自己构造的 lockManager），上轮残留需先释放
lockManager.releaseAll(D_NO)
await q('DELETE FROM direct WHERE d_no = ?', [D_NO])
await q('DELETE FROM error_msg WHERE d_no = ?', [D_NO])
await q('DELETE FROM control_log WHERE d_no = ?', [D_NO])
await q('DELETE FROM device_locks WHERE d_no = ?', [D_NO])
await q(
  'INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW()),(?,?,?,NOW()),(?,?,?,NOW())',
  ['auto', '1', D_NO, 'heat', '1', D_NO, 'water', '0', D_NO],
)

const pushes: Array<{ goal?: string; message: { event: string; data: Record<string, unknown> } }> =
  []
bus.onEvent('WS_MESSAGE_OUT', (push) => pushes.push(push as never))

const frame = (over: Partial<WsData>): WsData => ({
  d_no: D_NO,
  timestamp: nowStr(),
  wen_du1: '20',
  wen_du2: '30',
  jia_re: '1',
  shui_beng: '0',
  liu_liang1: '0.00',
  liu_liang2: '5',
  pressure: '5',
  heat_rate: '0',
  avg_flow: '5',
  ...over,
})

const waitFor = async (fn: () => Promise<boolean>, timeout = 4000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

const result: Record<string, unknown> = {}

// ---------- ① 触发堵塞 ----------
let from = pushes.length
bus.emitEvent('SENSOR_DATA', frame({ pressure: '0' }))
await waitFor(async () => (await directValue('blocked')) === '1')
await sleep(300)
result.phase1 = {
  alarms: pushes
    .slice(from)
    .map((p) => p.message)
    .filter((m) => m.event === 'alarm'),
  blocked: await directValue('blocked'),
  heat: await directValue('heat'),
  water: await directValue('water'),
  blockErrors: await count(
    "SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field3 = 'block'",
    [D_NO],
  ),
  controlLogs: await count('SELECT COUNT(*) AS c FROM control_log WHERE d_no = ?', [D_NO]),
  locked: lockManager.isLocked(D_NO),
  snapshot: lockManager.getSnapshot(D_NO),
}

// ---------- ② 数据恢复 ----------
from = pushes.length
bus.emitEvent('SENSOR_DATA', frame({ pressure: '5', liu_liang2: '5' }))
await sleep(800)
result.phase2 = {
  alarms: pushes
    .slice(from)
    .map((p) => p.message)
    .filter((m) => m.event === 'alarm'),
  blocked: await directValue('blocked'),
  blockErrors: await count(
    "SELECT COUNT(*) AS c FROM error_msg WHERE d_no = ? AND field3 = 'block'",
    [D_NO],
  ),
}

// ---------- ③ 被锁时禁止开启水泵 ----------
let error3: string | null = null
try {
  await direct.setValue({ config_id: 'water', value: '1', d_no: D_NO })
} catch (err) {
  error3 = err instanceof Error ? err.message : String(err)
}
result.phase3 = { error: error3, water: await directValue('water') }

// ---------- ④ 手动复位 ----------
from = pushes.length
await direct.resetBlock(D_NO)
await sleep(300)
result.phase4 = {
  events: pushes.slice(from).map((p) => p.message),
  blocked: await directValue('blocked'),
  heat: await directValue('heat'),
  water: await directValue('water'),
  locked: lockManager.isLocked(D_NO),
  manualLogs: await count(
    "SELECT COUNT(*) AS c FROM control_log WHERE d_no = ? AND field1 = 'manual'",
    [D_NO],
  ),
}

// ---------- 清理 ----------
await q('DELETE FROM direct WHERE d_no = ?', [D_NO])
await q('DELETE FROM error_msg WHERE d_no = ?', [D_NO])
await q('DELETE FROM control_log WHERE d_no = ?', [D_NO])
await conn.end()

fs.writeFileSync('tmp/blocked_bus_result.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const p1 = result.phase1 as Record<string, never>
const fail = (msg: string) => {
  throw new Error(msg)
}
const alarms1 = p1.alarms as unknown as Array<{ data: { code?: string } }>
if (alarms1.length !== 1) fail(`① 期望 1 条告警，实际 ${alarms1.length}`)
if (alarms1[0]?.data?.code !== 'pressure_zero') fail('① 告警码应为 pressure_zero')
if (p1.blocked !== '1') fail(`① blocked 应为 '1'，实际 ${p1.blocked}`)
if (p1.heat !== '0' || p1.water !== '0') fail('① 应关加热 + 关水泵')
if (p1.blockErrors !== 1) fail(`① error_msg 应 1 条，实际 ${p1.blockErrors}`)
if (p1.controlLogs !== 2) fail(`① control_log 应 2 条，实际 ${p1.controlLogs}`)
if (p1.locked !== true) fail('① 应已加 blocked 锁')
if (JSON.stringify(p1.snapshot) !== JSON.stringify({ heat: '1', water: '0' }))
  fail(`① 快照应为 heat=1,water=0，实际 ${JSON.stringify(p1.snapshot)}`)

const p2 = result.phase2 as Record<string, never>
if ((p2.alarms as unknown as unknown[]).length !== 0) fail('② 数据恢复不应产生新告警')
if (p2.blocked !== '1') fail('② 数据恢复不应自动解除堵塞')
if (p2.blockErrors !== 1) fail('② 不应新增堵塞记录')

const p3 = result.phase3 as Record<string, never>
if (!p3.error) fail('③ 被锁时应拒绝开启水泵')
if (!String(p3.error).includes('保护性锁定')) fail(`③ 错误信息不符: ${String(p3.error)}`)
if (p3.water !== '0') fail('③ 水泵不应被开启')

const p4 = result.phase4 as Record<string, never>
const events4 = p4.events as unknown as Array<{ event: string; data: { type?: string } }>
if (!events4.some((m) => m.data?.type === 'reset')) fail('④ 未收到 reset 广播事件')
if (p4.blocked !== '0') fail(`④ blocked 应清 0，实际 ${p4.blocked}`)
if (p4.heat !== '1') fail(`④ 应按快照恢复加热为 1，实际 ${p4.heat}`)
if (p4.water !== '0') fail(`④ 无水快照不应开启水泵，实际 ${p4.water}`)
if (p4.locked !== false) fail('④ 复位后锁应已释放')
if (p4.manualLogs !== 1) fail(`④ 复位恢复应写 1 条 manual 控制记录，实际 ${p4.manualLogs}`)

console.log('E2E_BLOCKED_BUS_OK')
process.exit(0)
