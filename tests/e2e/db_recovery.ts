import net from 'node:net'
import { Config } from '@core/config'
import { Database } from '@core/database'

/**
 * 数据库连接断开自愈验证（真实 MySQL + 本地 TCP 代理，进程内构造 `Database`，不需要起服务）
 * 运行：`pnpm exec tsx tests/e2e/db_recovery.ts`（仓库根目录）
 *
 * 手法：把 `Database` 指到本脚本起的 TCP 代理上（转发到真实库）；需要时把代理的已连
 * socket 掐断 ⇒ 客户端看到的就是**网络中断**（`ECONNRESET` 一类）。断开发生在
 * 「查询已发出、结果未回来」之间，因此能真实走到重试分支。
 *
 * 覆盖：
 *  ① 读操作：连接中断 → **重试一次**成功（且确实是**新连接**）
 *  ② 写操作：连接中断 → **不重试**（避免重复写入），错误上抛
 *  ③ `checkHealth()`：探活失败 → 自动重连 → 恢复可用
 *  ④ `close()` 后查询**快速失败**（不会卡在等待初始化）
 */
const config = new Config('@root/config.json')
const base = config.database

const checks: Array<{ name: string; ok: boolean }> = []
const check = (name: string, cond: boolean) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}

// ----------------------- 代理：可掐断连接的转发 -----------------------
let proxyConnections = 0
let breakNext = false

const proxy = net.createServer((client) => {
  proxyConnections++
  const upstream = net.connect(base.port, base.host)
  const kill = () => {
    client.destroy()
    upstream.destroy()
  }
  client.pipe(upstream)
  upstream.pipe(client)
  client.on('data', () => {
    // 查询包已转发给服务端，此时掐断 ⇒ 客户端等不到结果（连接类错误）
    if (!breakNext) return
    breakNext = false
    kill()
  })
  client.on('error', () => undefined)
  upstream.on('error', () => undefined)
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
})
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const proxyPort = (proxy.address() as net.AddressInfo).port
console.log(`代理已启动：127.0.0.1:${proxyPort} → ${base.host}:${base.port}`)

const db = new Database()
await db.setConfig({ ...base, port: proxyPort, connection_limit: 1 })
check('准备：经代理连上数据库', (await db.count('sensor_data_mapper')).count === 10)

// ---------- ① 读：中断 → 重试一次（新连接） ----------
const beforeRead = proxyConnections
breakNext = true
const rows = await db.executeQuery<{ id: number }>({ table: 'sensor_data_mapper', limit: '3' })
check('① 连接中断后读操作仍成功（重试一次）', rows.length === 3)
check(
  `① 重试用的是新连接（代理连接数 ${beforeRead} → ${proxyConnections}）`,
  proxyConnections > beforeRead,
)

// ---------- ② 写：不重试 ----------
const beforeWrite = proxyConnections
breakNext = true
let writeFailed = false
try {
  await db.update(
    'sensor_data_mapper',
    { api_name: 'x' },
    { api_name: { operator: '=', value: '__db_recovery_none__' } },
  )
} catch (err) {
  const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
  writeFailed = true
  console.log(`   写操作按预期失败：${message}`)
}
check('② 连接中断后写操作不重试（错误上抛）', writeFailed)
check(`② 写操作没有另开连接（仍为 ${proxyConnections}）`, proxyConnections === beforeWrite)

// ---------- ③ 巡检：探活失败 → 自动重连 ----------
breakNext = true
const healthy = await db.checkHealth()
check('③ 连接中断后 checkHealth() 自动重连并恢复（true）', healthy)
check('③ 巡检后查询正常', (await db.count('sensor_data_mapper')).count === 10)

// ---------- ④ 关闭后快速失败 ----------
await db.close()
const startedAt = Date.now()
let closedFailed = false
try {
  await db.count('sensor_data_mapper')
} catch {
  closedFailed = true
}
const elapsed = Date.now() - startedAt
check(`④ close() 后查询快速失败（${elapsed}ms）`, closedFailed && elapsed < 1000)

proxy.close()

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
console.log('DB_RECOVERY_OK')
process.exit(0)
