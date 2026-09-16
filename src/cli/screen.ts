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

/** 保存 / 恢复光标（DECSC / DECRC）：日志锚点交给终端记，不自己算行号 */
const SAVE_CURSOR = '\u001b7'
const RESTORE_CURSOR = '\u001b8'

/** 终端的光标位置回复（DSR）：`ESC[<row>;<col>R`。由 ESC 常量拼出，避免正则里出现控制字符 */
const DSR_REPLY = new RegExp(`${ESC.replace('[', '\\[')}([0-9]+);([0-9]+)R`)

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
  private active = false
  private onKeypress: ((str: string | undefined, key: readline.Key) => void) | null = null
  private onResize: (() => void) | null = null

  constructor(
    private readonly options: ScreenOptions,
    private readonly output: typeof process.stdout = process.stdout,
    private readonly input: typeof process.stdin = process.stdin,
    /** 查询光标位置（DSR）的等待时长(ms)；超时则退化为“直接记录当前位置” */
    private readonly dsrTimeoutMs = 150,
  ) {}

  /** 是否已进入布局 */
  public get isActive(): boolean {
    return this.active
  }

  /**
   * 进入底部固定布局（仅 TTY）；返回是否进入。
   *
   * 顺序很关键：**先记录日志锚点，再设定滚动区** —— DECSTBM（`ESC[<t>;<b>r`）
   * 会把光标带回左上角，若先设滚动区再记录，锚点会落到首行、新日志会覆盖启动输出。
   *
   * 锚点还**必须落在滚动区内**（`1..regionBottom`）：写日志是「回到锚点写一行 + 换行」，
   * 换行只有发生在滚动区底行才会触发上滚；锚点若落在底部固定区（终端启动时若光标本来
   * 就在最下面，DECSC 记下的就是那一行），日志就会一行行压在状态行/输入行上、不再上滚。
   */
  public async attach(): Promise<boolean> {
    if (this.active) return true
    if (!this.input.isTTY || !this.output.isTTY) return false
    this.measure()
    if (this.rows < MIN_ROWS || this.cols < MIN_COLS) return false

    this.input.setRawMode(true)
    this.input.resume()

    // 接管按键解码**之前**问一次光标行：既拿到真实输出位置，也避免把回复当按键
    const cursorRow = await this.queryCursorRow()
    this.active = true

    const bottom = this.regionBottom()
    // 屏幕已满（光标在底部固定区）⇒ 先上滚一行，丢掉最旧一行、保住启动输出的位置
    if (cursorRow !== null && cursorRow > bottom) {
      this.output.write(`${ESC}${this.rows};1H\n`)
    }
    // 光标位置不可用（终端不回 DSR / 已在底部固定区）⇒ 锚点直接落到滚动区底行
    if (cursorRow === null || cursorRow > bottom) {
      this.output.write(`${ESC}${bottom};1H`)
    }
    // 记录日志锚点：之后写日志都回到这里，折行/滚动交给终端
    this.output.write(SAVE_CURSOR)
    this.applyScrollRegion()

    readline.emitKeypressEvents(this.input)
    this.onKeypress = (str, key) => this.handleKey(str, key)
    this.input.on('keypress', this.onKeypress)
    this.onResize = () => this.handleResize()
    this.output.on('resize', this.onResize)
    this.redraw()
    return true
  }

  /**
   * 问终端当前光标行（DSR：发 `ESC[6n`，终端回 `ESC[<row>;<col>R`）。
   * 拿不到回复返回 null（部分终端/伪终端不回）—— 调用方把日志锚点落到滚动区底行。
   */
  private queryCursorRow(): Promise<number | null> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const finish = (row: number | null): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        this.input.off('data', onData)
        resolve(row)
      }
      const onData = (chunk: Buffer | string): void => {
        const match = DSR_REPLY.exec(String(chunk))
        if (match?.[1] !== undefined) finish(Number(match[1]))
      }
      this.input.on('data', onData)
      timer = setTimeout(() => finish(null), this.dsrTimeoutMs)
      this.output.write(`${ESC}6n`)
    })
  }

  /**
   * 退出布局并还原终端。
   *
   * ⚠️ 复位滚动区（`ESC[r`）会把光标带回**左上角**，所以复位后必须显式把光标
   * 放回底行，否则退出后的 shell 提示符会从屏幕顶部往下写、与残留日志交叠。
   */
  public detach(): void {
    if (!this.active) return
    this.active = false
    if (this.onKeypress) this.input.off('keypress', this.onKeypress)
    if (this.onResize) this.output.off('resize', this.onResize)
    this.onKeypress = null
    this.onResize = null
    this.input.setRawMode(false)
    this.output.write(
      `${RESET_ATTR}${ESC}r` +
        `${ESC}${this.rows - 1};1H${ESC}2K` + // 清掉原状态行
        `${ESC}${this.rows};1H${ESC}2K` + // 清掉原输入行
        `${ESC}${this.rows};1H`, // 光标停到底行，shell 提示符从此处继续
    )
  }

  /**
   * 写入日志/命令输出。
   *
   * **不自己算行号**：先恢复到“日志锚点”（终端保存的光标位置）直接写，写完重新保存。
   * 折行与滚动全交给终端 —— 长行折出的第二行不会覆盖前一行，也不会溢出到底部固定区。
   */
  public print(text: string): void {
    if (!this.active) {
      this.output.write(`${text}\n`)
      return
    }
    const line = text.endsWith('\n') ? text.slice(0, -1) : text
    this.output.write(`${RESTORE_CURSOR}${RESET_ATTR}${ESC}K${line}\n${SAVE_CURSOR}`)
    this.redraw()
  }

  /** 更新状态行内容（立即重绘） */
  public refreshStatus(): void {
    if (this.active) this.redrawStatus()
  }

  /**
   * 清屏：与 `clear` 命令一致 —— **光标归位 + 清屏 + 清回滚缓冲**。
   * 光标归位后即日志区首行，重新记为日志锚点 ⇒ 之后的日志从顶部开始写。
   */
  public clear(): void {
    if (!this.active) {
      this.output.write(CLEAR_ALL)
      return
    }
    this.output.write(`${RESET_ATTR}${CLEAR_ALL}`)
    this.applyScrollRegion()
    this.output.write(SAVE_CURSOR)
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
    // 尺寸变化后终端里存的锚点（绝对行号）可能已落到滚动区外 ⇒ 重新落到滚动区底行
    this.output.write(`${ESC}${this.regionBottom()};1H${SAVE_CURSOR}`)
    this.redraw()
  }

  // ------------------------- 输入 -------------------------

  private handleKey(str: string | undefined, key: readline.Key | undefined): void {
    if (!key) return
    const name = key.name ?? ''

    // 光标位置查询等控制序列回复迟到时不要当按键输入（正常已在 attach 时消费掉）
    if (str !== undefined && /^\[\d+(;\d+)*[A-Z]$/.test(str)) return

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
