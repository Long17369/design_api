# TODO / 进度清单

> 维护约定：完成一项就把对应条目勾上并移到「已完成」区（或直接标注完成日期）；
> 未完成项按「功能缺口」与「技术债」分组。最后更新：2026-09-12。
>
> 参考实现：后端 `~/code/web/mysql/mysql_node_api`（`src/services/**`）、前端 `~/code/web/IoT`
> （`src/server/api.ts` 契约、`src/composables/useWebSocket.ts` 消费 WS）。

## 未完成 —— 功能缺口

- [ ] **离线巡检 `sensor_offline`**：设备超时未上报 → 告警 + **暂停自动控制**（参考 `services/faultScanner.ts`；含 `sensor_offline_enable` / `sensor_offline_timeout` / `sensor_offline_pause_control` 三个配置项）
- [ ] **`overpressure` 完整版**：现在 `components/highPressure.ts` 只「关泵 + 告警」，缺**冷却期限时锁**、冷却期满压力回落**自动开泵 + `unlock`**
- [ ] **`reverseTemp` 逆温差**：加热中且出水 < 进水 − Δ 持续 N 秒 → 黄色预警；并供恒温暂停使用（`tempLimit` 注释中已留待接入点）
- [ ] **`pumpIdle` 水泵空转**：水泵开 + 流量归零持续 N 秒 → 关泵（可选 `off_and_lock` 加锁）
- [ ] **`leak` 严重泄漏**：水泵开 + 压力骤降 + 流量归零持续 N 秒 → 关泵 + 红色（全屏）告警（可选加锁）
- [ ] **`pfMismatch` 压力流量不匹配**：窗口内流量降 > X% 且压力升 > Y% → 预警（可选关泵）；旧项目还留了「建议降功率」TODO
- [ ] **`pidTemp` PID 控温**：按 `pid_cycle` 做 PWM 开关加热（死区 / 限幅 / 泵未开禁加热）
- [ ] **设备状态同步（source='device'）**：设备上报的 heat/water 与 `direct` 期望不一致时同步并记控制日志（旧项目 `mqttService/components/data.ts::syncDeviceStatus`，带漂移阈值去抖）
- [ ] **`manual_protect` 联动**：手动「关泵」前按设备配置先关加热（旧项目在 `controlBus` 的 water 回调里做）

## 未完成 —— 支撑机制 / 技术债

- [ ] **锁能力 `AutoDecision.lock/unlock`**：目前只有写死的 blocked 锁；缺多类型锁（overpressure/pump_idle/leak）、限时锁 `expiresAt`、解锁恢复语义 —— 是上面 3 个保护组件的**前置**
- [ ] **设备级配置覆盖**：`loadAutoConfig` 只读 `direct_config.default_value`；旧项目是 `t_direct` 值 > 默认值 > 内置默认
- [ ] **配置变更即时生效**：阈值/开关有 60s 缓存，用户改完最多 1 分钟后生效；旧项目用 `directChanged` 事件 → `invalidateAutoState`
- [ ] **关泵连带关加热（防干烧）**：旧项目由 `controlBus`「关泵前先关加热」保证；本项目分发层无联动 → `components/flowTarget.ts` 已留 TODO
- [ ] **`WsData.invalid`**：数据跳变（spike）/卡死（stuck）标记未产出，前端曲线标注用不了
- [ ] **告警类型区分**：`sendAlarm` 的 `error_msg.field3` 写死 `'block'`，过压等非堵塞告警也写成 block（影响按 field3 过滤的查询/补推）
- [ ] **测试工程化**：关键单测仍散落 `tmp/`（未入仓、无 `pnpm test`）；`package.json` 的 `test` 占位脚本已移除
- [ ] **清理项**
  - [ ] `ErrorCode.NOT_IMPLEMENTED` 已无使用点，可从联合类型移除
  - [ ] `direct_config.blocked` 是内部标记，却会出现在 `/api/direct/config`（前端会当配置项渲染）
  - [ ] 累计流量为**进程内累加、重启归零**（定量供水的语义限制，需要时改为持久化）
  - [ ] 死事件：`MQTT_MESSAGE`（无人收发）、`errorMessage`（`database` 里 emit 但无订阅者）
  - [ ] 死依赖：`uuid`（代码用 `node:crypto`）、`dotenv`、`nodemon`、`ts-node`（已被 tsx 取代）；`jiti` 疑似 ESLint 加载 TS 配置所需，勿删
  - [ ] 旧前端接口差异需前端按新契约 `src/types/api.ts` 改造：`/data/chart`（旧 api.ts 定义、UI 未调用）、`/data/devices`（旧前端硬编码，后端为 `/sensor/devices`）

## 已完成

- [x] **数据库模块**：统一操作接口（query/executeQuery/count/timeRange/insert/update/delete）、自动建库建表、`information_schema` + `SHOW COLUMNS` 增量补列、`seeds` 幂等初始化
- [x] **HTTP 读接口**：`GET /api/{sensor|behavior|error|control}/{table|data|count|time-range}`、`GET /api/sensor/devices`
- [x] **Direct 模块**：配置/数据查询、`POST /api/direct/update`（校验 + UPSERT）
- [x] **传感器数据模块**：`SENSOR_DATA_RAW` → 派生指标（累计流量本地累加 / heat_rate / avg_flow）→ 落库 `sensor_data` → 再分发 `SENSOR_DATA`
- [x] **自动控制引擎**：组件化（priority 顺序、每帧评估、组件自去重、`stop` 终止）、告警定义下沉到各组件
- [x] **堵塞保护**：打散为 4 个组件（压力归零 / 瞬时流量归零 / 累计流量不变 / 温度异常），命中即持久化 `blocked` + 加锁 + 告警
- [x] **统一锁定通道** `@core/locks`：加锁/释放/快照，`DirectModule` 在「开启水泵」时按锁拦截（关泵不受限）
- [x] **手动复位** `POST /api/control/reset`：清 blocked → 释放锁 → 按快照恢复 heat/water → 广播 `type:'reset'`
- [x] **指令下发**：`modules/directModule/dispatch.ts` = 设备端接口定义的唯一改动点（`control/` + Modbus 帧），未登记报文的指令码只落库不下发
- [x] **WS 推送**：`data`（实时数据）、`alarm`（告警，含补推）、`direct`（指令变更，成功/失败）+ 定向推送 `goal` 与重连复用
- [x] **预警模块**：WS 连接时按 `direct.blocked` + `error_msg(field3='block')` 定向补推堵塞预警（id 复用 `alarm_${d_no}_${c_time}` 供前端去重）
- [x] **MQTT 入站**：连接/重连后订阅已注册主题（含启动日志），未知主题消息改 warn 忽略
- [x] **手动控制** `POST /api/control`：`auto=1` 时拒绝手动开/关；写 direct + 下发 + WS 通知 + 写 `control_log(manual)`
- [x] **恒温保护** `components/tempLimit.ts`：超上限关加热、低于下限且水泵运行中才开加热（防干烧）、上限优先、幂等
- [x] **累计流量目标** `components/flowTarget.ts`：跨越目标时关泵一次（可随累计流量回落/调大目标重新触发）
- [x] **seeds 重构**：改为「列定义 + 值行」列表形式（490 行 → 147 行）
- [x] **技术债清理**：`MQTTMessageOut` 统一以 `src/types/types.ts` 为唯一定义来源、删除空 `runtime/` 目录、移除 `test` 占位脚本
