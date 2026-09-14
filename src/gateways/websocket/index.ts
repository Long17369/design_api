import { Server } from 'http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer as WServer, WebSocket } from 'ws'
import { log } from '@core/logger'
import { bus } from '@core/bus'
import { Closable } from '@core/lifecycle'
import { WsMessage } from '@/types/types'
import { WsPush } from '@gateways/websocket'
import { WS_PATH } from '@gateways/utils'
import { buildWelcomeMessage, parseGoalFromUrl, serializeMessage } from './utils'

const logger = log.getLogger('WebSocketServer')

export class WebSocketServer implements Closable {
  private wss: WServer | null = null
  /** 已连接客户端 → 后端为该连接分配的 goal token */
  private readonly clients = new Map<WebSocket, string>()
  /** goal token → 客户端（定向推送用） */
  private readonly goalIndex = new Map<string, WebSocket>()

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('WebSocket 网关已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('WS_MESSAGE_OUT', (push) => {
        this.dispatch(push)
      }),
    )
  }

  /** 挂载到 HTTP server（main.ts 中在 http.bindServer() 之后调用） */
  public attach(server: Server): void {
    this.wss = new WServer({
      server,
      // 固定服务路径：只有 `${WS_PATH}`（可带 query，如 ?goal=xxx）能升级，其它路径握手被拒
      path: WS_PATH,
      // 握手校验：URL ?goal=<旧token> 若仍被活跃连接占用，则拒绝握手
      verifyClient: (info, done) => {
        const token = parseGoalFromUrl(info.req.url)
        if (token && this.isGoalActive(token)) {
          logger.warn(`拒绝重连：goal=${token} 仍有活跃连接`)
          done(false, 403, 'Goal already in use')
          return
        }
        done(true)
      },
    })

    this.wss.on('connection', async (ws, req) => {
      const ip = req.socket.remoteAddress || 'unknown'
      // 携带旧 token 且未被占用则复用（先清理其残留的非活跃映射），否则分配新 token
      const oldGoal = parseGoalFromUrl(req.url)
      const stale = oldGoal ? this.goalIndex.get(oldGoal) : undefined
      if (stale) this.removeClient(stale)
      const goal = oldGoal ?? randomUUID()
      this.clients.set(ws, goal)
      this.goalIndex.set(goal, ws)
      logger.info(
        `${oldGoal ? '复用旧 goal 重连' : 'WebSocket 客户端已连接'}: ${ip} (goal=${goal})`,
      )

      // 下发欢迎消息（携带 goal，供业务侧定向推送）
      ws.send(JSON.stringify(buildWelcomeMessage(goal)))

      // 通知业务侧：客户端已连接（携带 goal，可用于后续定向推送；如补推堵塞预警）
      bus.emitEvent('WS_CLIENT_CONNECTED', { goal, ip })

      ws.on('close', () => {
        logger.info(`WebSocket 客户端已断开: ${ip} (goal=${goal})`)
        this.removeClient(ws)
      })

      ws.on('error', (err) => {
        logger.error('WebSocket 客户端错误:', err)
        this.removeClient(ws)
      })

      ws.on('message', (data) => {
        let payload: unknown
        try {
          payload = JSON.parse(data.toString())
        } catch {
          logger.debug('收到非 JSON 客户端消息，忽略')
          return
        }
        logger.debug(`收到客户端消息 (goal=${goal}):`, payload)
        bus.emitEvent('WS_MESSAGE_IN', { goal, payload })
      })
    })

    logger.info(`WebSocket 服务已启动（路径 ${WS_PATH}）`)
  }

  /**
   * 释放资源：退订 WS_MESSAGE_OUT、断开所有客户端并关闭 wss
   */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    for (const client of this.clients.keys()) {
      client.terminate()
    }
    this.clients.clear()
    this.goalIndex.clear()
    this.wss?.close()
    this.wss = null
  }

  /** 分发推送：带 goal 定向，无 goal 广播；下发给客户端的只有 message（不含 goal） */
  private dispatch(push: WsPush): void {
    const { goal, message } = push
    if (goal) {
      const ws = this.goalIndex.get(goal)
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn(`未找到 goal=${goal} 对应的 WebSocket 客户端，消息已丢弃`)
        return
      }
      ws.send(serializeMessage(message))
      logger.debug(`定向推送事件 "${message.event}" 至 goal=${goal}`)
      return
    }

    this.broadcast(message)
  }

  /** 向所有已连接客户端广播消息 */
  private broadcast(message: WsMessage): void {
    const text = serializeMessage(message)

    let sent = 0
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text)
        sent++
      }
    }

    if (sent > 0) {
      logger.debug(`广播事件 "${message.event}" 至 ${sent} 个客户端`)
    }
  }

  /** 注销客户端并回收 goal 映射 */
  private removeClient(ws: WebSocket): void {
    const goal = this.clients.get(ws)
    this.clients.delete(ws)
    if (goal) this.goalIndex.delete(goal)
  }

  /** goal 是否被活跃连接占用 */
  private isGoalActive(goal: string): boolean {
    const ws = this.goalIndex.get(goal)
    return !!ws && ws.readyState === WebSocket.OPEN
  }
}
