export {}

declare module '@core/cache' {
  /** 缓存条目（进程内 KV + TTL + 标签） */
  interface CacheEntry {
    /** 缓存值（读取时由泛型收窄） */
    value: unknown
    /** 到期时间戳(ms)；`Number.POSITIVE_INFINITY` 表示永不过期 */
    expiresAt: number
    /** 归属标签（通常直接使用表名），`invalidate(tag)` 按标签批量失效 */
    tag?: string
  }

  /** 缓存写入选项 */
  interface CacheSetOptions {
    /**
     * 存活时间(ms)：不传使用默认 TTL；传 `0` 表示永不过期。
     * 仅作兜底 —— 表数据变更时应由写库路径主动 `invalidate`。
     */
    ttl?: number
    /** 归属标签（通常直接使用表名） */
    tag?: string
  }

  /** 缓存概况（日志/调试用） */
  interface CacheStats {
    /** 当前有效条目数 */
    size: number
    /** 当前标签数 */
    tags: number
  }
}
