import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bus } from '@core/bus'
import { lockManager } from '@core/locks'
import { LockModule } from '@modules/lockModule'
import { WsPush } from '@gateways/websocket'

const GOAL = 'goal-backfill'
const D_NO = 'D1'

/** 收集 WS 推送（LockModule 经 bus 发出） */
function collect(): { pushes: WsPush[]; stop: () => void } {
  const pushes: WsPush[] = []
  const stop = bus.onEvent('WS_MESSAGE_OUT', (push) => {
    pushes.push(push)
  })
  return { pushes, stop }
}

/** 模拟一个客户端连接（推送兜底字段：goal 必填） */
const connect = () => bus.emitEvent('WS_CLIENT_CONNECTED', { goal: GOAL, ip: '127.0.0.1' })

describe('LockModule 上线补推（WS_CLIENT_CONNECTED）', () => {
  let lockModule: LockModule
  let stopCollect: (() => void) | null = null

  beforeEach(() => {
    lockManager.releaseAll(D_NO)
    // 不注入 Database：补推只依赖内存锁通道，落库能力不参与本用例
    lockModule = new LockModule()
  })

  afterEach(() => {
    stopCollect?.()
    stopCollect = null
    lockModule.close()
    lockManager.releaseAll(D_NO)
  })

  /** 取一次「上线补推」的推送（丢弃之前的加锁广播） */
  function backfill(after?: () => void): WsPush[] {
    const { pushes, stop } = collect()
    after?.()
    pushes.length = 0
    connect()
    stop()
    return pushes
  }

  it('已锁设备：定向补推 lock + direct（config_id=lock）', () => {
    const pushes = backfill(() => {
      lockManager.acquire({ type: 'blocked', d_no: D_NO, deny: { water: true }, reason: '堵塞' })
    })

    expect(pushes).toHaveLength(2)
    for (const push of pushes) {
      expect(push.goal).toBe(GOAL)
    }
    expect(pushes[0]?.message).toMatchObject({
      event: 'lock',
      data: { d_no: D_NO, locked: true, active: ['blocked'] },
    })
    expect(pushes[1]?.message).toMatchObject({
      event: 'direct',
      data: { d_no: D_NO, config_id: 'lock', value: '1', success: true },
    })
  })

  it('限时锁：补推的 active 含类型（不含 lock 变化的 type/reason 明细）', () => {
    const pushes = backfill(() => {
      lockManager.acquire({
        type: 'overpressure',
        d_no: D_NO,
        deny: { water: true },
        reason: '压力过高',
        expiresAt: Date.now() + 60_000,
      })
    })

    expect(pushes).toHaveLength(2)
    const lock = pushes[0]?.message.data as { locked: boolean; active: string[]; type?: string }
    expect(lock.locked).toBe(true)
    expect(lock.active).toEqual(['overpressure'])
    expect(lock.type).toBeUndefined()
  })

  it('无锁设备：不补推', () => {
    expect(backfill()).toHaveLength(0)
  })

  it('锁已过期：不补推', () => {
    const pushes = backfill(() => {
      lockManager.acquire({
        type: 'overpressure',
        d_no: D_NO,
        deny: { water: true },
        expiresAt: Date.now() - 1000,
      })
    })

    expect(pushes).toHaveLength(0)
  })
})
