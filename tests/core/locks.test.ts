import { beforeEach, describe, expect, it } from 'vitest'
import { bus } from '@core/bus'
import { lockManager } from '@core/locks'

const D_NO = 'D1'

describe('LockManager.reset()（进程内重启对齐真实重启语义）', () => {
  beforeEach(() => {
    lockManager.reset()
  })

  it('清空全部锁与锁定前快照', () => {
    lockManager.acquire({
      type: 'blocked',
      d_no: D_NO,
      deny: { water: true },
      reason: '堵塞',
      snapshot: { heat: '1', water: '0' },
    })
    expect(lockManager.isLocked(D_NO)).toBe(true)
    expect(lockManager.getSnapshot(D_NO)).toEqual({ heat: '1', water: '0' })

    lockManager.reset()

    expect(lockManager.getActive(D_NO)).toEqual([])
    expect(lockManager.isLocked(D_NO)).toBe(false)
    expect(lockManager.get(D_NO, 'blocked')).toBeUndefined()
    expect(lockManager.getSnapshot(D_NO)).toBeUndefined()
    expect(lockManager.listActive()).toEqual([])
  })

  it('只清内存、不广播（持久化记录由 LockModule 重启后 restore）', () => {
    const changes: unknown[] = []
    const stop = bus.onEvent('LOCK_CHANGED', (change) => changes.push(change))
    lockManager.acquire({ type: 'overpressure', d_no: D_NO, deny: { water: true } })
    const before = changes.length

    lockManager.reset()
    stop()

    expect(before).toBe(1) // acquire 广播一次
    expect(changes).toHaveLength(before) // reset 不产生 LOCK_CHANGED
  })

  it('清空后仍可正常加锁', () => {
    lockManager.reset()
    lockManager.acquire({ type: 'blocked', d_no: D_NO, deny: { water: true } })
    expect(lockManager.isDenied(D_NO, 'water')).toBe(true)
  })
})
