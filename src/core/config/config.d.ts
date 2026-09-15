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
}
