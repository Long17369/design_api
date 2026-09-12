# TODO / 进度清单

> 分类按**实际定位（模块 / 功能域）**组织，条目混排：`[x]` 已完成、`[ ]` 待实现。
> 维护约定：做完一项就勾上（不搬动位置）；新增项放到对应模块分类下。最后更新：2026-09-12。
>
> 参考实现：后端 `~/code/web/mysql/mysql_node_api`（`src/services/**`）、前端 `~/code/web/IoT`
> （`src/server/api.ts` 契约、`src/composables/useWebSocket.ts` 消费 WS）。

## 自动控制 · 保护组件（`src/modules/autoControl/components/`）

- [x] 堵塞保护：打散为 4 个独立判定 —— `pressureZero`(10) / `flowZero`(12) / `flowUnchanged`(14) / `tempAnomaly`(16)，命中即 `heat=0+water=0` + 持久化 `blocked` + 加锁 + 告警
- [x] 恒温保护 `tempLimit`(80)：超 `temp_max` 关加热；低于 `temp_min` 且水泵运行中才开加热（防干烧）；上限优先；幂等
- [x] 累计流量目标 `flowTarget`(70)：跨越 `total_flow_target` 关泵一次，可随累计流量回落/调大目标重新触发
- [ ] `overpressure` 完整版：现 `highPressure`(20) 只「关泵 + 告警」，缺**冷却期限时锁**、冷却期满压力回落**自动开泵 + `unlock`**
- [ ] `reverseTemp` 逆温差：加热中且出水 < 进水 − Δ 持续 N 秒 → 预警；并供恒温暂停使用（`tempLimit` 已留接入点）
- [ ] `pumpIdle` 水泵空转：水泵开 + 流量归零持续 N 秒 → 关泵（可选 `off_and_lock`）
- [ ] `leak` 严重泄漏：水泵开 + 压力骤降 + 流量归零持续 N 秒 → 关泵 + 红色告警（可选加锁）
- [ ] `pfMismatch` 压力流量不匹配：窗口内流量降 > X% 且压力升 > Y% → 预警（可选关泵）；含旧项目「建议降功率」TODO
- [ ] `pidTemp` PID 控温：按 `pid_cycle` PWM 开关加热（死区 / 限幅 / 泵未开禁加热）

## 自动控制 · 引擎与阈值配置（`autoControl/index.ts`、`utils.ts`）

- [x] 组件化引擎：priority 顺序执行、每帧评估、组件自去重（幂等靠组件）、`stop` 终止；`ctx.values` 即时更新
- [x] 告警定义下沉到各组件（删除集中的 `alarmConfig.ts`）；`reason` 与告警文案分离
- [x] 阈值配置读取 `loadAutoConfig`（`direct_config.default_value`）+ `sensorTemp` 工具
- [x] 水泵启动宽限期 `pump_start_grace`（仅水泵刚启动时跳过判定）
- [ ] 设备级配置覆盖：`t_direct` 值 > `direct_config` 默认值 > 内置默认（现只读默认值）
- [ ] 配置变更即时生效：现 60s 缓存，改阈值/开关最多 1 分钟后生效（旧项目 `directChanged` → `invalidateAutoState`）
- [ ] 离线巡检 `sensor_offline`：超时未上报 → 告警 + **暂停自动控制**（参考 `services/faultScanner.ts`；含 enable/timeout/pause_control 三个配置项）
- [ ] 设备状态同步（`source='device'`）：设备上报的 heat/water 与 `direct` 期望不一致时同步并记控制日志（旧项目带漂移阈值去抖）
- [ ] 关泵连带关加热（防干烧）：旧项目由 `controlBus`「关泵前先关加热」保证；本项目分发层无联动（`flowTarget` 已留 TODO）
- [ ] `manual_protect` 联动：手动关泵前按设备配置先关加热
- [ ] `WsData.invalid`：数据跳变（spike）/卡死（stuck）标记未产出（前端曲线标注用不了）
- [ ] 告警类型区分：`sendAlarm` 的 `error_msg.field3` 写死 `'block'`，过压等非堵塞告警也写成 block

## 锁定通道与复位（`src/core/locks/`、`directModule`）

- [x] 统一锁定通道 `@core/locks`：`acquire`/`releaseAll`/`isDenied`/快照（`getSnapshot`/`clearSnapshot`）、限时锁过期判定
- [x] `DirectModule.setValue` 按锁拦截：禁止**开启水泵**，关泵不受限
- [x] 手动复位 `POST /api/control/reset`：清 `blocked` → 释放锁 → 按快照恢复 heat/water → 广播 `type:'reset'`
- [ ] `AutoDecision.lock/unlock` 决策能力：现只有写死的 blocked 锁；缺多类型锁（overpressure/pump_idle/leak）、限时锁 `expiresAt`、解锁恢复语义 —— 是「保护组件」中三个待移植组件的前置

## 设备控制 · HTTP 接口（`gateways/http/`、`modules/directModule/`、`types/api.ts`）

- [x] 数据读接口：`GET /api/{sensor|behavior|error|control}/{table|data|count|time-range}`
- [x] 设备列表：`GET /api/sensor/devices`（有上报数据的 `d_no` 去重）
- [x] 指令配置/数据：`GET /api/direct/config`、`GET /api/direct/data?d_no=`、`POST /api/direct/update`
- [x] **手动控制** `POST /api/control`：`auto=1` 时拒绝手动开/关；写 direct + 下发 + WS 通知 + `control_log(manual)`
- [x] 手动复位：`POST /api/control/reset`
- [x] 前端契约同步新增：`api.ts::sendControlCommand` / `resetDeviceBlock`
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
- [x] `seeds` 幂等初始化（只补缺失、不覆盖删除）；改为「列定义 + 值行」列表形式（490 → 147 行）
- [x] 配置加载：`fs.readFileSync` + `JSON.parse` + Ajv（`useDefaults`，`timezone` 默认 `'Z'`）
- [ ] 累计流量改为持久化：现为**进程内累加、重启归零**（定量供水的语义限制）

## 工程 / 工具 / 依赖

- [x] 运行与校验：`tsx` 运行（勿用 ts-node）、`pnpm type-check` / `lint` / `format`
- [x] 类型出口统一：`MQTTMessageOut` 以 `src/types/types.ts` 为唯一定义来源（删 gateway 侧重复定义）；`types.ts` 属对外契约保持稳定
- [x] 清理：删除空 `runtime/` 目录、移除 `test` 占位脚本
- [ ] 测试工程化：关键单测仍散落 `tmp/`（未入仓、无 `pnpm test`）
- [ ] 死事件清理：`MQTT_MESSAGE`（无人收发）、`errorMessage`（`database` emit 但无订阅者）
- [ ] 死依赖卸载：`uuid`（代码用 `node:crypto`）、`dotenv`、`nodemon`、`ts-node`（已被 tsx 取代）；`jiti` 疑似 ESLint 加载 TS 配置所需，勿删
