import type { Config, ConfigApplyStatus, ConfigChange, ConfigSectionName } from '@core/config'
import { bus } from '@core/bus'
import { log } from '@core/logger'
import { getConfigSections } from '.'

const logger = log.getLogger('Config')

/** 等待各组件回报应用结果的默认时长(ms)；超时未回报的 section 按未生效处理 */
export const CONFIG_APPLY_TIMEOUT_MS = 3000

/**
 * 深比较两个 section 值是否相等。
 * 配置为**纯数据**（对象 / 数字 / 字符串）：键集合相同且逐键相等即视为未变更，与键顺序无关。
 */
function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => equalValue(left[key], right[key]))
}

/** 按**已注册**的 section 逐项比对两份配置，返回有变更的 section（保持注册顺序） */
export function diffConfigSections(current: Config, next: Config): ConfigChange[] {
  return getConfigSections()
    .filter((section) => !equalValue(current[section.name], next[section.name]))
    .map((section) => ({ section: section.name, owner: section.owner }))
}

/**
 * 广播配置变更并等各归属组件回报应用结果。
 *
 * 「Server 只广播、组件自行应用」：本函数不关心各 section 怎么用，只负责
 * 发 `CONFIG_CHANGED` → 等回报 → 把未回报的（无订阅者 / 应用卡住）记 `failed`。
 * 同一 section 的多次回报只取**首次**（组件自身重复上报不会覆盖结论）。
 *
 * @returns section → 应用结果（`changed` 中的每一项都有结果，不会缺项）
 */
export async function applyConfigChanges(
  changed: ConfigChange[],
  config: Config,
  timeoutMs: number = CONFIG_APPLY_TIMEOUT_MS,
): Promise<Map<ConfigSectionName, ConfigApplyStatus>> {
  const results = new Map<ConfigSectionName, ConfigApplyStatus>()
  const expected = new Set(changed.map((item) => item.section))
  let settle: () => void = () => {}
  const allReported = new Promise<void>((resolve) => {
    settle = resolve
  })

  const report = (section: ConfigSectionName, status: ConfigApplyStatus): void => {
    if (!expected.has(section) || results.has(section)) return
    results.set(section, status)
    if (results.size >= expected.size) settle()
  }

  bus.emitEvent('CONFIG_CHANGED', { changed, config, report })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  await Promise.race([allReported, timeout])
  if (timer !== undefined) clearTimeout(timer)

  for (const section of expected) {
    if (results.has(section)) continue
    results.set(section, 'failed')
    logger.warn(`配置热更新：section ${section} 未在 ${timeoutMs}ms 内回报应用结果，按未生效处理`)
  }
  return results
}
