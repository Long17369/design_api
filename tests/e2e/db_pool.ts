import { Config } from '@core/config'
import { Database } from '@core/database'

/**
 * 数据库连接池验证（真实 MySQL，进程内构造 `Database`，不需要起服务）
 * 运行：`pnpm exec tsx tests/e2e/db_pool.ts`（仓库根目录）
 *
 * 覆盖：
 *  ① 配置缺省时 `connection_limit` 取 schema 默认值（10）
 *  ② `limit=1`：初始化未完成即发起 20 个并发查询**全部成功**（等就绪 + 池满排队等待）
 *  ③ `limit=5`：20 个并发查询全部成功
 *  ④ 读写混合并发全部成功（写用不命中行的 `update`，不污染数据）
 *  ⑤ `close()` 释放连接池
 */
const config = new Config('@root/config.json')
const base = config.database

const checks: Array<{ name: string; ok: boolean }> = []
const check = (name: string, cond: boolean) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}

const read = (db: Database, limit: string) =>
  db.executeQuery<{ id: number }>({ table: 'sensor_data_mapper', limit })

check('① 配置缺省时 connection_limit = 10（schema 默认值生效）', base.connection_limit === 10)

// ---------- ② 小池 + 初始化未完成即发起 ----------
{
  const db = new Database()
  await db.setConfig({ ...base, connection_limit: 1 })
  // setConfig 不等初始化完成：紧跟的 20 个并发查询必须「等就绪 + 排队」后成功，而不是失败
  const results = await Promise.all(Array.from({ length: 20 }, () => read(db, '3')))
  check(
    '② 初始化未完成时即发起 + limit=1 共 20 并发，全部成功（等待连接建立）',
    results.every((rows) => rows.length === 3),
  )
  await db.close()
}

// ---------- ③ 中等池并发 ----------
{
  const db = new Database()
  await db.setConfig({ ...base, connection_limit: 5 })
  const results = await Promise.all(Array.from({ length: 20 }, () => read(db, '2')))
  check(
    '③ limit=5：20 并发查询全部成功',
    results.every((rows) => rows.length === 2),
  )
  await db.close()
}

// ---------- ④ 读写混合并发 + 关闭 ----------
{
  const db = new Database()
  await db.setConfig({ ...base, connection_limit: 3 })
  const ops = Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? read(db, '1')
      : db
          .update(
            'sensor_data_mapper',
            { api_name: 'x' },
            { api_name: { operator: '=', value: '__db_pool_e2e_none__' } },
          )
          .then(() => []),
  )
  const settled = await Promise.allSettled(ops)
  const failed = settled.filter((item) => item.status === 'rejected')
  check('④ 读写混合并发全部成功', failed.length === 0)
  if (failed.length > 0) console.log(failed.map((item) => (item as PromiseRejectedResult).reason))

  await db.close()
  const pool = (db as unknown as { pool: unknown }).pool
  check('⑤ close() 释放连接池', pool === null)
}

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
console.log('DB_POOL_OK')
process.exit(0)
