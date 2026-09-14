import { beforeEach, describe, expect, it } from 'vitest'
import { cache } from '@core/cache'

/**
 * 进程级缓存单测（纯内存，不依赖数据库）。
 * 写穿透失效（Database 写库后按表名 invalidate）在 tmp/ 的 E2E/集成脚本中验证。
 */
describe('@core/cache（KV + TTL + 标签失效）', () => {
  beforeEach(() => cache.clear())

  it('读写与按标签批量失效', () => {
    cache.set('k1', { a: 1 }, { tag: 't1' })
    cache.set('k2', 'v2', { tag: 't1' })
    expect(cache.get<{ a: number }>('k1')?.a).toBe(1)
    expect(cache.stats()).toEqual({ size: 2, tags: 1 })

    cache.invalidate('t1')
    expect(cache.get('k1')).toBeUndefined()
    expect(cache.get('k2')).toBeUndefined()
    expect(cache.stats()).toEqual({ size: 0, tags: 0 })
  })

  it('TTL 到期后不可读，ttl:0 永不过期', async () => {
    cache.set('k3', 'v3', { ttl: 30 })
    expect(cache.get<string>('k3')).toBe('v3')
    await new Promise((r) => setTimeout(r, 60))
    expect(cache.get('k3')).toBeUndefined()

    cache.set('k4', 'v4', { ttl: 0 })
    expect(cache.get('k4')).toBe('v4')
  })

  it('del 删除单个 key；重复写入会覆盖旧标签', () => {
    cache.set('k5', 'v5', { tag: 'a' })
    cache.set('k5', 'v6', { tag: 'b' })
    cache.invalidate('a')
    expect(cache.get('k5')).toBe('v6') // 旧标签失效不影响新值
    cache.invalidate('b')
    expect(cache.get('k5')).toBeUndefined()

    cache.set('k6', 'v6')
    cache.del('k6')
    expect(cache.get('k6')).toBeUndefined()
  })

  it('remember 只加载一次', async () => {
    let loads = 0
    const loader = async () => {
      loads += 1
      return 'loaded'
    }
    const first = await cache.remember('k7', loader, { tag: 't7' })
    const second = await cache.remember('k7', loader, { tag: 't7' })
    expect(first).toBe('loaded')
    expect(second).toBe('loaded')
    expect(loads).toBe(1)

    cache.invalidate('t7')
    await cache.remember('k7', loader, { tag: 't7' })
    expect(loads).toBe(2)
  })
})
