import { CacheEntry, CacheSetOptions, CacheStats } from '.'

/** 未指定 TTL 时的默认存活时间(ms)，仅作失效遗漏的兜底 */
const DEFAULT_TTL = 60_000

/**
 * 进程级通用缓存（KV + TTL + 标签失效）。
 *
 * 设计取舍：
 * - **写穿透失效是主路径**：`Database.insert/update/delete` 成功后按表名调用
 *   `invalidate(table)`，因此缓存命中时不会读到已被应用改动的数据；
 * - TTL 只是兜底，防止漏掉某个失效点时长期脏读（默认 60s，可传 `ttl: 0` 关闭）；
 * - `tag` 一般直接用表名，一次失效即可覆盖该表的全部派生缓存；
 * - 进程级单例（不参与模块 close），随进程存活。
 */
export class CacheStore {
  /** key → 条目 */
  private readonly entries = new Map<string, CacheEntry>()

  /** 标签 → key 集合（加速按标签批量失效） */
  private readonly tags = new Map<string, Set<string>>()

  /** 读取缓存；条目不存在或已过期返回 undefined（过期条目顺带清理） */
  public get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.drop(key)
      return undefined
    }
    return entry.value as T
  }

  /** 写入缓存（覆盖同 key 的旧值与旧标签） */
  public set<T>(key: string, value: T, options: CacheSetOptions = {}): void {
    const ttl = options.ttl ?? DEFAULT_TTL
    this.drop(key)
    this.entries.set(key, {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl : Number.POSITIVE_INFINITY,
      ...(options.tag !== undefined ? { tag: options.tag } : {}),
    })
    if (options.tag !== undefined) {
      const keys = this.tags.get(options.tag) ?? new Set<string>()
      keys.add(key)
      this.tags.set(options.tag, keys)
    }
  }

  /** 读缓存，未命中则执行 loader 并写入（避免各处重复写「读-判空-写」） */
  public async remember<T>(
    key: string,
    loader: () => Promise<T>,
    options: CacheSetOptions = {},
  ): Promise<T> {
    const hit = this.get<T>(key)
    if (hit !== undefined) return hit
    const value = await loader()
    this.set(key, value, options)
    return value
  }

  /** 删除单个 key */
  public del(key: string): void {
    this.drop(key)
  }

  /** 按标签批量失效（写库成功后按表名调用） */
  public invalidate(tag: string): void {
    const keys = this.tags.get(tag)
    if (!keys) return
    for (const key of [...keys]) this.drop(key)
    this.tags.delete(tag)
  }

  /** 清空全部缓存 */
  public clear(): void {
    this.entries.clear()
    this.tags.clear()
  }

  /** 缓存概况（顺带清理过期条目） */
  public stats(): CacheStats {
    const now = Date.now()
    for (const [key, entry] of [...this.entries]) {
      if (entry.expiresAt <= now) this.drop(key)
    }
    return { size: this.entries.size, tags: this.tags.size }
  }

  /** 删除条目并解除其标签引用 */
  private drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (entry.tag === undefined) return
    const keys = this.tags.get(entry.tag)
    if (!keys) return
    keys.delete(key)
    if (keys.size === 0) this.tags.delete(entry.tag)
  }
}

/** 进程级单例 */
export const cache = new CacheStore()
