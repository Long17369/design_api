import { WsMessage } from '@/types/types'

/** 连接建立时下发的欢迎事件名（非 WsEventType 业务事件） */
export const WELCOME_EVENT = 'connected'

/** 连接建立时下发的欢迎消息（携带后端为该连接分配的 goal token） */
export function buildWelcomeMessage(goal: string) {
  return {
    goal,
    event: WELCOME_EVENT,
    data: { message: 'WebSocket 连接成功', timestamp: new Date().toISOString() },
  }
}

/** 序列化下发给客户端的前端契约消息（不含后端路由字段 goal） */
export function serializeMessage(message: WsMessage): string {
  return JSON.stringify(message)
}

/** 从连接 URL 的 query 中解析旧 goal token（无 / 空则 null） */
export function parseGoalFromUrl(url?: string): string | null {
  if (!url) return null
  try {
    const token = new URL(url, 'http://localhost').searchParams.get('goal')
    return token && token.length > 0 ? token : null
  } catch {
    return null
  }
}
