import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '@core/logger'

afterEach(() => {
  // 全局 logger 是单例：用例结束后恢复默认，避免影响其它用例
  log.setConsoleSink(null)
  vi.restoreAllMocks()
})

describe('logger 控制台输出接收器（终端布局用）', () => {
  it('默认：走 console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await log.getLogger('Test').info('默认输出')
    expect(spy.mock.calls.map(String).join(' ')).toContain('默认输出')
  })

  it('接管后：console 不再输出，接收器收到格式化文本', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const lines: Array<{ text: string; isError: boolean }> = []
    log.setConsoleSink((text, isError) => lines.push({ text, isError }))

    await log.getLogger('Test').info('走接收器')

    expect(spy).not.toHaveBeenCalled()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.text).toContain('走接收器')
    expect(lines[0]?.text).toContain('[Test]')
    expect(lines[0]?.isError).toBe(false)
  })

  it('错误级别标记 isError=true，附加参数折进文本', async () => {
    const lines: Array<{ text: string; isError: boolean }> = []
    log.setConsoleSink((text, isError) => lines.push({ text, isError }))

    await log.getLogger('Test').error('失败', { a: 1 })

    expect(lines[0]?.isError).toBe(true)
    expect(lines[0]?.text).toContain('{"a":1}')
  })

  it('传 null 恢复默认输出', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    log.setConsoleSink(() => undefined)
    log.setConsoleSink(null)

    await log.getLogger('Test').info('恢复正常')

    expect(spy.mock.calls.map(String).join(' ')).toContain('恢复正常')
  })
})
