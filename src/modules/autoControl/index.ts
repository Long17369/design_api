import { bus } from '@core/bus'
import { log } from '@core/logger'
import { Closable } from '@core/lifecycle'
import { Database } from '@core/database'
import { DirectModule } from '@modules/directModule'
import { WsData } from '@/types/types'
import { AutoConfig, AutoCtx, AutoDecision, DeviceState } from '@modules/autoControl'
import { autoComponents } from './components'
import { loadAutoConfig, sendAlarm, setControl } from './utils'

const logger = log.getLogger('AutoControlModule')

/** 阈值配置缓存有效期(ms) */
const CONFIG_TTL = 60_000

/**
 * 自动控制模块：
 * 订阅 SENSOR_DATA → 读设备 auto 开关 → 按优先级跑组件 → 执行决策（控制/告警/落库）。
 */
export class AutoControlModule implements Closable {
  private database: Database | null = null
  private directModule: DirectModule | null = null

  /** 各设备运行状态 */
  private readonly devices = new Map<string, DeviceState>()
  private configCache: { at: number; value: AutoConfig } | null = null
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

  /** 释放资源：统一注销所有事件订阅并清空缓存 */
  public close(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    this.devices.clear()
    this.configCache = null
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

    const cfg = await this.loadConfig(db)
    const now = Date.now()
    const state = this.getState(dNo)
    this.trackPump(state, data, now)

    const ctx: AutoCtx = {
      d_no: dNo,
      data,
      cfg,
      state,
      now,
      inPumpGrace: this.inPumpGrace(state, cfg, now),
    }
    if (ctx.inPumpGrace) {
      logger.debug(`水泵刚启动，宽限期内跳过判定: ${dNo}`)
      return
    }

    for (const comp of autoComponents) {
      const decision = comp.evaluate(ctx)
      if (!decision) {
        state.active.delete(comp.id)
        continue
      }
      // 边沿触发：仅在「未触发 → 触发」时执行一次
      if (state.active.has(comp.id)) {
        if (decision.stop) break
        continue
      }
      state.active.add(comp.id)
      logger.info(`自动控制触发[${comp.name}]: ${dNo} ${decision.reason ?? ''}`)
      await this.execute(db, dm, ctx, comp.name, decision)
      if (decision.stop) break
    }
  }

  /** 执行决策：下发控制 + 写控制记录 + 发告警 */
  private async execute(
    db: Database,
    dm: DirectModule,
    ctx: AutoCtx,
    name: string,
    decision: AutoDecision,
  ): Promise<void> {
    const reason = decision.reason ?? name
    if (decision.controls?.length) {
      for (const c of decision.controls) {
        await setControl(dm, db, ctx.d_no, c.target, c.value, reason)
      }
    }
    if (decision.alarmCode) {
      await sendAlarm(db, ctx.d_no, decision.alarmCode, reason)
    }
  }

  /** 获取（或初始化）某设备状态 */
  private getState(dNo: string): DeviceState {
    let state = this.devices.get(dNo)
    if (!state) {
      state = { pumpOn: false, pumpStartedAt: null, active: new Set() }
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

  /** 读取阈值配置（带 TTL 缓存） */
  private async loadConfig(db: Database): Promise<AutoConfig> {
    const now = Date.now()
    if (this.configCache && now - this.configCache.at < CONFIG_TTL) return this.configCache.value
    const value = await loadAutoConfig(db)
    this.configCache = { at: now, value }
    return value
  }
}
