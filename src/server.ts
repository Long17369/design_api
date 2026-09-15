import { bus } from '@core/bus'
import { Config } from '@core/config'
import type { ConfigChange } from '@core/config'
import { diffConfigSections } from '@core/config/utils'
import { Database } from '@core/database'
import type { Closable } from '@core/lifecycle'
import { log } from '@core/logger'
import { HttpServer, MqttGateway, WebSocketServer } from '@gateways'
import { AlarmModule, AutoControlModule, DirectModule, LockModule, SensorModule } from '@modules'

const logger = log.getLogger('Server')

/** 热更新结果 */
export interface ReloadResult {
  /** 有变更的 section（为空表示配置未变） */
  changed: ConfigChange[]
  /** 是否已把变更应用到组件（当前恒为 false，应用逻辑待实现） */
  applied: boolean
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
 * - `reloadConfig()`：配置热更新 —— 重新读配置并比对差异（应用逻辑待实现，见方法内 TODO）。
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
   */
  public async restart(): Promise<void> {
    if (!this.started || this.stopped) {
      logger.warn('服务未启动或已停止，忽略 restart()')
      return
    }
    logger.info('正在重启服务（进程内重建）...')
    await this.closeAll()
    this.reset()
    await this.start()
    logger.info('服务重启完成')
  }

  /**
   * 配置热更新：重新读取配置文件并与当前配置比对，返回变更的 section（按归属组件标注）。
   *
   * 本次只做「重新读文件 + 计算 diff + 返回差异」，**不触碰任何组件** ——
   * section 清单与归属（`owner`）来自各组件的自行注册（`@core/config::registerConfigSection`），
   * 应用逻辑由各 section 的归属组件自行负责，Server 不越权代改。
   *
   * TODO（热更新尚未做全）：
   * 1. **通知机制**：Server 只广播变更（如 bus 新增 `CONFIG_CHANGED`），归属组件订阅后自行应用；
   * 2. **各 section 的应用方式**：
   *    - `mqtt` → `MqttGateway.setConfig()`（换 broker 需重连并重订阅主题）；
   *    - `database` → `Database.setConfig()`（重连，需先确认无在途写入）；
   *    - `port` → **不可热更**（HTTP 监听需重建 socket），只能按「需完整 `restart()`」处理；
   * 3. **`this.config` 的更新时机**：待各 section 确认应用成功后再更新，否则下次 diff 会漏报
   *    （当前一律不更新，保持「当前配置 = 实际生效配置」）；
   * 4. **进程级单例**（`@core/cache` / `@core/locks`）在**进程内重启**时不会重置，与真实
   *    进程重启行为不同，需评估是否由归属模块在 `restart()` 时显式清理。
   */
  public reloadConfig(): ReloadResult {
    if (!this.config) {
      logger.warn('服务未启动，忽略 reloadConfig()')
      return { changed: [], applied: false }
    }
    const current = this.config
    const next = new Config(this.configPath)
    const changed = diffConfigSections(current, next)

    if (changed.length === 0) {
      logger.info('配置热更新：无变更')
      return { changed: [], applied: false }
    }
    logger.warn(
      `配置热更新：检测到变更 ${changed
        .map((item) => `${item.section}(${item.owner})`)
        .join(', ')}；应用逻辑待实现，本次未生效`,
    )
    return { changed, applied: false }
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
