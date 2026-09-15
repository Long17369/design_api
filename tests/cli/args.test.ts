import { describe, expect, it } from 'vitest'
import { CliArgsError, DEFAULT_CONFIG_PATH, USAGE, parseArgs } from '@/cli'

describe('CLI 启动参数解析（parseArgs）', () => {
  it('无参数 → 使用默认配置文件', () => {
    expect(parseArgs([])).toEqual({ configPath: DEFAULT_CONFIG_PATH, help: false })
  })

  it('位置参数 / -c / --config / --config= 四种写法等价', () => {
    expect(parseArgs(['tmp/dev.json']).configPath).toBe('tmp/dev.json')
    expect(parseArgs(['-c', 'tmp/dev.json']).configPath).toBe('tmp/dev.json')
    expect(parseArgs(['--config', 'tmp/dev.json']).configPath).toBe('tmp/dev.json')
    expect(parseArgs(['--config=tmp/dev.json']).configPath).toBe('tmp/dev.json')
  })

  it('-h / --help → help=true', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
  })

  it('配置文件与帮助可同时给出（优先级由调用方决定）', () => {
    expect(parseArgs(['-c', 'a.json', '--help'])).toEqual({ configPath: 'a.json', help: true })
    expect(parseArgs(['--help', 'a.json']).configPath).toBe('a.json')
  })

  it('缺值或未知参数 → CliArgsError', () => {
    expect(() => parseArgs(['--config'])).toThrow(CliArgsError)
    expect(() => parseArgs(['-c'])).toThrow(CliArgsError)
    expect(() => parseArgs(['-c', '--help'])).toThrow(CliArgsError)
    expect(() => parseArgs(['--config='])).toThrow(CliArgsError)
    expect(() => parseArgs(['-x'])).toThrow(CliArgsError)
    expect(() => parseArgs(['--verbose'])).toThrow(CliArgsError)
  })

  it('帮助文本含用法与全部选项', () => {
    expect(USAGE).toContain('用法')
    expect(USAGE).toContain('-c, --config')
    expect(USAGE).toContain('-h, --help')
    expect(USAGE).toContain(DEFAULT_CONFIG_PATH)
  })
})
