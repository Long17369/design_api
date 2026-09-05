import { Server } from 'http'
import { WebSocketServer as WServer, WebSocket } from 'ws'
import { log } from '@core/logger'
import { EventBus } from '@core/bus'
import { WsAlarm, WsEventType, WsMessage, WsMessageData } from '@/types/types'

const logger = log.get_logger('WebSocketServer')

export class WebSocketServer {
  private wss: WServer | null = null
  private clients: Set<WebSocket> = new Set()
  private bus: EventBus

  constructor(bus: EventBus) {
    this.bus = bus
  }

  public attach(server: Server) {
    this.wss = new WServer({ server: server })

    this.wss.on('connection', async (ws, req) => {
      const ip = req.socket.remoteAddress || 'unknown'
      logger.info(`WebSocket 客户端已连接: ${ip}`)
      this.clients.add(ws)

      // 发送欢迎消息确认连接
      ws.send(
        JSON.stringify({
          event: 'connected',
          data: { message: 'WebSocket 连接成功', timestamp: new Date().toISOString() },
        }),
      )

      // 补推持久化的堵塞预警（前端断开重连后恢复实时横幅；id 与 t_error_msg.c_time 绑定，前端去重）
      await this.pushBlockedAlarms(ws)

      ws.on('close', () => {
        logger.info(`WebSocket 客户端已断开: ${ip}`)
        this.clients.delete(ws)
      })

      ws.on('error', (err) => {
        logger.error('WebSocket 客户端错误:', err)
        this.clients.delete(ws)
      })

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          logger.debug(`收到客户端消息:`, msg)
          // 预留：处理客户端请求（如请求特定设备数据）
        } catch {
          logger.debug('收到非 JSON 客户端消息，忽略')
        }
      })
    })

    this.bus.onEvent('WSMessageOUT', (message) => {
      this.broadcast(message.event, message.data)
    })

    logger.info('WebSocket 服务已启动')
  }

  /** 向所有已连接客户端广播消息 */
  private broadcast(event: WsEventType, data: WsMessageData) {
    if (!this.wss) return

    const message: WsMessage = { event, data }
    const text = JSON.stringify(message)

    let sent = 0
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text)
        sent++
      }
    }

    if (sent > 0) {
      logger.debug(`广播事件 "${event}" 至 ${sent} 个客户端`)
    }
  }

  /**
   * 补推所有处于堵塞状态的设备预警（WS 连接时调用）
   * id 复用 t_error_msg 中预警发生的 c_time，与首次推送一致，前端据此去重不重复添加
   * // TODO: 移入 AlarmModule
   */
  private async pushBlockedAlarms(ws: WebSocket) {
    try {
      const blockedRows = (await query(
        "SELECT d_no FROM t_direct WHERE config_id = 'blocked' AND value = '1'",
      )) as Array<{ d_no: string }>
      for (const row of blockedRows) {
        const errs = (await query(
          `SELECT DATE_FORMAT(c_time, '%Y-%m-%d %H:%i:%s') AS c_time_str, field1
           FROM t_error_msg WHERE d_no = ? AND field3 = 'block' ORDER BY id DESC LIMIT 1`,
          [row.d_no],
        )) as Array<{ c_time_str: string; field1: string }>
        const latest = errs[0]
        if (latest) {
          const alarm: WsAlarm = {
            id: `alarm_${row.d_no}_${latest.c_time_str}`,
            d_no: row.d_no,
            type: 'alarm',
            message: latest.field1,
            timestamp: latest.c_time_str,
          }
          this.sendTo(ws, 'alarm', alarm)
          logger.info(`补推堵塞预警: ${row.d_no}`)
        }
      }
    } catch (err) {
      logger.error('补推堵塞预警失败:', err)
    }
  }

  /** 向单个客户端发送消息 */
  public sendTo(ws: WebSocket, event: WsEventType, data: WsMessageData) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }))
    }
  }
}

// TODO: last

function query(sql: string, params?: (string | number)[]) {
  logger.warn('数据库查询函数 query() 尚未实现，返回空结果, 查询SQL:', sql, '参数:', params)
  return new Promise((resolve) => {
    resolve([]) // TODO: 实现数据库查询
  })
}
