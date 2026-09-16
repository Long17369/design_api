import { bus } from '@core/bus'
import { cache } from '@core/cache'
import { Config } from '@core/config'
import type { ConfigApplyStatus, ConfigChange, ConfigSectionName } from '@core/config'
import { applyConfigChanges, diffConfigSections } from '@core/config/utils'
import { lockManager } from '@core/locks'
import { Database } from '@core/database'
import type { Closable } from '@core/lifecycle'
import { log } from '@core/logger'
import { HttpServer, MqttGateway, WebSocketServer } from '@gateways'
import { API_BASE, WS_PATH } from '@gateways/utils'
import { AlarmModule, AutoControlModule, DirectModule, LockModule, SensorModule } from '@modules'

const logger = log.getLogger('Server')

/** 无变更/未启动时的热更新结果 */
const NO_CHANGE: ReloadResult = {
  changed: [],
  applied: false,
  appliedSections: [],
  failedSections: [],
  pendingRestart: [],
}

/** 热更新结果 */
export interface ReloadResult {
  /** 有变更的 section（为空表示配置未变） */
  changed: ConfigChange[]
  /** 是否至少有一个 section 已生效 */
  applied: boolean
  /** 已按新配置生效的 section */
  appliedSections: ConfigSectionName[]
  /** 未生效的 section（应用失败 / 超时未回报） */
  failedSections: ConfigSectionName[]
  /** 不可热更、需完整 `restart()` 才能生效的 section（如 `port` / `database`） */
  pendingRestart: ConfigSectionName[]
}

/** 服务地址（CLI `u` 命令展示） */
export interface ServiceEndpoint {
  /** 服务名（HTTP / WebSocket / MQTT / MySQL） */
  name: string
  /** `listen` = 本服务监听；`connect` = 本服务连接的依赖 */
  role: 'listen' | 'connect'
  /** 地址 */
  url: string
}

/**
 * 服务编排器：装配并启动全部运行期组件（配置 / 数据库 / 网关 / 模块）。
 *
 * 只负责「装配 → 启动 → 关停 / 重启」这几件服务内的事；进程级职责
 * （信号监听、兜底强退）留在 CLI 入口 `main.ts`。
 *
 * - `new Server(configPath)`：配置路径由调用方（CLI 入口）给出；
 * - `start()`：按依赖顺序装配 `Config` → `Database` → 网关（MQTT / HTTP / WS）→ 模块，
 *   并开始监听端口；重复调用直接忽略；
 * - `stop(reason)`：广播 `shutdown` 事件，各组件（构造时订阅）自行 `close()` 释放资源；
 * - `restart()`：进程内重建 —— 关停全部组件（等释放完成后）重新装配并启动；
 * - `reloadConfig()`：配置热更新 —— 重新读配置、比对差异，并广播 `CONFIG_CHANGED`
 *   由各 section 的归属组件自行应用，等回报后汇总结果。
 *
 * 上述方法供 CLI 调用，暂未接入任何 HTTP 路由。
 */
export class Server {
  private readonly configPath: string
  private config: Config | null = null
  private database: Database | null = null
  private mqtt: MqttGateway | null = null
  private http: HttpServer | null = null
  private webSocket: WebSocketServer | null = null
  private directModule: DirectModule | null = null
  private lockModule: LockModule | null = null
  private sensorModule: SensorModule | null = null
  private autoControl: AutoControlModule | null = null
  private alarmModule: AlarmModule | null = null

  private started = false
  private stopped = false

  /** @param configPath 配置文件路径（支持 `@root/...` 别名，如 `@root/config.json`） */
  constructor(configPath: string) {
    this.configPath = configPath
  }

  /** 装配并启动服务 */
  public async start(): Promise<void> {
    if (this.started) {
      logger.warn('服务已启动，忽略重复的 start()')
      return
    }
    this.started = true

    const config = new Config(this.configPath)
    this.config = config

    // 各模块无参构造；运行期协作对象（配置/数据库/server）经 setConfig/setDatabase/attach 注入
    const database = new Database()
    this.database = database
    await database.setConfig(config.database)

    // 1. 启动网关（将外部协议转为 Bus 事件）
    const mqtt = new MqttGateway()
    this.mqtt = mqtt
    mqtt.setConfig(config.mqtt)

    const http = new HttpServer()
    this.http = http
    http.setDatabase(database)

    const directModule = new DirectModule()
    this.directModule = directModule
    directModule.setDatabase(database)
    http.setDirectModule(directModule)

    const httpServer = http.bindServer()

    const webSocket = new WebSocketServer()
    this.webSocket = webSocket
    webSocket.attach(httpServer)

    httpServer.listen(config.port, () => {
      logger.info(`HTTP Server 已启动，监听端口 ${config.port}`)
    })

    // 2. 注册所有模块（构造时订阅 bus 'shutdown' 事件）
    // 锁定模块先注册：尽早恢复持久化锁，避免重启后保护锁尚未生效
    const lockModule = new LockModule()
    this.lockModule = lockModule
    lockModule.setDatabase(database)

    const sensorModule = new SensorModule()
    this.sensorModule = sensorModule
    sensorModule.setDatabase(database)
    sensorModule.setConfig(config.sensor)

    const autoControl = new AutoControlModule()
    this.autoControl = autoControl
    autoControl.setDatabase(database)
    autoControl.setDirectModule(directModule)

    const alarmModule = new AlarmModule()
    this.alarmModule = alarmModule
    alarmModule.setDatabase(database)
  }

  /**
   * 触发优雅关闭：标准事件通知 —— 各模块（构造时订阅）收到 'shutdown' 后自行 close 释放资源。
   * 兜底强退（超时 `process.exit`）由调用方（CLI 入口）负责。
   */
  public stop(reason = 'manual'): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    logger.info(`正在关闭服务... (${reason})`)
    bus.emitEvent('shutdown', { reason })
  }

  /**
   * 进程内重启：关停全部组件并等其释放完成 → 重新装配 → 启动。
   *
   * 与 `stop()` 的差别：`stop()` 是「为进程退出而关停」，不等各组件完成（由 `main.ts`
   * 的兜底超时保证退出）；`restart()` 需要**确定的完成信号**，故逐个 `await close()`。
   * 各组件 `close()` 幂等，且本方法不广播 `shutdown` 事件，因此不会与订阅关闭重复释放。
   *
   * 组件之外还有**进程级单例**（缓存 / 锁通道：随进程存活、不参与 close），此处显式重置，
   * 让进程内重启用起来与真实进程重启一致 —— 锁的持久化记录不动，由重建后的 `LockModule`
   * 从 `device_locks` 恢复。
   */
  public async restart(): Promise<void> {
    if (!this.started || this.stopped) {
      logger.warn('服务未启动或已停止，忽略 restart()')
      return
    }
    logger.info('正在重启服务（进程内重建）...')
    await this.closeAll()
    this.reset()
    this.resetProcessSingletons()
    await this.start()
    logger.info('服务重启完成')
  }

  /** 重置进程级单例（不随组件 close 清空的内存态）：缓存 + 锁通道（含锁定前快照） */
  private resetProcessSingletons(): void {
    cache.clear()
    lockManager.reset()
  }

  /**
   * 各服务地址（CLI `u` 命令展示）。
   *
   * 本服务监听的 HTTP / WebSocket 地址由 `@gateways/utils` 的 `API_BASE` / `WS_PATH`
   * 派生（对外前缀的唯一来源）；MQTT / MySQL 属于本服务连接的依赖，取当前生效配置。
   */
  public endpoints(): ServiceEndpoint[] {
    const endpoints: ServiceEndpoint[] = []
    const port = this.config?.port
    if (port !== undefined) {
      endpoints.push({ name: 'HTTP', role: 'listen', url: `http://localhost:${port}${API_BASE}` })
      endpoints.push({ name: 'WebSocket', role: 'listen', url: `ws://localhost:${port}${WS_PATH}` })
    }
    const mqtt = this.config?.mqtt
    if (mqtt) {
      endpoints.push({
        name: 'MQTT',
        role: 'connect',
        url: `mqtt://${mqtt.mqtt_host}:${mqtt.mqtt_port}`,
      })
    }
    const database = this.config?.database
    if (database) {
      endpoints.push({
        name: 'MySQL',
        role: 'connect',
        url: `mysql://${database.host}:${database.port}/${database.database_name}`,
      })
    }
    return endpoints
  }

  /**
   * 配置热更新：重新读取配置文件 → 比对差异 → 广播 `CONFIG_CHANGED` 交由归属组件自行应用
   * → 等回报（超时按未生效）→ 汇总结果。
   *
   * 职责边界：Server **只广播变更、不越权代改** —— section 清单与归属（`owner`）来自各组件的
   * 自行注册（`@core/config::registerConfigSection`），具体怎么用由归属组件负责
   * （`mqtt` → `MqttGateway.setConfig()` 重连并重订阅；`port` / `database` → 标记
   * `restart-required`，需完整 `restart()`）。
   *
   * `this.config` 只写回**已生效**的 section（未生效的保持旧值）⇒ 下次 diff 仍能发现它，
   * 不会因「广播过了」而漏报。
   *
   * TODO（热更新尚未做全）：`@core/cache` / `@core/locks` 等**进程级单例**在 `restart()` 时
   * 不会重置，与真实进程重启行为不同，需评估是否由归属模块在 `restart()` 时显式清理。
   */
  public async reloadConfig(): Promise<ReloadResult> {
    const current = this.config
    if (!current) {
      logger.warn('服务未启动，忽略 reloadConfig()')
      return { ...NO_CHANGE }
    }
    const next = new Config(this.configPath)
    const changed = diffConfigSections(current, next)

    if (changed.length === 0) {
      logger.info('配置热更新：无变更')
      return { ...NO_CHANGE }
    }

    logger.info(
      `配置热更新：检测到变更 ${changed
        .map((item) => `${item.section}(${item.owner})`)
        .join(', ')}，广播 CONFIG_CHANGED 由归属组件自行应用`,
    )
    const results = await applyConfigChanges(changed, next)

    const pick = (status: ConfigApplyStatus): ConfigSectionName[] =>
      [...results].filter(([, value]) => value === status).map(([section]) => section)
    const appliedSections = pick('applied')
    const failedSections = pick('failed')
    const pendingRestart = pick('restart-required')

    // 只写回已生效的 section：未生效的下次 reload 仍会 diff 出来
    const target = current as unknown as Record<string, unknown>
    const source = next as unknown as Record<string, unknown>
    for (const section of appliedSections) target[section] = source[section]

    logger.info(
      `配置热更新完成：已生效 [${appliedSections.join(', ') || '无'}]` +
        (pendingRestart.length > 0 ? `；需 restart() [${pendingRestart.join(', ')}]` : '') +
        (failedSections.length > 0 ? `；未生效 [${failedSections.join(', ')}]` : ''),
    )
    return {
      changed,
      applied: appliedSections.length > 0,
      appliedSections,
      failedSections,
      pendingRestart,
    }
  }

  /** 关停全部组件并等其释放完成（顺序与启动相反；数据库最后关，避免模块往已关闭的连接写） */
  private async closeAll(): Promise<void> {
    const components: Array<Closable | null> = [
      this.alarmModule,
      this.autoControl,
      this.sensorModule,
      this.lockModule,
      this.webSocket,
      this.directModule,
      this.http,
      this.mqtt,
      this.database,
    ]
    for (const component of components) {
      if (!component) continue
      try {
        await component.close()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`组件关闭失败（重启继续）: ${message}`)
      }
    }
  }

  /** 清空组件引用与状态标志（重新装配前调用） */
  private reset(): void {
    this.config = null
    this.database = null
    this.mqtt = null
    this.http = null
    this.webSocket = null
    this.directModule = null
    this.lockModule = null
    this.sensorModule = null
    this.autoControl = null
    this.alarmModule = null
    this.started = false
    this.stopped = false
  }
}
