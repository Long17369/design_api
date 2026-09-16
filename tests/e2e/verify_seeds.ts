import mysql from 'mysql2/promise'
import { RowDataPacket } from 'mysql2/promise'
import { Config } from '@core/config'
import { TABLE_SEEDS } from '../../src/core/database/seeds'

/**
 * seeds 重构等价性验证：新定义（列 + 值行）必须与数据库中现有行逐列一致。
 * （库中数据由重构前的 seeds 写入，故可作为基准）
 * 运行：`pnpm exec tsx tests/e2e/verify_seeds.ts`（需在仓库根目录、依赖 dev 库）
 *
 * 配置一律经 `@core/config` 读取（勿直接解析 config.json）。
 */
const cfg = new Config('@root/config.json').database
const db = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.username,
  password: cfg.password,
  database: cfg.database_name,
})

const normalize = (value: unknown) => (value === null || value === undefined ? null : String(value))
const problems: string[] = []

for (const seed of TABLE_SEEDS) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${seed.columns.map((c) => `\`${c}\``).join(', ')} FROM \`${seed.table}\` ORDER BY \`${seed.keyColumn}\``,
  )
  const keyIndex = seed.columns.indexOf(seed.keyColumn)
  const dbRows = new Map<string, RowDataPacket>(
    rows.map((row) => [String(row[seed.keyColumn]), row]),
  )

  for (const seedRow of seed.rows) {
    const key = String(seedRow[keyIndex])
    const dbRow = dbRows.get(key)
    if (!dbRow) {
      problems.push(`${seed.table} 缺少行 ${seed.keyColumn}=${key}`)
      continue
    }
    for (let i = 0; i < seed.columns.length; i++) {
      const column = seed.columns[i]
      if (column === undefined) continue
      if (normalize(dbRow[column]) !== normalize(seedRow[i])) {
        problems.push(
          `${seed.table} [${key}].${column}: 定义=${normalize(seedRow[i])} 库中=${normalize(dbRow[column])}`,
        )
      }
    }
    dbRows.delete(key)
  }

  for (const leftover of dbRows.keys()) {
    problems.push(`${seed.table} 库中多出未定义的行 ${seed.keyColumn}=${leftover}`)
  }
  console.log(`${seed.table}: 定义 ${seed.rows.length} 行，比对完成`)
}

await db.end()

if (problems.length > 0) {
  console.error('发现不一致：')
  for (const p of problems) console.error(' -', p)
  process.exit(1)
}
console.log('SEEDS_EQUIVALENT_OK')
process.exit(0)
