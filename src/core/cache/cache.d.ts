export {}

declare module '@core/cache' {
  /**
   * 缓存使用约定（业务模块必读；key 清单见 `docs/CACHE.md`）：
   *
   * - **key 由使用它的模块自己定义**（模块内常量 + 注明用途与 tag）：`@core/cache`
   *   只提供通用能力，**不集中登记业务 key**（core 不得反向依赖业务模块）；
   * - key 命名 `<模块>:<用途>`（如 `sensorModule:mapper` / `autoControl:configDefaults`）；
   * - 读取用 `cache.remember(key, loader, { tag })`；`tag` 必须等于**数据来源表名**
   *   （`Database.insert/update/delete` 成功后按表名 `invalidate`，写库失效靠它命中）；
   * - 命中判据是 `value !== undefined`：**loader 返回 `undefined` 等于永不缓存（每次回源）**，
   *   空结果请返回 `[]` / `null` / 带默认值的对象；
   * - 只缓存「低频写、高频读」的全局数据（配置/映射）；**设备级数据（`direct` 按 `d_no` 的行）
   *   逐帧直读，不进缓存**——这是「前端改配置立即生效」的前提。
   */
  interface CacheEntry {
    /** 缓存值（读取时由泛型收窄） */
    value: unknown
    /** 到期时间戳(ms)；`Number.POSITIVE_INFINITY` 表示永不过期 */
    expiresAt: number
    /** 归属标签（必须是数据来源表名），`invalidate(tag)` 按标签批量失效 */
    tag?: string
  }

  /** 缓存写入选项 */
  interface CacheSetOptions {
    /**
     * 存活时间(ms)：不传使用默认 TTL（60000）；传 `0` 表示永不过期。
     * 仅作兜底 —— 表数据变更时应由写库路径主动 `invalidate`。
     */
    ttl?: number
    /** 归属标签（必须是数据来源表名，见 `CacheEntry.tag`） */
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
