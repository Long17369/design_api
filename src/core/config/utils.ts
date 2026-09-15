import type { Config, ConfigChange } from '@core/config'
import { getConfigSections } from '.'

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
