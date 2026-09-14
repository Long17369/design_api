import { bus } from '@core/bus'
import { cache } from '@core/cache'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { lockManager } from '@core/locks'
import { LockSnapshot } from '@core/locks'
import { DirectModule } from '@modules/directModule'
import { WsData } from '@/types/types'
import { AutoConfig, AutoCtx, AutoDecision, DeviceState } from '@modules/autoControl'
import { autoComponents } from './components'
import { loadAutoConfig, pushHistory, sendAlarm, setControl } from './utils'

const logger = log.getLogger('AutoControlModule')

/** 阈值配置缓存 key（tag = direct_config，写库时自动失效） */
const CONFIG_CACHE_KEY = 'autoControl:config'

/** 设备历史帧最大数量（温度异常等跨帧判定用） */
const MAX_HISTORY = 10

/**
 * 自动控制模块：
 * 订阅 SENSOR_DATA → 读设备 auto 开关 → 按优先级跑组件 → 执行决策（控制/告警/落库）。
 */
export class AutoControlModule implements Closable {
  private database: Database | null = null
  private directModule: DirectModule | null = null

  /** 各设备运行状态 */
  private readonly devices = new Map<string, DeviceState>()
  /** 串行处理链，保证按时序处理 */
  private queue: Promise<void> = Promise.resolve()

  /** 事件订阅注销句柄集合（强引用监听；close 时统一注销） */
  private readonly unsubscribers: Array<() => void> = []

  constructor() {
    logger.info('自动控制模块已注册')
    this.unsubscribers.push(
      bus.onEvent('shutdown', () => {
        this.close()
      }),
      bus.onEvent('SENSOR_DATA', (data) => {
        this.enqueue(data)
      }),
    )
  }

  /** 注入数据库实例（记录告警/控制日志用） */
  public setDatabase(database: Database) {
    this.database = database
  }

  /** 注入 Direct 中间模块（读取设备状态 + 下发控制） */
  public setDirectModule(directModule: DirectModule) {
    this.directModule = directModule
  }

  /** 释放资源：统一注销所有事件订阅并清空设备状态 */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    this.devices.clear()
    this.queue = Promise.resolve()
  }

  /** 串行入队，保证按时序处理 */
  private enqueue(data: WsData): void {
    this.queue = this.queue
      .then(() => this.handle(data))
      .catch((err: unknown) => {
        logger.error('自动控制处理失败:', err)
      })
  }

  private async handle(data: WsData): Promise<void> {
    const db = this.database
    const dm = this.directModule
    const dNo = data.d_no
    if (!db || !dm || !dNo) return

    // 设备级 auto 开关：未开启则跳过
    const direct = await dm.listByDevice(dNo)
    const values = new Map(direct.map((row) => [row.config_id, row.value ?? '']))
    if (values.get('auto') !== '1') {
      logger.debug(`自动控制未开启，跳过: ${dNo}`)
      return
    }

    const state = this.getState(dNo)

    // 堵塞记忆：一旦落定（direct.blocked='1'），数据恢复也不自动解除，须手动复位
    if (values.get('blocked') === '1') {
      this.restoreBlockedLock(dNo, state)
      return
    }
    state.blocked = false

    const cfg = await this.loadConfig(db)
    const now = Date.now()
    this.trackPump(state, data, now)
    pushHistory(state.history, data, MAX_HISTORY)

    const ctx: AutoCtx = {
      d_no: dNo,
      data,
      cfg,
      state,
      now,
      inPumpGrace: this.inPumpGrace(state, cfg, now),
      values,
    }
    if (ctx.inPumpGrace) {
      logger.debug(`水泵刚启动，宽限期内跳过判定: ${dNo}`)
      return
    }

    for (const comp of autoComponents) {
      const decision = comp.evaluate(ctx)
      if (!decision) continue
      logger.info(`自动控制触发[${comp.name}]: ${dNo} ${decision.reason ?? ''}`)
      await this.execute(db, dm, ctx, comp.name, decision)
      if (decision.stop) break
    }
  }

  /**
   * 执行决策：堵塞保护（加锁 + 持久化标记） → 下发控制 → 写控制记录 → 发告警
   *
   * 注意：引擎每帧都会执行命中的决策（不做去重），幂等由组件自行保证；
   * 执行控制后即时更新 ctx.values，供同帧后续组件判断目标当前值。
   */
  private async execute(
    db: Database,
    dm: DirectModule,
    ctx: AutoCtx,
    name: string,
    decision: AutoDecision,
  ): Promise<void> {
    const reason = decision.reason ?? name
    if (decision.block) {
      await this.blockDevice(dm, ctx, reason)
    }
    if (decision.controls?.length) {
      for (const c of decision.controls) {
        await setControl(dm, db, ctx.d_no, c.target, c.value, reason)
        ctx.values.set(c.target, c.value)
      }
    }
    if (decision.alarm) {
      await sendAlarm(db, ctx.d_no, decision.alarm, reason)
    }
  }

  /**
   * 堵塞保护落定（仅首次）：
   * 记录锁定前 heat/water 快照 → 加 blocked 锁（禁止开启水泵）→ 持久化 direct.blocked='1'。
   * 之后数据恢复也不自动解除，须手动复位（POST /api/control/reset）。
   */
  private async blockDevice(dm: DirectModule, ctx: AutoCtx, reason: string): Promise<void> {
    const { d_no: dNo, state, values } = ctx
    if (state.blocked) return
    state.blocked = true

    const snapshot: LockSnapshot = {
      heat: values.get('heat') === '1' ? '1' : '0',
      water: values.get('water') === '1' ? '1' : '0',
    }
    lockManager.acquire({
      type: 'blocked',
      d_no: dNo,
      deny: { water: true },
      reason,
      snapshot,
    })
    logger.info(`堵塞保护已锁定设备 ${dNo}（手动复位前不自动解除）`)
    // 内部标记：只落库，不推 direct 通知（前端由 alarm 事件驱动横幅）
    await dm.setValue({
      config_id: 'blocked',
      value: '1',
      d_no: dNo,
      source: 'auto',
      notify: false,
    })
  }

  /** 进程重启/首帧时按持久化标记恢复堵塞锁（无快照） */
  private restoreBlockedLock(dNo: string, state: DeviceState): void {
    if (state.blocked) return
    state.blocked = true
    lockManager.acquire({ type: 'blocked', d_no: dNo, deny: { water: true }, reason: 'blocked' })
    logger.info(`设备处于堵塞状态，已恢复保护锁（等待手动复位）: ${dNo}`)
  }

  /** 获取（或初始化）某设备状态 */
  private getState(dNo: string): DeviceState {
    let state = this.devices.get(dNo)
    if (!state) {
      state = {
        pumpOn: false,
        pumpStartedAt: null,
        blocked: false,
        history: [],
        lastTotalFlow: null,
        flowUnchangedSince: null,
        flowTargetReached: false,
      }
      this.devices.set(dNo, state)
    }
    return state
  }

  /** 从上报的水泵状态(shui_beng)检测 0→1，记录启动时刻 */
  private trackPump(state: DeviceState, data: WsData, now: number): void {
    const pumpOn = data.shui_beng === '1'
    if (pumpOn && !state.pumpOn) state.pumpStartedAt = now
    state.pumpOn = pumpOn
  }

  /** 是否处于水泵启动宽限期内（仅水泵刚启动时允许宽限） */
  private inPumpGrace(state: DeviceState, cfg: AutoConfig, now: number): boolean {
    return state.pumpStartedAt !== null && now - state.pumpStartedAt < cfg.pumpStartGrace * 1000
  }

  /** 读取阈值配置（@core/cache，tag=direct_config，写库后自动失效） */
  private loadConfig(db: Database): Promise<AutoConfig> {
    return cache.remember(CONFIG_CACHE_KEY, () => loadAutoConfig(db), { tag: 'direct_config' })
  }
}
