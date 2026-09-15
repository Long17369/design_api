import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Database, DatabaseConfig } from '@core/database'
import { buildTableInfoMap } from '@core/database/utils'
import sensor_data_mapper from '@core/database/tables/sensor_data_mapper'
import { bus } from '@core/bus'

/**
 * Database 连接断开自愈策略（用桩池，不需要真实库）：
 * - 读操作（`count`/`executeQuery`/…）：连接类错误**重试一次**（坏连接已被池剔除）
 * - 写操作（`insert`/`update`/`delete`）：**不重试**（避免重复写入），错误上抛
 * - `checkHealth()`：探活失败触发重连、跳过时机（初始化中/重连中/已关闭）
 */
/** 连接类错误的替身（mysql2 在连接断开时给出的错误码） */
const lostError = (code = 'PROTOCOL_CONNECTION_LOST') =>
  Object.assign(new Error('Connection lost: The server closed the connection.'), { code })

/** SQL 语法错误（**不该**被当成连接断开） */
const syntaxError = () =>
  Object.assign(new Error('You have an error in your SQL syntax'), { code: 'ER_PARSE_ERROR' })

/** 假配置（不会真连库：用例只走桩池；触发重连的用例会把 config 置空避开建连） */
const fakeConfig = {
  host: '127.0.0.1',
  port: 1,
  username: 'u',
  password: '',
  database_name: 'd',
  timezone: 'Z',
} as DatabaseConfig

interface StubPool {
  query: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

/** 用桩池接管实例内部状态（绕过真实建连，直接测重试策略） */
const mount = (database: Database, pool: StubPool) => {
  const inner = database as unknown as {
    config: DatabaseConfig
    pool: StubPool
    isInitialized: boolean
    tables: unknown
  }
  inner.config = fakeConfig
  inner.pool = pool
  inner.isInitialized = true
  inner.tables = buildTableInfoMap([sensor_data_mapper])
}

const stubPool = (results: unknown[]): StubPool => {
  const query = vi.fn()
  for (const result of results) {
    if (result instanceof Error) query.mockRejectedValueOnce(result)
    else query.mockResolvedValueOnce(result)
  }
  return { query, end: vi.fn().mockResolvedValue(undefined) }
}

let db: Database

beforeEach(async () => {
  // 上一用例可能残留（组件订阅 bus / 定时器），先广播 shutdown 再重建
  bus.emitEvent('shutdown', { reason: 'test' })
  db = new Database()
})

describe('连接断开：读操作重试一次', () => {
  it('count：第一次连接断开 → 重试成功（共两次查询）', async () => {
    const pool = stubPool([lostError(), [[{ count: 7 }], undefined]])
    mount(db, pool)

    await expect(db.count('sensor_data_mapper')).resolves.toEqual({ count: 7 })
    expect(pool.query).toHaveBeenCalledTimes(2)
  })

  it('executeQuery：第一次连接断开 → 重试成功', async () => {
    const pool = stubPool([lostError('ECONNRESET'), [[{ id: 1 }], undefined]])
    mount(db, pool)

    await expect(db.executeQuery({ table: 'sensor_data_mapper', limit: '1' })).resolves.toEqual([
      { id: 1 },
    ])
    expect(pool.query).toHaveBeenCalledTimes(2)
  })

  it('SQL 语法错误（非连接类）→ 不重试，直接上抛', async () => {
    const pool = stubPool([syntaxError(), [[{ count: 0 }], undefined]])
    mount(db, pool)

    await expect(db.count('sensor_data_mapper')).rejects.toThrow('SQL syntax')
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('连接一直断（两次都失败）→ 只重试一次后上抛', async () => {
    const pool = stubPool([lostError(), lostError()])
    mount(db, pool)

    await expect(db.count('sensor_data_mapper')).rejects.toThrow('Connection lost')
    expect(pool.query).toHaveBeenCalledTimes(2)
  })
})

describe('连接断开：写操作不重试', () => {
  it('update：连接断开不重试（避免重复写入），错误上抛', async () => {
    const pool = stubPool([lostError(), [{ affectedRows: 1 }, undefined]])
    mount(db, pool)

    await expect(
      db.update(
        'sensor_data_mapper',
        { api_name: 'x' },
        { api_name: { operator: '=', value: 'y' } },
      ),
    ).rejects.toThrow('Connection lost')
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('insert / delete：同样不重试', async () => {
    const insertPool = stubPool([lostError()])
    mount(db, insertPool)
    await expect(db.insert('sensor_data_mapper', { api_name: 'x' })).rejects.toThrow(
      'Connection lost',
    )
    expect(insertPool.query).toHaveBeenCalledTimes(1)

    const deletePool = stubPool([lostError()])
    mount(db, deletePool)
    await expect(
      db.delete('sensor_data_mapper', { api_name: { operator: '=', value: 'y' } }),
    ).rejects.toThrow('Connection lost')
    expect(deletePool.query).toHaveBeenCalledTimes(1)
  })
})

describe('checkHealth：探活与跳过时机', () => {
  it('探活成功 → true', async () => {
    const pool = stubPool([[{ '1': 1 }], undefined])
    mount(db, pool)

    await expect(db.checkHealth()).resolves.toBe(true)
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('探活失败（连接断开）→ false，标记不可用（配置缺失时不触发真建连）', async () => {
    const pool = stubPool([lostError(), lostError()])
    mount(db, pool)
    ;(db as unknown as { config: null }).config = null

    await expect(db.checkHealth()).resolves.toBe(false)
    expect(pool.query).toHaveBeenCalledTimes(1)
    expect((db as unknown as { healthDown: boolean }).healthDown).toBe(true)
  })

  it('已关闭 → 跳过探活，不查询', async () => {
    const pool = stubPool([[{ '1': 1 }], undefined])
    mount(db, pool)
    await db.close()

    await expect(db.checkHealth()).resolves.toBe(false)
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('未就绪（没有池）→ false，不查询', async () => {
    const pool = stubPool([])
    mount(db, pool)
    ;(db as unknown as { isInitialized: boolean }).isInitialized = false

    await expect(db.checkHealth()).resolves.toBe(false)
    expect(pool.query).not.toHaveBeenCalled()
  })
})

describe('close / 未就绪', () => {
  it('close() 后查询快速失败（不再无限等待初始化）', async () => {
    const pool = stubPool([[{ count: 1 }], undefined])
    mount(db, pool)
    await db.close()

    await expect(db.count('sensor_data_mapper')).rejects.toThrow('数据库未就绪')
  })
})
