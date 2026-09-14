import fs from 'node:fs'
import mysql from 'mysql2/promise'

/**
 * 锁持久化验证 · 阶段 B（重启后恢复，需在阶段 A 之后、服务已重启的情况下运行）：
 *  ① 重启后 direct/update 开泵仍被拒（400 保护性锁定）→ 说明锁由 device_locks 恢复
 *  ② 手动复位后 device_locks 行被清除
 */
const D_NO = 'E2E_LOCK'
const API = 'http://127.0.0.1:10452/api'

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8')).database
const db = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.username,
  password: cfg.password,
  database: cfg.database_name,
})
const q = async (sql, params = []) => (await db.query(sql, params))[0]

const rowsBefore = await q('SELECT * FROM device_locks WHERE d_no = ?', [D_NO])
const res = await fetch(`${API}/direct/update`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config_id: 'water', value: '1', d_no: D_NO }),
})
const body = await res.json()

const resetRes = await fetch(`${API}/control/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ d_no: D_NO }),
})
const resetBody = await resetRes.json()
const rowsAfter = await q('SELECT * FROM device_locks WHERE d_no = ?', [D_NO])

const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check('① 重启后持久化锁仍在库中', rowsBefore.length === 1)
check(
  '② 重启后开泵被锁拦截（400 + 保护性锁定）',
  res.status === 400 && JSON.stringify(body).includes('保护性锁定'),
)
check('③ 手动复位成功', resetBody.success === true)
check('④ 复位后 device_locks 行被清除', rowsAfter.length === 0)

// 清理测试数据
for (const table of ['direct', 'error_msg', 'control_log', 'sensor_data', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()

console.log('\n拦截响应:', JSON.stringify({ status: res.status, body }))
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
console.log('LOCK_PERSIST_B_OK')
process.exit(0)
