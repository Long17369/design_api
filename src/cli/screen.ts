import readline from 'node:readline'
import { ScreenOptions } from '.'

/** 底部固定区行数：状态行 + 输入行（滚动区 = 其余行） */
const FOOTER_LINES = 2

/** 输入提示符 */
const PROMPT = '> '

/** 最小可用尺寸（不足时退化为普通输出，不做布局） */
const MIN_ROWS = 6
const MIN_COLS = 20

/** ANSI 控制序列 */
const ESC = '\u001b['
const RESET_ATTR = `${ESC}0m`
const DIM = `${ESC}2m`

/** 与 `clear` 命令一致：光标归位 + 清屏 + 清回滚缓冲 */
const CLEAR_ALL = '\u001b[H\u001b[2J\u001b[3J'

/**
 * 终端布局：**底部固定状态行 + 输入行，其余行作为日志滚动区**。
 *
 * 做法是终端控制符（无第三方库）：
 * - `ESC[1;<bottom>r` 设定**滚动区**为除底部两行以外的区域，于是日志里的换行只会
 *   让滚动区自己上滚，底部两行（状态 + 输入）纹丝不动；
 * - 输出日志时先跳到滚动区最后一行再写（末尾换行触发上滚），随后重绘底部并归位光标；
 * - 输入行自行实现（原始模式 + keypress）：行编辑、历史、Ctrl+C/L 等常用键。
 *
 * 非 TTY（重定向日志、被进程管理器拉起）时 `attach()` 直接返回 false，
 * 由调用方退化为普通 `console` 输出。
 *
 * 流可注入（默认 `process.stdout` / `process.stdin`），便于单测断言控制序列。
 */
export class Screen {
  /** 输入缓冲与光标（光标为 buffer 内的插入位置） */
  private buffer = ''
  private cursor = 0
  /** 历史命令（↑/↓ 浏览） */
  private history: string[] = []
  private historyIndex = -1
  /** 终端尺寸（每行/列号都是 1 起） */
  private rows = 24
  private cols = 80
  /** 下一条日志的落点行（绝对行号，1 起）；> 滚动区底行表示需先上滚 */
  private logRow = 1
  private active = false
  private onKeypress: ((str: string | undefined, key: readline.Key) => void) | null = null
  private onResize: (() => void) | null = null

  constructor(
    private readonly options: ScreenOptions,
    private readonly output: typeof process.stdout = process.stdout,
    private readonly input: typeof process.stdin = process.stdin,
  ) {}

  /** 是否已进入布局 */
  public get isActive(): boolean {
    return this.active
  }

  /** 进入底部固定布局（仅 TTY）；返回是否进入 */
  public attach(): boolean {
    if (this.active) return true
    if (!this.input.isTTY || !this.output.isTTY) return false
    this.measure()
    if (this.rows < MIN_ROWS || this.cols < MIN_COLS) return false

    this.active = true
    this.applyScrollRegion()
    // 继续接在既有输出之后（从滚动区底行起写，写满再上滚）
    this.logRow = this.regionBottom()
    this.input.setRawMode(true)
    this.input.resume()
    readline.emitKeypressEvents(this.input)
    this.onKeypress = (str, key) => this.handleKey(str, key)
    this.input.on('keypress', this.onKeypress)
    this.onResize = () => this.handleResize()
    this.output.on('resize', this.onResize)
    this.redraw()
    return true
  }

  /** 退出布局并还原终端（滚动区复位、底部两行清空、原始模式关闭） */
  public detach(): void {
    if (!this.active) return
    this.active = false
    if (this.onKeypress) this.input.off('keypress', this.onKeypress)
    if (this.onResize) this.output.off('resize', this.onResize)
    this.onKeypress = null
    this.onResize = null
    this.input.setRawMode(false)
    this.output.write(
      `${RESET_ATTR}${ESC}${this.rows - 1};1H${ESC}2K${ESC}${this.rows};1H${ESC}2K${ESC}r`,
    )
  }

  /**
   * 写入日志/命令输出：从滚动区**当前落点**向下写，写满后在滚动区内上滚；底部固定区不受影响。
   * 落点由 `logRow` 跟踪 —— `clear` 后回到滚动区首行，避免从底行往上“撑”出一片空行。
   */
  public print(text: string): void {
    if (!this.active) {
      this.output.write(`${text}\n`)
      return
    }
    for (const line of text.split('\n')) this.appendLine(line)
    this.redraw()
  }

  /** 追加一行到日志区：落点到底行之后，先在底行换行（整区上滚一行）再写 */
  private appendLine(line: string): void {
    const bottom = this.regionBottom()
    if (this.logRow > bottom) {
      this.output.write(`${ESC}${bottom};1H\n`)
      this.logRow = bottom
    }
    this.output.write(`${RESET_ATTR}${ESC}${this.logRow};1H${ESC}2K${line}`)
    this.logRow++
  }

  /** 更新状态行内容（立即重绘） */
  public refreshStatus(): void {
    if (this.active) this.redrawStatus()
  }

  /**
   * 清屏：与 `clear` 命令一致 —— **光标归位 + 清屏 + 清回滚缓冲**，
   * 随后日志从滚动区**首行**向下写（否则会从底行往上撑出一片空行）。
   */
  public clear(): void {
    if (!this.active) {
      this.output.write(CLEAR_ALL)
      return
    }
    this.output.write(`${RESET_ATTR}${CLEAR_ALL}`)
    this.applyScrollRegion()
    this.logRow = 1
    this.redraw()
  }

  /** 取当前输入缓冲（测试/调试用） */
  public get current(): string {
    return this.buffer
  }

  // ------------------------- 布局 -------------------------

  private measure(): void {
    this.rows = this.output.rows && this.output.rows > 0 ? this.output.rows : 24
    this.cols = this.output.columns && this.output.columns > 0 ? this.output.columns : 80
  }

  /** 滚动区底行（底部两行留给状态 + 输入） */
  private regionBottom(): number {
    return Math.max(1, this.rows - FOOTER_LINES)
  }

  private applyScrollRegion(): void {
    this.output.write(`${ESC}1;${this.regionBottom()}r`)
  }

  private redraw(): void {
    this.redrawStatus()
    this.redrawInput()
  }

  /** 状态行（倒数第二行，暗色显示） */
  private redrawStatus(): void {
    const text = this.options.status()
    const room = this.cols - 1
    const view = text.length > room ? text.slice(0, room) : text
    this.output.write(`${ESC}${this.rows - 1};1H${ESC}2K${DIM}${view}${RESET_ATTR}`)
  }

  /** 输入行（最后一行）：`> <buffer>`，光标按 buffer 内位置定位 */
  private redrawInput(): void {
    const { text, cursorColumn } = this.inputView()
    this.output.write(`${ESC}${this.rows};1H${ESC}2K${text}${ESC}${this.rows};${cursorColumn}H`)
  }

  /** 输入行可视内容（超宽时以光标为中心取窗口） */
  private inputView(): { text: string; cursorColumn: number } {
    const full = `${PROMPT}${this.buffer}`
    const cursorPos = PROMPT.length + this.cursor
    const room = this.cols - 1
    if (full.length <= room) return { text: full, cursorColumn: cursorPos + 1 }
    const start = Math.min(Math.max(0, cursorPos - room + 1), full.length - room)
    return { text: full.slice(start, start + room), cursorColumn: cursorPos - start + 1 }
  }

  private handleResize(): void {
    this.measure()
    this.applyScrollRegion()
    this.logRow = Math.min(this.logRow, this.regionBottom())
    this.redraw()
  }

  // ------------------------- 输入 -------------------------

  private handleKey(str: string | undefined, key: readline.Key | undefined): void {
    if (!key) return
    const name = key.name ?? ''

    if (key.ctrl && name === 'c') {
      this.options.onInterrupt()
      return
    }
    if (key.ctrl && name === 'l') {
      this.clear()
      return
    }
    if (key.ctrl && name === 'a') {
      this.cursor = 0
      this.redrawInput()
      return
    }
    if (key.ctrl && name === 'e') {
      this.cursor = this.buffer.length
      this.redrawInput()
      return
    }
    if (key.ctrl && name === 'u') {
      this.buffer = this.buffer.slice(this.cursor)
      this.cursor = 0
      this.redrawInput()
      return
    }
    if (key.ctrl && name === 'k') {
      this.buffer = this.buffer.slice(0, this.cursor)
      this.redrawInput()
      return
    }
    if (name === 'return' || name === 'enter') {
      this.submit()
      return
    }
    if (name === 'backspace') {
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor)
        this.cursor--
        this.redrawInput()
      }
      return
    }
    if (name === 'delete') {
      if (this.cursor < this.buffer.length) {
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1)
        this.redrawInput()
      }
      return
    }
    if (name === 'left') {
      if (this.cursor > 0) this.cursor--
      this.redrawInput()
      return
    }
    if (name === 'right') {
      if (this.cursor < this.buffer.length) this.cursor++
      this.redrawInput()
      return
    }
    if (name === 'home') {
      this.cursor = 0
      this.redrawInput()
      return
    }
    if (name === 'end') {
      this.cursor = this.buffer.length
      this.redrawInput()
      return
    }
    if (name === 'up') {
      this.browseHistory(-1)
      return
    }
    if (name === 'down') {
      this.browseHistory(1)
      return
    }
    // 可见字符（含中文等整段输入）
    if (str !== undefined && !key.ctrl && !key.meta && str >= ' ' && str !== '\u007f') {
      this.insert(str)
    }
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor)
    this.cursor += text.length
    this.redrawInput()
  }

  /** 提交输入：先清空输入行；非空则回显到日志区形成记录，再交给回调（空行忽略） */
  private submit(): void {
    const line = this.buffer
    this.buffer = ''
    this.cursor = 0
    this.historyIndex = -1
    this.redrawInput()
    if (line.trim() === '') return

    this.history.push(line)
    if (this.history.length > 100) this.history.shift()
    this.print(`${DIM}${PROMPT}${line}${RESET_ATTR}`)
    this.options.onSubmit(line)
  }

  /** ↑/↓ 浏览历史（-1 上翻、1 下翻） */
  private browseHistory(step: -1 | 1): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      if (step === 1) return
      this.historyIndex = this.history.length - 1
    } else {
      const next = this.historyIndex + step
      if (next < 0) return
      this.historyIndex = next > this.history.length - 1 ? -1 : next
    }
    this.buffer = this.historyIndex === -1 ? '' : (this.history[this.historyIndex] ?? '')
    this.cursor = this.buffer.length
    this.redrawInput()
  }
}
