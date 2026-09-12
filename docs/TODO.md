# TODO / 进度清单

> 分类按**实际定位（模块 / 功能域）**组织，条目混排：`[x]` 已完成、`[ ]` 待实现。
> 维护约定：做完一项就勾上（不搬动位置）；新增项放到对应模块分类下。最后更新：2026-09-12。
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
- [ ] `overpressure` 冷却期：超压 → 关泵 + 进入冷却期（`overpressure_delay` 秒）→ 期满且压力回落自动恢复开泵。计时状态放 `DeviceState`，需要锁时**直接使用 `@core/locks`**
- [ ] `reverseTemp` 逆温差：加热中且出水 < 进水 − Δ 持续 N 秒 → 预警；激活状态放 `DeviceState` 供 `tempLimit` 读取（不做组件间直接 import）
- [ ] `pumpIdle` 水泵空转：水泵开 + 流量归零持续 N 秒 → 关泵 + 告警（先不加锁，确需再议）
- [ ] `leak` 严重泄漏：水泵开 + 压力骤降 + 流量归零持续 N 秒 → 关泵 + 红色告警（先不加锁）
- [ ] `pfMismatch` 压力流量不匹配：窗口内流量降 > X% 且压力升 > Y% → 预警（可选关泵）；「建议降功率」需设备支持调速，暂不做
- [ ] `pidTemp` PID 控温：按 `pid_cycle` PWM 开关加热；注意每次切换都会下发指令，需评估下发频率上限

## 自动控制 · 引擎与阈值配置（`autoControl/index.ts`、`utils.ts`）

- [x] 组件化引擎：priority 顺序、每帧评估、组件自幂等、`stop` 终止、`ctx.values` 即时更新
- [x] 告警定义下沉到各组件（删除集中的 `alarmConfig.ts`）
- [x] 阈值配置读取 `loadAutoConfig`（`direct_config.default_value`）+ `sensorTemp` 工具
- [x] 水泵启动宽限期 `pump_start_grace`
- [ ] 阈值配置即时生效：**去掉 60s 缓存**（每帧读一次 `direct_config` 的成本可接受），不引入旧项目的事件失效机制
- [ ] 设备级配置覆盖：**待评估** —— 前端目前只有全局配置入口；确需时再按「设备值 > 默认值」轻量合并，不照搬旧项目的每设备配置对象
- [ ] 离线告警 `sensor_offline`：轻量定时器（5s）扫描最后上报时间 → 超时告警、恢复清除；**不做**旧项目的「暂停自动控制」（本引擎由上报驱动，不会用旧数据决策）
- [ ] 设备状态同步（`source='device'`）：设备上报值与 `direct` 目标**连续 N 帧不一致**才同步（轻量去抖，不用旧项目的漂移阈值表）
- [ ] 关泵连带关加热：作为**引擎统一规则**（执行决策时若关水泵且加热正开，则自动追加关加热），比旧项目 `controlBus` 联动轻；无需 `manual_protect` 配置项
- [ ] 数据质量标记 `WsData.invalid`：轻量固定阈值判跳变（不引入旧项目的多配置项）
- [ ] 告警类型区分：`AlarmDef` 增加类型字段（如 `type: 'block' | 'error'`）由组件自带，替代现在写死的 `error_msg.field3='block'`

## 锁定通道与复位（`src/core/locks/`、`directModule`）

- [x] 统一锁定通道 `@core/locks`：`acquire`/`releaseAll`/`isDenied`/快照（`getSnapshot`/`clearSnapshot`）
- [x] `DirectModule.setValue` 按锁拦截：禁止**开启水泵**，关泵不受限
- [x] 手动复位 `POST /api/control/reset`：清 `blocked` → 释放锁 → 按快照恢复 heat/water → 广播 `type:'reset'`

> 约定：组件需要保护性锁时**直接调用 `lockManager`**（锁上带快照），引擎不参与锁语义 ——
> 不引入旧项目的「决策带 `lock`/`unlock`、引擎统一执行」那套重机制。

## 设备控制 · HTTP 接口（`gateways/http/`、`modules/directModule/`、`types/api.ts`）

- [x] 数据读接口：`GET /api/{sensor|behavior|error|control}/{table|data|count|time-range}`
- [x] 设备列表：`GET /api/sensor/devices`
- [x] 指令配置/数据：`GET /api/direct/config`、`GET /api/direct/data?d_no=`、`POST /api/direct/update`
- [x] 手动控制 `POST /api/control`：`auto=1` 时拒绝手动开/关；写 direct + 下发 + WS 通知 + `control_log(manual)`
- [x] 手动复位：`POST /api/control/reset`
- [x] 前端契约：`api.ts::sendControlCommand` / `resetDeviceBlock`
- [ ] `direct_config.blocked` 是内部标记，却会出现在 `GET /api/direct/config`（前端会当配置项渲染）
- [ ] `ErrorCode.NOT_IMPLEMENTED` 已无使用点，可从联合类型移除
- [ ] 旧前端接口差异（需前端按新契约 `src/types/api.ts` 改造）：`/data/chart`（旧 api.ts 定义、UI 未调用）、`/data/devices`（旧前端硬编码，后端为 `/sensor/devices`）

## 指令下发 · 设备端接口（`modules/directModule/dispatch.ts`）

- [x] 设备端接口定义独立成文件：`CONTROL_TOPIC='control/'` + `COMMAND_GROUPS`（heat/water 的 Modbus 帧）+ `buildControlMessage`
- [x] `setValue` 落库成功后下发：未登记报文的指令码（`auto`/`blocked` 等）只落库不下发；顺序 = 落库 → 下发 → `direct` 通知
- [x] `source`（manual/auto/config）与 `notify`（内部标记不推 direct 通知）语义

## 数据链路 · MQTT 入站 / 传感器 / WS 推送（`gateways/mqtt/`、`modules/sensorModule/`、`gateways/websocket/`、`modules/alarmModule/`）

- [x] MQTT 入站：连接/重连后订阅已注册主题（含启动日志）；未知主题消息 warn 忽略
- [x] 传感器模块：`SENSOR_DATA_RAW` → 派生指标（累计流量本地累加 / `heat_rate` / `avg_flow`）→ 落库 `sensor_data` → 再分发 `SENSOR_DATA`
- [x] WS `data` 推送（实时数据）、WS `direct` 通知（成功/失败）、WS `alarm`（告警 + 复位广播）
- [x] 预警补推：WS 连接时按 `direct.blocked` + `error_msg(field3='block')` 定向补推（id 复用 `alarm_${d_no}_${c_time}` 供前端去重）
- [x] WS 定向推送 `goal` 与重连复用、`WS_CLIENT_CONNECTED` / `WS_MESSAGE_IN` 事件
- [ ] `WS_MESSAGE_IN` 无订阅者：前端不发 WS 上行，保持预留（暂无需求）
- [ ] 实时数据推送节流/合并（若前端压力大再加，现为按帧广播）

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
- [ ] 测试工程化：关键单测仍散落 `tmp/`（未入仓、无 `pnpm test`）
- [ ] 死事件清理：`MQTT_MESSAGE`（无人收发）、`errorMessage`（`database` emit 但无订阅者）
- [ ] 死依赖卸载：`uuid`（代码用 `node:crypto`）、`dotenv`、`nodemon`、`ts-node`（已被 tsx 取代）；`jiti` 疑似 ESLint 加载 TS 配置所需，勿删
