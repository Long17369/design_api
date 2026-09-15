import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Screen } from '@/cli/screen'
import { ScreenOptions } from '@/cli'

/** 假 stdout：收集写出的内容，可改尺寸 */
class FakeOutput extends EventEmitter {
  public isTTY = true
  public rows = 24
  public columns = 80
  public readonly chunks: string[] = []

  public write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  public text(): string {
    return this.chunks.join('')
  }

  public reset(): void {
    this.chunks.length = 0
  }
}

/** 假 stdin：可直接 emit('keypress') 模拟按键 */
class FakeInput extends EventEmitter {
  public isTTY = true
  public raw = false

  public setRawMode(mode: boolean): this {
    this.raw = mode
    return this
  }

  public resume(): this {
    return this
  }
}

const ESC = '\u001b['

function makeScreen(options: Partial<ScreenOptions> = {}) {
  const output = new FakeOutput()
  const input = new FakeInput()
  const onSubmit = vi.fn()
  const onInterrupt = vi.fn()
  const screen = new Screen(
    {
      status: () => '状态行',
      onSubmit,
      onInterrupt,
      ...options,
    },
    output as unknown as typeof process.stdout,
    input as unknown as typeof process.stdin,
  )
  return { screen, output, input, onSubmit, onInterrupt }
}

/** 模拟一次按键（readline 的 keypress 签名） */
function press(input: FakeInput, str: string | undefined, key: Record<string, unknown> = {}) {
  input.emit('keypress', str, {
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    series: false,
    ...key,
  })
}

describe('Screen 布局（滚动区 + 底部固定两行）', () => {
  it('attach：设定滚动区（除底部两行）、开启原始模式并绘制底部', () => {
    const { screen, output, input } = makeScreen()
    expect(screen.attach()).toBe(true)

    const text = output.text()
    expect(text).toContain(`${ESC}1;22r`) // 24 行 → 滚动区 1..22
    expect(text).toContain(`${ESC}23;1H`) // 状态行
    expect(text).toContain(`${ESC}24;1H`) // 输入行
    expect(text).toContain('状态行')
    expect(text).toContain('> ')
    expect(input.raw).toBe(true)
  })

  it('print：恢复到日志锚点直接写（折行/滚动交给终端），再重绘底部', () => {
    const { screen, output, input } = makeScreen()
    screen.attach()
    press(input, 'a')
    output.reset()

    screen.print('日志一行')

    const text = output.text()
    expect(text).toContain('\u001b8') // 恢复日志锚点（终端保存的光标）
    expect(text).toContain('日志一行\n')
    expect(text).toContain('\u001b7') // 写完重新保存锚点
    expect(text).not.toContain(`${ESC}22;1H`) // 不再手工计算日志行号
    expect(text).toContain(`${ESC}23;1H`) // 重绘状态行
    expect(text).toContain(`${ESC}24;1H`) // 重绘输入行
    expect(text).toContain('> a') // 已输入内容保留
  })

  it('长行折行不靠手工定位：整段文本原样交给终端（不会被后续写入顶掉）', () => {
    const { screen, output } = makeScreen()
    screen.attach()
    output.reset()

    screen.print('很长的一行'.repeat(20))

    const text = output.text()
    expect(text).toContain('很长的一行'.repeat(20))
    expect(text).not.toContain(`${ESC}22;1H`)
    expect(text).not.toContain(`${ESC}21;1H`)
  })

  it('多行文本一次写出（不逐行定位）', () => {
    const { screen, output } = makeScreen()
    screen.attach()
    output.reset()

    screen.print('A\nB\nC')

    const text = output.text()
    expect(text).toContain('A\nB\nC\n')
    expect(text).not.toContain(`${ESC}1;1H${ESC}2KA`) // 不再逐行跳转
  })

  it('print 规整末尾换行（不会多出空行）', () => {
    const { screen, output } = makeScreen()
    screen.attach()
    output.reset()

    screen.print('结尾带换行\n')

    expect(output.text()).toContain('结尾带换行\n\u001b7')
  })

  it('非 TTY / 尺寸过小：不接管，print 退化为普通输出', () => {
    const { screen, output } = makeScreen()
    output.isTTY = false
    expect(screen.attach()).toBe(false)

    output.reset()
    screen.print('普通一行')
    expect(output.text()).toBe('普通一行\n')
  })

  it('尺寸过小（rows=4）时也不接管', () => {
    const { screen, output } = makeScreen()
    output.rows = 4
    expect(screen.attach()).toBe(false)
  })

  it('detach：复位滚动区、清掉底部两行、关闭原始模式', () => {
    const { screen, output, input } = makeScreen()
    screen.attach()
    output.reset()

    screen.detach()

    const text = output.text()
    expect(text).toContain(`${ESC}r`) // 滚动区复位
    expect(text).toContain(`${ESC}23;1H${ESC}2K`)
    expect(text).toContain(`${ESC}24;1H${ESC}2K`)
    expect(input.raw).toBe(false)
    expect(screen.isActive).toBe(false)
  })

  it('尺寸变化：重设滚动区并重绘底部', () => {
    const { screen, output } = makeScreen()
    screen.attach()
    output.reset()

    output.rows = 30
    output.emit('resize')

    const text = output.text()
    expect(text).toContain(`${ESC}1;28r`)
    expect(text).toContain(`${ESC}29;1H`)
    expect(text).toContain(`${ESC}30;1H`)
  })

  it('clear：与 clear 命令同序列（归位 + 清屏 + 清回滚）并把锚点复位', () => {
    const { screen, output } = makeScreen()
    screen.attach()
    output.reset()

    screen.clear()

    const text = output.text()
    expect(text).toContain('\u001b[H\u001b[2J\u001b[3J')
    expect(text).toContain(`${ESC}1;22r`) // 重新设定滚动区
    expect(text).toContain('\u001b7') // 光标归位后重新记为日志锚点（从首行开始写）
  })

  it('clear 后写日志仍走锚点（由终端记住首行，不手工算行号）', () => {
    const { screen, output } = makeScreen()
    screen.attach()
    screen.print('清屏前的日志')
    screen.clear()
    output.reset()

    screen.print('清屏后第 1 条')

    const text = output.text()
    expect(text).toContain('\u001b8') // 仍走终端保存的锚点输出
    expect(text).toContain('清屏后第 1 条')
    expect(text).not.toContain(`${ESC}1;1H`) // 不手工跳到首行
  })
})

describe('Screen 输入（行编辑与历史）', () => {
  it('输入、退格、左右移动、Home/End', () => {
    const { screen, input } = makeScreen()
    screen.attach()

    press(input, 'r')
    press(input, 'e')
    expect(screen.current).toBe('re')

    press(input, undefined, { name: 'left' })
    press(input, 'X')
    expect(screen.current).toBe('rXe')

    press(input, undefined, { name: 'backspace' })
    expect(screen.current).toBe('re')

    press(input, undefined, { name: 'home' })
    press(input, 'A')
    expect(screen.current).toBe('Are')
    press(input, undefined, { name: 'end' })
    press(input, 'Z')
    expect(screen.current).toBe('AreZ')

    press(input, undefined, { name: 'delete' })
    expect(screen.current).toBe('AreZ')
  })

  it('Delete 删除光标处字符；Ctrl+U / Ctrl+K 清段', () => {
    const { screen, input } = makeScreen()
    screen.attach()

    for (const ch of 'abcd') press(input, ch)
    press(input, undefined, { name: 'home' })
    press(input, undefined, { name: 'delete' })
    expect(screen.current).toBe('bcd')

    press(input, undefined, { name: 'k', ctrl: true })
    expect(screen.current).toBe('')
  })

  it('回车提交：回调收到整行、回显到日志区、缓冲清空；空行不提交', () => {
    const { screen, input, onSubmit } = makeScreen()
    screen.attach()

    press(input, undefined, { name: 'return' })
    expect(onSubmit).not.toHaveBeenCalled()

    for (const ch of 'urls') press(input, ch)
    press(input, undefined, { name: 'return' })

    expect(onSubmit).toHaveBeenCalledWith('urls')
    expect(screen.current).toBe('')
  })

  it('↑/↓ 浏览历史', () => {
    const { screen, input } = makeScreen()
    screen.attach()

    for (const ch of 'r') press(input, ch)
    press(input, undefined, { name: 'return' })
    for (const ch of 'u') press(input, ch)
    press(input, undefined, { name: 'return' })

    press(input, undefined, { name: 'up' })
    expect(screen.current).toBe('u')
    press(input, undefined, { name: 'up' })
    expect(screen.current).toBe('r')
    press(input, undefined, { name: 'down' })
    expect(screen.current).toBe('u')
    press(input, undefined, { name: 'down' })
    expect(screen.current).toBe('')
  })

  it('Ctrl+C 触发中断回调', () => {
    const { screen, input, onInterrupt } = makeScreen()
    screen.attach()
    press(input, undefined, { name: 'c', ctrl: true })
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+L 清屏但保留布局', () => {
    const { screen, output, input } = makeScreen()
    screen.attach()
    output.reset()

    press(input, undefined, { name: 'l', ctrl: true })

    const text = output.text()
    expect(text).toContain(`${ESC}2J`) // 清屏
    expect(text).toContain(`${ESC}1;22r`) // 重新设定滚动区
    expect(text).toContain('状态行')
  })
})
