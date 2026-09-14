# TODO / 进度清单

> 分类按**实际定位（模块 / 功能域）**组织，条目混排：`[x]` 已完成、`[ ]` 待实现。
> 维护约定：做完一项就勾上（不搬动位置）；新增项放到对应模块分类下。最后更新：2026-09-12（全部条目已逐项复审，结论直接写在条目里）。
>
> **实现路线**：自动控制引擎为**重新设计版**（组件化 + 每帧评估 + 组件自幂等 + 轻量锁通道），
> **不照搬旧项目的重机制**（`controlBus` 控制总线、决策级 `lock/unlock`、每设备配置合并、
> 事件式缓存失效等）。旧项目只作**行为参考**，实现一律走轻量路线。
>
> 参考实现：后端 `~/code/web/mysql/mysql_node_api`（`src/services/**`）、前端 `~/code/web/IoT`
> （`src/server/api.ts` 契约、`src/composables/useWebSocket.ts` 消费 WS）。

## 自动控制 · 保护组件（`src/modules/autoControl/components/`）

- [x] 堵塞保护：打散为 4 个独立判定 —— `pressureZero`(10) / `flowZero`(12) / `flowUnchanged`(14) / `tempAnomaly`(16)，命中即 `heat=0+water=0` + 持久化 `blocked` + 加锁 + 告警
- [x] 恒温保护 `tempLimit`(80)：超 `temp_max` 关加热；低于 `temp_min` 且水泵运行中才开加热（防干烧）；上限优先；幂等
- [x] 累计流量目标 `flowTarget`(70)：跨越 `total_flow_target` 关泵一次，可随累计流量回落/调大目标重新触发
- [x] `overpressure` 冷却期（已实现）：超压 → 关加热关泵 + 加 `overpressure` 锁（**锁即状态**，冷却期 = 锁的 `expiresAt`）；期满压力仍高 → **顺延**（保留原快照）；压力回落 → 解锁，行为按配置：`overpressure_delay`(20s) / `overpressure_auto_release`(1) / `overpressure_on_release`(hold|resume，默认 hold)；`delay=0` 表示不限时（只等压力回落）
- [ ] `reverseTemp` 逆温差：加热中且出水 < 进水 − Δ 持续 N 秒 → 预警；激活状态由**组件自持**（不外溢到 `DeviceState` 等上层类型），需要读取时经引擎 `ctx` 暴露的接口（不做组件间直接 import）
- [x] `pumpIdle` 水泵空转（已实现，**并入 `flow_zero` 组件**）：水泵运行中 + 瞬时流量归零持续 `pump_idle_seconds`(60s) → 关泵（引擎自动先关加热）+ 黄色告警；**不加锁、不判堵塞**、流量恢复自动解除；`pump_idle_seconds=0` 关闭该保护。原「瞬时流量归零立即判堵塞」会误伤（泵停时流量本就为 0 + 单帧抖动即上锁），已修正为「泵运行 + 去抖 + 可恢复」
- [ ] `pfMismatch` 压力流量不匹配：**暂缓** —— 等真实数据标定 X/Y 阈值后再做（「建议降功率」需设备支持调速，暂不做）
- [ ] `pidTemp` PID 控温：完整 PID + PWM 开关加热；每次切换都会下发指令，需先评估下发频率上限
- [x] 组件状态自持重构：计时/激活态已从共享 `DeviceState` 收回组件内部（`flowUnchanged` 计时、`flowTarget` 已达目标标记），`DeviceState` 只留引擎级字段（`pumpOn`/`pumpStartedAt`/`blocked`/`history`）；引擎 `close()` 统一调组件 `clearState()`
- [x] 组件 `history` 需求接口：`AutoComponent.historyLength?(ctx)`（可空实现，默认 1 帧），引擎取所有组件需求的最大值统一裁剪（`tempAnomaly` 声明 `temp1RiseCount + 1`）；`history` 仍共享

## 自动控制 · 引擎与阈值配置（`autoControl/index.ts`、`utils.ts`）

- [x] 组件化引擎：priority 顺序、每帧评估、组件自幂等、`stop` 终止、`ctx.values` 即时更新
- [x] 告警定义下沉到各组件（删除集中的 `alarmConfig.ts`）
- [x] 阈值配置读取 `loadAutoConfig`（`direct_config.default_value`）+ `sensorTemp` 工具
- [x] 水泵启动宽限期 `pump_start_grace`
- [x] ① 新增 `@core/cache`：KV + TTL + 按表 tag 失效（`remember` 读-加载-写一体），统一读取入口
- [x] ② 迁移与写穿透失效：`Database.insert/update/delete` 成功后按表名 `invalidate`；`autoControl` 阈值缓存、`sensorModule` 的 `direct_config`/`sensor_data_mapper` 缓存（共 3 处本地 TTL）已迁入
- [ ] ③ 评估后再考虑「全库中间件 / 表级缓存策略配置」这类更重的方案（当前写穿透已覆盖应用内写入路径）
- [x] 设备级配置覆盖：取值优先级 **设备 `direct` 值 > `direct_config.default_value` > 内置默认**（`buildAutoConfig` 逐帧合并设备值 → 前端改配置**立即生效**）；修复原先只读全局默认值导致「前端改配置对自动控制不生效」
- [ ] 离线告警 `sensor_offline`：轻量定时器（5s）扫描最后上报时间 → 超时告警、恢复清除；**不做**旧项目的「暂停自动控制」（本引擎由上报驱动，不会用旧数据决策）
- [ ] 设备状态同步（`source='device'`）：设备上报值与 `direct` 目标**连续 N 帧不一致**才同步；触发时**写库 + WS 告警**（不用旧项目的漂移阈值表）
- [x] 关泵连带关加热（两层防护，已实现）：① 引擎统一规则 —— 任何「关泵」动作若加热仍开，自动在其前面补一条「关加热」（按序跟踪，决策自身已关加热时不重复下发）；② 状态兜底 —— 水泵停止（**指令值或上报泵状态任一为「泵停」**）且加热仍开 → 立即关加热（不受启动宽限期影响，放在决策之后执行避免重复写库）
- [ ] 数据质量标记 `WsData.invalid`：**阈值配置化** + 多帧累计 + 防抖（不写死固定值）
- [ ] 告警类型区分：`AlarmDef` 增加 `type` 字段（组件自带），替代现在写死的 `error_msg.field3='block'`

## 锁定通道与复位（`src/core/locks/`、`directModule`）

- [x] 统一锁定通道 `@core/locks`：`acquire`/`releaseAll`/`isDenied`/快照（`getSnapshot`/`clearSnapshot`）
- [x] `DirectModule.setValue` 按锁拦截：禁止**开启水泵**，关泵不受限
- [x] 手动复位 `POST /api/control/reset`：释放锁 → 按快照恢复 heat/water → 写 `control_log` → 广播 `type:'reset'`
- [x] 锁通道自带持久化（方案 A）：新增 `device_locks` 表（`d_no`/`type`/`reason`/`deny`/`snapshot`/`expires_at`/`c_time`）+ `LockModule`（订阅 `LOCK_CHANGED` 落库、启动加载未过期锁、清理过期行）；**堵塞标记彻底移出 `direct`/`direct_config`**
- [x] WS 推送锁状态：锁变化广播 `event:'lock'`（`WsLock`：`locked`/`active`/`type`/`reason`/`expiresAt`），并补一条 `direct`（`config_id:'lock'`）兼容旧前端；前端据此显示「设备被锁定」

> 约定：组件需要保护性锁时**直接调用 `lockManager`**（锁上带快照），引擎不参与锁语义 ——
> 不引入旧项目的「决策带 `lock`/`unlock`、引擎统一执行」那套重机制。

## 设备控制 · HTTP 接口（`gateways/http/`、`modules/directModule/`、`types/api.ts`）

- [x] 数据读接口：`GET /api/{sensor|behavior|error|control}/{table|data|count|time-range}`
- [x] 设备列表：`GET /api/sensor/devices`
- [x] 指令配置/数据：`GET /api/direct/config`、`GET /api/direct/data?d_no=`、`POST /api/direct/update`
- [x] 手动控制 `POST /api/control`：`auto=1` 时拒绝手动开/关；写 direct + 下发 + WS 通知 + `control_log(manual)`
- [x] 手动复位：`POST /api/control/reset`
- [x] 前端契约：`api.ts::sendControlCommand` / `resetDeviceBlock`
- [x] `direct_config.blocked` 内部标记外泄给 `GET /api/direct/config`：**已解决** —— 配置行删除（列表回到 18 项），堵塞标记改由 `device_locks` 承担
- [x] `ErrorCode.NOT_IMPLEMENTED`：**保留**（对外错误码联合类型，先不收缩）
- [x] 旧前端接口差异：已整理成 `docs/API-CHANGES.md`（接口对照 + WS 差异 + 前端适配清单），**暂不改后端**

## 指令下发 · 设备端接口（`modules/directModule/dispatch.ts`）

- [x] 设备端接口定义独立成文件：`CONTROL_TOPIC='control/'` + `COMMAND_GROUPS`（heat/water 的 Modbus 帧）+ `buildControlMessage`
- [x] `setValue` 落库成功后下发：未登记报文的指令码（`auto`/`blocked` 等）只落库不下发；顺序 = 落库 → 下发 → `direct` 通知
- [x] `source`（manual/auto/config）与 `notify`（内部标记不推 direct 通知）语义

## 数据链路 · MQTT 入站 / 传感器 / WS 推送（`gateways/mqtt/`、`modules/sensorModule/`、`gateways/websocket/`、`modules/alarmModule/`）

- [x] MQTT 入站：连接/重连后订阅已注册主题（含启动日志）；未知主题消息 warn 忽略
- [x] 传感器模块：`SENSOR_DATA_RAW` → 派生指标（累计流量本地累加 / `heat_rate` / `avg_flow`）→ 落库 `sensor_data` → 再分发 `SENSOR_DATA`
- [x] WS `data` 推送（实时数据）、WS `direct` 通知（成功/失败）、WS `alarm`（告警 + 复位广播）
- [x] 预警补推：WS 连接时按 `device_locks`（type='blocked'）+ `error_msg(field3='block')` 定向补推（id 复用 `alarm_${d_no}_${c_time}` 供前端去重）
- [x] 预警补推数据源改造：已改为按 `device_locks` 查询（不再依赖 `direct.blocked`）
- [x] WS 定向推送 `goal` 与重连复用、`WS_CLIENT_CONNECTED` / `WS_MESSAGE_IN` 事件
- [x] `WS_MESSAGE_IN`：保持预留（前端不发 WS 上行，暂无需求）
- [x] 实时数据推送节流/合并：**不做**（按帧广播已足够，后续确有压力再加）

## 数据库与配置（`core/database/`、`core/config/`）

- [x] 统一操作接口（`query`/`executeQuery`/`count`/`timeRange`/`insert`/`update`/`delete`）+ 表列白名单
- [x] 自动建库建表、`information_schema` + `SHOW COLUMNS` 增量补列
- [x] `seeds` 幂等初始化（只补缺失、不覆盖删除）；「列定义 + 值行」列表形式（490 → 147 行）
- [x] 配置加载：`fs.readFileSync` + `JSON.parse` + Ajv（`useDefaults`，`timezone` 默认 `'Z'`）
- [ ] 累计流量改为持久化：现为**进程内累加、重启归零**（定量供水的语义限制）

## 工程 / 工具 / 依赖

- [x] 运行与校验：`tsx` 运行（勿用 ts-node）、`pnpm type-check` / `lint` / `format`
- [x] 类型出口统一：`MQTTMessageOut` 以 `src/types/types.ts` 为唯一定义来源；`types.ts` 属对外契约保持稳定
- [x] 清理：删除空 `runtime/` 目录、移除 `test` 占位脚本
- [ ] 测试工程化：引入 **vitest**，把 `tmp/` 里的关键单测（幂等 / 阈值 / 流量目标 / 告警工具）收进仓库
- [x] `MQTT_MESSAGE`：**保留**声明 —— 骨架期设计的「入站消息经 bus 广播」事件，后改为 topicHandlers 直接处理后闲置；将来做统一入站分发可复用（此处备注来历，不删）
- [x] `errorMessage`：**暂留** —— 为后续「服务器驱动化」重构预留的事件通道，届时再定去留
- [x] 死依赖：**不动**（`uuid` / `dotenv` / `nodemon` / `ts-node` 保留；`jiti` 为 ESLint 加载 TS 配置所需，勿删）
