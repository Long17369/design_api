import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Screen } from '@/cli/screen'
import { ScreenOptions } from '@/cli'

/** 假 stdout：收集写出的内容，可改尺寸，可模拟终端对 `ESC[6n` 的回复 */
class FakeOutput extends EventEmitter {
  public isTTY = true
  public rows = 24
  public columns = 80
  public readonly chunks: string[] = []
  /** 收到光标位置查询（`ESC[6n`）时回一条 DSR 回复（如 '\u001b[12;1R'） */
  public dsrReply: string | null = null
  /** 回复投递目标 */
  public input: FakeInput | null = null

  public write(chunk: string): boolean {
    this.chunks.push(chunk)
    if (this.dsrReply !== null && this.input !== null && chunk.includes('\u001b[6n')) {
      this.input.emit('data', this.dsrReply)
    }
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
const SAVE = '\u001b7'
const RESTORE = '\u001b8'

function makeScreen(options: Partial<ScreenOptions> = {}, dsr: { reply?: string } = {}) {
  const output = new FakeOutput()
  const input = new FakeInput()
  output.input = input
  output.dsrReply = dsr.reply ?? null
  const onSubmit = vi.fn()
  const onInterrupt = vi.fn()
  const screen = new Screen(
    { status: () => '状态行', onSubmit, onInterrupt, ...options },
    output as unknown as typeof process.stdout,
    input as unknown as typeof process.stdin,
    0, // DSR 超时 0ms：不回就立刻退化为「直接记录当前位置」
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
  it('attach：先记录锚点再设滚动区，开启原始模式并绘制底部', async () => {
    const { screen, output, input } = makeScreen()
    expect(await screen.attach()).toBe(true)

    const text = output.text()
    expect(text).toContain(`${ESC}6n`) // 先查询光标位置
    // 顺序：记录锚点（ESC7）必须早于设定滚动区（DECSTBM 会把光标带回左上角）
    expect(text.indexOf(SAVE)).toBeGreaterThan(-1)
    expect(text.indexOf(SAVE)).toBeLessThan(text.indexOf(`${ESC}1;22r`))
    expect(text).toContain(`${ESC}1;22r`) // 24 行 → 滚动区 1..22
    expect(text).toContain(`${ESC}23;1H`) // 状态行
    expect(text).toContain(`${ESC}24;1H`) // 输入行
    expect(text).toContain('状态行')
    expect(text).toContain('> ')
    expect(input.raw).toBe(true)
  })

  it('attach：光标在滚动区内 → 不做归一化（锚点就用当前位置）', async () => {
    const { screen, output } = makeScreen({}, { reply: '\u001b[12;1R' })
    await screen.attach()

    expect(output.text()).not.toContain(`${ESC}22;1H`) // 不额外定位
    expect(output.text()).not.toContain(`${ESC}24;1H\n`) // 也不上滚
    // 锚点紧跟位置查询之后记录（顺序：查询 → 记录锚点 → 设滚动区）
    expect(output.text()).toContain(`${ESC}6n${SAVE}`)
  })

  it('attach：屏幕已满（光标已到底行）→ 上滚一行，且锚点落到滚动区底行', async () => {
    const { screen, output } = makeScreen({}, { reply: '\u001b[24;1R' })
    await screen.attach()

    const text = output.text()
    expect(text).toContain(`${ESC}24;1H\n`) // 先上滚一行（此刻滚动区还是整屏）
    expect(text).toContain(`${ESC}22;1H${SAVE}`) // 锚点必须落在滚动区内
    expect(text.indexOf(`${ESC}22;1H${SAVE}`)).toBeLessThan(text.indexOf(`${ESC}1;22r`))
  })

  it('attach：光标在底部固定区（倒数第二行）→ 同样把锚点落回滚动区底行', async () => {
    const { screen, output } = makeScreen({}, { reply: '\u001b[23;1R' })
    await screen.attach()

    expect(output.text()).toContain(`${ESC}22;1H${SAVE}`)
  })

  it('attach：终端不回 DSR → 锚点退化为滚动区底行（否则日志写不下去）', async () => {
    const { screen, output } = makeScreen()
    expect(await screen.attach()).toBe(true)

    const text = output.text()
    expect(text).toContain(`${ESC}22;1H${SAVE}`)
    expect(text).not.toContain(`${ESC}24;1H\n`) // 位置不明，不擅自上滚
  })

  it('resize：尺寸变化后锚点重新落到滚动区底行', async () => {
    const { screen, output } = makeScreen({}, { reply: '\u001b[12;1R' })
    await screen.attach()
    output.reset()

    output.rows = 40
    output.emit('resize')

    expect(output.text()).toContain(`${ESC}38;1H${SAVE}`) // 40 - 2
    expect(output.text()).toContain(`${ESC}1;38r`)
  })

  it('print：恢复到日志锚点直接写（折行/滚动交给终端），再重绘底部', async () => {
    const { screen, output, input } = makeScreen()
    await screen.attach()
    press(input, 'a')
    output.reset()

    screen.print('日志一行')

    const text = output.text()
    expect(text).toContain(RESTORE) // 恢复日志锚点（终端保存的光标）
    expect(text).toContain('日志一行\n')
    expect(text).toContain(SAVE) // 写完重新保存锚点
    expect(text).not.toContain(`${ESC}22;1H`) // 不手工计算日志行号
    expect(text).toContain(`${ESC}23;1H`) // 重绘状态行
    expect(text).toContain(`${ESC}24;1H`) // 重绘输入行
    expect(text).toContain('> a') // 已输入内容保留
  })

  it('长行折行不靠手工定位：整段文本原样交给终端（不会被后续写入顶掉）', async () => {
    const { screen, output } = makeScreen()
    await screen.attach()
    output.reset()

    screen.print('很长的一行'.repeat(20))

    const text = output.text()
    expect(text).toContain('很长的一行'.repeat(20))
    expect(text).not.toContain(`${ESC}22;1H`)
    expect(text).not.toContain(`${ESC}21;1H`)
  })

  it('多行文本一次写出（不逐行定位）', async () => {
    const { screen, output } = makeScreen()
    await screen.attach()
    output.reset()

    screen.print('A\nB\nC')

    const text = output.text()
    expect(text).toContain('A\nB\nC\n')
    expect(text).not.toContain(`${ESC}1;1H${ESC}2KA`)
  })

  it('print 规整末尾换行（不会多出空行）', async () => {
    const { screen, output } = makeScreen()
    await screen.attach()
    output.reset()

    screen.print('结尾带换行\n')

    expect(output.text()).toContain('结尾带换行\n\u001b7')
  })

  it('非 TTY / 尺寸过小：不接管，print 退化为普通输出', async () => {
    const { screen, output } = makeScreen()
    output.isTTY = false
    expect(await screen.attach()).toBe(false)

    output.reset()
    screen.print('普通一行')
    expect(output.text()).toBe('普通一行\n')
  })

  it('尺寸过小（rows=4）时也不接管', async () => {
    const { screen, output } = makeScreen()
    output.rows = 4
    expect(await screen.attach()).toBe(false)
  })

  it('detach：复位滚动区、清底部两行，并把光标放回底行（shell 提示符从此继续）', async () => {
    const { screen, output, input } = makeScreen()
    await screen.attach()
    output.reset()

    screen.detach()

    const text = output.text()
    expect(text).toContain(`${ESC}r`) // 滚动区复位（会把光标带回左上角）
    expect(text).toContain(`${ESC}23;1H${ESC}2K`)
    expect(text).toContain(`${ESC}24;1H${ESC}2K`)
    expect(text.endsWith(`${ESC}24;1H`)).toBe(true) // 最后把光标放回底行
    expect(text.indexOf(`${ESC}r`)).toBeLessThan(text.lastIndexOf(`${ESC}24;1H`))
    expect(input.raw).toBe(false)
    expect(screen.isActive).toBe(false)
  })

  it('尺寸变化：重设滚动区并重绘底部', async () => {
    const { screen, output } = makeScreen()
    await screen.attach()
    output.reset()

    output.rows = 30
    output.emit('resize')

    const text = output.text()
    expect(text).toContain(`${ESC}1;28r`)
    expect(text).toContain(`${ESC}29;1H`)
    expect(text).toContain(`${ESC}30;1H`)
  })

  it('clear：与 clear 命令同序列（归位 + 清屏 + 清回滚）并把锚点复位', async () => {
    const { screen, output } = makeScreen()
    await screen.attach()
    output.reset()

    screen.clear()

    const text = output.text()
    expect(text).toContain('\u001b[H\u001b[2J\u001b[3J')
    expect(text).toContain(`${ESC}1;22r`)
    expect(text).toContain(SAVE) // 归位后重新记为锚点（从首行开始写）
  })

  it('clear 后写日志仍走锚点（由终端记住首行，不手工算行号）', async () => {
    const { screen, output } = makeScreen()
    await screen.attach()
    screen.print('清屏前的日志')
    screen.clear()
    output.reset()

    screen.print('清屏后第 1 条')

    const text = output.text()
    expect(text).toContain(RESTORE)
    expect(text).toContain('清屏后第 1 条')
    expect(text).not.toContain(`${ESC}1;1H`) // 不手工跳到首行
  })
})

describe('Screen 输入（行编辑与历史）', () => {
  it('输入、退格、左右移动、Home/End', async () => {
    const { screen, input } = makeScreen()
    await screen.attach()

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
  })

  it('Delete 删除光标处字符；Ctrl+U / Ctrl+K 清段', async () => {
    const { screen, input } = makeScreen()
    await screen.attach()

    for (const ch of 'abcd') press(input, ch)
    press(input, undefined, { name: 'home' })
    press(input, undefined, { name: 'delete' })
    expect(screen.current).toBe('bcd')

    press(input, undefined, { name: 'k', ctrl: true })
    expect(screen.current).toBe('')
  })

  it('回车提交：回调收到整行、缓冲清空；空行不提交', async () => {
    const { screen, input, onSubmit } = makeScreen()
    await screen.attach()

    press(input, undefined, { name: 'return' })
    expect(onSubmit).not.toHaveBeenCalled()

    for (const ch of 'urls') press(input, ch)
    press(input, undefined, { name: 'return' })

    expect(onSubmit).toHaveBeenCalledWith('urls')
    expect(screen.current).toBe('')
  })

  it('↑/↓ 浏览历史', async () => {
    const { screen, input } = makeScreen()
    await screen.attach()

    press(input, 'r')
    press(input, undefined, { name: 'return' })
    press(input, 'u')
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

  it('Ctrl+C 触发中断回调', async () => {
    const { screen, input, onInterrupt } = makeScreen()
    await screen.attach()
    press(input, undefined, { name: 'c', ctrl: true })
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+L 清屏但保留布局', async () => {
    const { screen, output, input } = makeScreen()
    await screen.attach()
    output.reset()

    press(input, undefined, { name: 'l', ctrl: true })

    const text = output.text()
    expect(text).toContain(`${ESC}2J`)
    expect(text).toContain(`${ESC}1;22r`)
    expect(text).toContain('状态行')
  })

  it('迟到的控制序列回复不会被当作输入', async () => {
    const { screen, input } = makeScreen()
    await screen.attach()

    press(input, '[12;1R', { name: undefined })
    press(input, '[12;1R')

    expect(screen.current).toBe('')
  })
})
