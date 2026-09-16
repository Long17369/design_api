import type { Config } from '.'

/**
 * 配置模块的类型契约。
 *
 * **注册机制（谁消费谁声明）**：
 * - 类型侧 —— 消费某 section 的组件在自己的 `*.d.ts` 里给 `Config` 补上该 section
 *   （`database` → `@core/database`、`mqtt` → `@gateways/mqtt`、`port` → `@gateways/http`）；
 * - 运行期 —— 同一组件在构造时调用 `registerConfigSection()` 登记归属。
 *
 * 因此本模块**不自带 section 清单**，只提供机制；新增 section 无需改动本文件。
 */
declare module '@core/config' {
  /**
   * 配置文件顶层 section 名 = `Config` 的公开键。
   * `Config` 类本身不声明公开字段，故公开键恰好等于「各消费组件为它补上的 section」。
   */
  type ConfigSectionName = keyof Config

  /** 配置 section 注册项（由消费该 section 的组件自行注册） */
  interface ConfigSectionDef {
    /** section 名（`Config` 实例上的属性名） */
    name: ConfigSectionName
    /**
     * 归属组件名（**消费并应用**该 section 的组件）。
     * 热更新只按此标注分派对象，实际应用由归属组件负责 —— Server 不越权代改。
     */
    owner: string
  }

  /** 单个 section 的变更记录（`section` 名 + 其归属组件） */
  interface ConfigChange {
    section: ConfigSectionName
    /** 该 section 的归属组件（应用者） */
    owner: string
  }

  /**
   * section 应用结果（归属组件应用完自己的 section 后回报）：
   * `applied` 已按新配置生效 / `failed` 应用失败 / `restart-required` 需完整 `restart()`
   */
  type ConfigApplyStatus = 'applied' | 'failed' | 'restart-required'

  /** 热更新事件载荷（`Server` 广播；section 归属组件订阅后自行应用并回报结果） */
  interface ConfigChangedPayload {
    /** 本次变更的 section（含归属组件） */
    changed: ConfigChange[]
    /** 新配置（组件只取自己负责的 section） */
    config: Config
    /** 应用结果回报：组件处理完自己的 section 后调用**一次**；超时未回报按 `failed` 处理 */
    report: (section: ConfigSectionName, status: ConfigApplyStatus) => void
  }

  /**
   * 配置热更新结果（`Server.reloadConfig()` 汇总各归属组件的回报）。
   * `Server` 只广播变更与汇总结果，不代改任何 section。
   */
  interface ReloadResult {
    /** 有变更的 section（为空表示配置未变） */
    changed: ConfigChange[]
    /** 是否至少有一个 section 已生效 */
    applied: boolean
    /** 已按新配置生效的 section */
    appliedSections: ConfigSectionName[]
    /** 未生效的 section（应用失败 / 超时未回报） */
    failedSections: ConfigSectionName[]
    /** 不可热更、需完整 `restart()` 才能生效的 section（如 `port` / `database`） */
    pendingRestart: ConfigSectionName[]
  }
}

declare module '@core/bus' {
  interface EventHandlerMapper {
    CONFIG_CHANGED: import('@core/config').ConfigChangedPayload
  }
}
