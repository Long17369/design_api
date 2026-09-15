import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cli, COMMANDS, helpText, resolveCommand } from '@/cli'
import { CliHost } from '@/cli'
import { ReloadResult, ServiceEndpoint } from '@/server'

const EMPTY_RESULT: ReloadResult = {
  changed: [],
  applied: false,
  appliedSections: [],
  failedSections: [],
  pendingRestart: [],
}

const ENDPOINTS: ServiceEndpoint[] = [
  { name: 'HTTP', role: 'listen', url: 'http://localhost:10452/api' },
  { name: 'WebSocket', role: 'listen', url: 'ws://localhost:10452/api/ws' },
  { name: 'MQTT', role: 'connect', url: 'mqtt://localhost:1883' },
]

/** 替身 host：Cli 不依赖真实 Server */
function makeHost(result: ReloadResult = EMPTY_RESULT) {
  const reload = vi.fn(async () => result)
  const restart = vi.fn(async () => undefined)
  const stop = vi.fn()
  const endpoints = vi.fn(() => ENDPOINTS)
  const host = { reload, restart, stop, endpoints } as unknown as CliHost
  return { host, reload, restart, stop, endpoints }
}

/** 收集 console.log 输出 */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return { lines, restore: () => spy.mockRestore() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('命令清单与解析（resolveCommand）', () => {
  it('短名与全名等价，大小写不敏感', () => {
    const pairs: Array<[string, string]> = [
      ['r', 'reload'],
      ['u', 'urls'],
      ['c', 'clear'],
      ['q', 'quit'],
      ['h', 'help'],
    ]
    for (const [short, name] of pairs) {
      expect(resolveCommand(short)?.name).toBe(name)
      expect(resolveCommand(name)?.name).toBe(name)
      expect(resolveCommand(name.toUpperCase())?.name).toBe(name)
      expect(resolveCommand(`  ${short}  `)?.name).toBe(name)
    }
  })

  it('restart 只有全名（没有短名）', () => {
    expect(resolveCommand('restart')?.name).toBe('restart')
    expect(resolveCommand('restart')?.short).toBeNull()
    expect(resolveCommand('re')).toBeUndefined()
  })

  it('空行 / 未知命令 → undefined', () => {
    expect(resolveCommand('')).toBeUndefined()
    expect(resolveCommand('   ')).toBeUndefined()
    expect(resolveCommand('reload!')).toBeUndefined()
    expect(resolveCommand('quit now')).toBeUndefined()
  })

  it('清单覆盖约定的 6 条命令', () => {
    expect(COMMANDS.map((item) => item.name)).toEqual([
      'reload',
      'urls',
      'clear',
      'quit',
      'restart',
      'help',
    ])
  })

  it('帮助文本含全部命令与启动帮助', () => {
    const text = helpText()
    for (const name of ['reload', 'urls', 'clear', 'quit', 'restart', 'help']) {
      expect(text).toContain(name)
    }
    for (const short of ['r', 'u', 'c', 'q', 'h']) {
      expect(text).toContain(`${short} | `)
    }
    expect(text).toContain('用法：pnpm dev')
    expect(text).toContain('--config')
  })
})

describe('Cli 命令执行（run）', () => {
  it('r / reload → 调用热更新并打印结果', async () => {
    const { host, reload } = makeHost({
      changed: [
        { section: 'mqtt', owner: 'MqttGateway' },
        { section: 'port', owner: 'HttpServer' },
      ],
      applied: true,
      appliedSections: ['mqtt'],
      failedSections: [],
      pendingRestart: ['port'],
    })
    const { lines, restore } = captureLog()
    await new Cli(host).run('r')
    await new Cli(host).run('reload')
    restore()

    expect(reload).toHaveBeenCalledTimes(2)
    expect(lines.join('\n')).toContain('变更 [mqtt, port]')
    expect(lines.join('\n')).toContain('已生效：mqtt')
    expect(lines.join('\n')).toContain('需 restart：port')
  })

  it('无变更时提示「配置无变更」', async () => {
    const { host } = makeHost()
    const { lines, restore } = captureLog()
    await new Cli(host).run('reload')
    restore()
    expect(lines).toContain('配置无变更')
  })

  it('u / urls → 打印各服务地址（区分监听/连接）', async () => {
    const { host } = makeHost()
    const { lines, restore } = captureLog()
    await new Cli(host).run('urls')
    restore()

    const text = lines.join('\n')
    expect(text).toContain('[监听] HTTP')
    expect(text).toContain('http://localhost:10452/api')
    expect(text).toContain('ws://localhost:10452/api/ws')
    expect(text).toContain('[连接] MQTT')
    expect(text).toContain('mqtt://localhost:1883')
  })

  it('restart（仅全名）→ 调用进程内重启', async () => {
    const { host, restart } = makeHost()
    const { lines, restore } = captureLog()
    await new Cli(host).run('restart')
    restore()

    expect(restart).toHaveBeenCalledTimes(1)
    expect(lines.join('\n')).toContain('服务重启完成')
  })

  it('q / quit → 优雅关闭（不带兜底强退，那是入口职责）', async () => {
    const { host, stop } = makeHost()
    await new Cli(host).run('q')
    await new Cli(host).run('quit')
    expect(stop).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenLastCalledWith('CLI quit')
  })

  it('c / clear → 写 ANSI 清屏（未接管 stdin 时）', async () => {
    const { host } = makeHost()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await new Cli(host).run('clear')
    expect(write).toHaveBeenCalledWith('\u001b[2J\u001b[3J\u001b[H')
  })

  it('h / help → 打印帮助（命令清单 + 启动帮助）', async () => {
    const { host } = makeHost()
    const { lines, restore } = captureLog()
    await new Cli(host).run('h')
    restore()

    const text = lines.join('\n')
    expect(text).toContain('运行中命令')
    expect(text).toContain('用法：pnpm dev')
  })

  it('空行不输出；未知命令给出提示且不触碰 host', async () => {
    const { host, reload, restart, stop } = makeHost()
    const { lines, restore } = captureLog()
    await new Cli(host).run('')
    await new Cli(host).run('   ')
    await new Cli(host).run('nope')
    restore()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('未知命令：nope')
    expect(reload).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('命令执行失败只打印错误，不抛出（交互循环不中断）', async () => {
    const { host } = makeHost()
    ;(host.reload as unknown as () => Promise<never>) = () => Promise.reject(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(new Cli(host).run('r')).resolves.toBeUndefined()
    expect(errorSpy.mock.calls.map(String).join(' ')).toContain('命令 reload 执行失败：boom')
  })
})
