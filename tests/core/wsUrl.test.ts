import { describe, expect, it } from 'vitest'
import { API_BASE as SERVER_API_BASE, WS_PATH as SERVER_WS_PATH } from '@gateways/utils'
import { WS_PATH, connectWebSocket } from '@/types/api'

/**
 * WebSocket 契约接口单测：
 *  ① 契约 `WS_PATH` 与后端网关常量一致（契约自包含，靠断言防漂移）
 *  ② `connectWebSocket(goal?)` 返回**连接实例**（非地址字符串），地址按当前 `location` 拼绝对地址
 *  ③ 无 `location` 的环境报明确错误（不静默拼出无效的相对地址）
 */
describe('WS_PATH（WebSocket 接口路径）', () => {
  it('与后端网关常量一致（契约自包含，靠断言防漂移）', () => {
    expect(WS_PATH).toBe(SERVER_WS_PATH)
    expect(WS_PATH).toBe('/api/ws')
    expect(WS_PATH.startsWith(SERVER_API_BASE)).toBe(true)
  })
})

describe('connectWebSocket（返回连接实例）', () => {
  /** 注入假 location（Node 无 location），用完删除 */
  function withLocation<T>(location: { protocol: string; host: string }, run: () => T): T {
    const globals = globalThis as { location?: { protocol: string; host: string } }
    globals.location = location
    try {
      return run()
    } finally {
      delete globals.location
    }
  }

  it('按当前 location 拼绝对地址（http → ws，含端口）', () => {
    const connection = withLocation({ protocol: 'http:', host: '192.168.1.5:10452' }, () =>
      connectWebSocket(),
    )
    connection.onerror = () => {} // 吞掉异步连接失败：本用例只关心拼出的地址
    expect(connection.url).toBe('ws://192.168.1.5:10452/api/ws')
    expect(typeof connection.send).toBe('function')
    expect(typeof connection.close).toBe('function')
    expect(connection.readyState).toBe(0) // CONNECTING：连接已发起
    connection.close()
  })

  it('https 页面得到 wss，goal 拼成 ?goal=', () => {
    const connection = withLocation({ protocol: 'https:', host: 'example.com' }, () =>
      connectWebSocket('resume-token'),
    )
    connection.onerror = () => {}
    expect(connection.url).toBe('wss://example.com/api/ws?goal=resume-token')
    connection.close()
  })

  it('无 location 的环境抛明确错误', () => {
    expect(() => connectWebSocket()).toThrow(/没有 location/)
  })
})
