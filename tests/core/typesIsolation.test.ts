import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 契约目录纯净性守卫：`src/types/` 内**不允许任何外部引用**。
 *
 * `src/types/*.ts`（`types.ts`、`api.ts`）是前端直接引用的对外契约，必须自包含：
 * 只允许同目录 `./` 相对引用；出现 `@core/*` / `@gateways/*` / `@modules/*` / `@root/*` /
 * `@/*` / 第三方包 / `node:*` 一律视为违规（2026-09-14 用户明确的规矩）。
 */
const TYPES_DIR = path.resolve(process.cwd(), 'src/types')

/** 提取源码里的模块说明符：`from 'x'`、`import('x')`、`require('x')` */
function importSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  return [...source.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : []))
}

describe('src/types 契约目录纯净性', () => {
  it('目录内只允许 ./ 相对引用，不允许任何外部引用', () => {
    const files = fs.readdirSync(TYPES_DIR).filter((file) => file.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    const violations = files.flatMap((file) => {
      const source = fs.readFileSync(path.join(TYPES_DIR, file), 'utf8')
      return importSpecifiers(source)
        .filter((spec) => !spec.startsWith('./'))
        .map((spec) => `${file} → ${spec}`)
    })

    expect(violations).toEqual([])
  })
})
