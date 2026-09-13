# 测试与校验

## 命令

| 命令                 | 作用                                                          |
| -------------------- | ------------------------------------------------------------- |
| `pnpm test`          | 运行 vitest 单测（`tests/**/*.test.ts`，7 文件 41 用例，<1s） |
| `pnpm test:watch`    | vitest watch 模式                                             |
| `pnpm type-check`    | `tsc --noEmit`（覆盖 `src` + `tests`）                        |
| `pnpm exec eslint .` | 类型感知 lint（`tests/e2e/*.mjs` 关闭类型感知，`tmp/` 忽略）  |
| `pnpm dev`           | tsx 直接起服务（勿用 ts-node）                                |

## 单测（仓库内，`tests/`）

| 文件                                         | 覆盖内容                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tests/autoControl/components.test.ts`       | 堵塞三判定（压力归零/流量不变/温度异常）、空转去抖、恒温上下限、流量目标、过压冷却期与锁、逆温差预警 |
| `tests/autoControl/pidTemp.test.ts`          | PID：未启用/防干烧/缺测/占空比开关/积分限幅饱和                                                      |
| `tests/autoControl/alarm.test.ts`            | `sendAlarm` 分类/类型/颜色透传、时间归一化（UTC 字面量）、堵塞补推组装                               |
| `tests/sensorModule/spike.test.ts`           | 跳变阈值边界、关闭字段、缺测不误判                                                                   |
| `tests/core/cache.test.ts`                   | KV/TTL/标签失效/`remember` 只加载一次                                                                |
| `tests/core/chart.test.ts`                   | 桶步长边界（向上取整/最小 1s）、SQL 结构与参数顺序、客户端 URL 与别名                                |
| `tests/directModule/configHierarchy.test.ts` | 配置层级门控（递归隐藏、`                                                                            | `多值、父值回退`default_value`） |

约定：组件与锁通道是**进程级单例**，用例需在 `beforeEach` 清理（`clearState` / `releaseAll`）；vitest 已配置串行执行（`fileParallelism: false`）。

## E2E / 集成脚本（`tests/e2e/`，入库）

需要真实 MySQL、MQTT broker 与本地服务（HTTP 10452），**从仓库根目录运行**（脚本读 `config.json`，
产物写到 `tmp/`）：

```bash
(pnpm exec tsx src/main.ts > tmp/server.log 2>&1 &)   # 起服务
node tests/e2e/blocked.mjs                            # 例：堵塞保护全链路
pnpm exec tsx tests/e2e/blocked_bus.ts                # 总线级（进程内构造模块，不需要服务）
pnpm exec tsx tests/e2e/verify_seeds.ts               # seeds 等价性（只需数据库）
```

| 脚本                                                                                                            | 覆盖                                                                      |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `blocked.mjs`                                                                                                   | 堵塞保护全链路（判堵塞 → 加锁 → WS → 复位）                               |
| `frame_eval.mjs`                                                                                                | 每帧评估 + 组件自幂等                                                     |
| `control.mjs` / `dispatch.mjs`                                                                                  | 手动控制与拒绝、指令下发（Modbus 帧）                                     |
| `temp_limit.mjs` / `pump_heat.mjs` / `pump_idle.mjs` / `overpressure.mjs` / `reverse_temp.mjs` / `pid_temp.mjs` | 各保护组件（恒温、关泵连带关加热、空转去抖、过压冷却期、逆温差、PID PWM） |
| `flow_target.mjs` / `flow_resume.mjs`                                                                           | 累计流量目标、累计流量重启续算（两阶段）                                  |
| `device_override.mjs`                                                                                           | 设备级配置覆盖优先级（前端改配置立即生效）                                |
| `device_sync.mjs` / `sensor_offline.mjs` / `sensor_spike.mjs`                                                   | 设备状态回写、离线告警、跳变标记                                          |
| `ws_push.mjs`                                                                                                   | WS 定向推送与重连（`goal`）                                               |
| `chart.mjs`                                                                                                     | 历史图表降采样接口                                                        |
| `config_hierarchy.mjs`                                                                                          | 配置项层级门控（`GET /api/direct/config?d_no=`）                          |
| `blocked_bus.ts`                                                                                                | 总线级堵塞联动（进程内构造模块）                                          |
| `lock_persist_a.mjs` / `lock_persist_b.mjs`                                                                     | 锁持久化：A 触发并落库 → B 重启后恢复与开泵拦截（两阶段）                 |
| `verify_seeds.ts` / `print_configs.ts`                                                                          | seeds 等价性校验 / 打印指令配置列表（排查工具）                           |

注意：

1. 脚本**起止各调用一次** `POST /api/control/reset {d_no}` —— 保护锁存在服务进程内存里，删库行不会释放锁；
2. `flow_target.mjs` 依赖**进程内累计流量** → 必须在服务刚启动时**先跑**（脚本内有前置断言）；
3. `sensor_spike.mjs` 需先启用全局开关 `sensor_spike_enabled=1`（改**全局**配置要在**服务启动前**改好；
   引擎/传感器模块的默认值走缓存，只有应用内写库才会自动失效）；
4. `flow_resume.mjs`、`lock_persist_*.mjs` 是**两阶段**脚本，中间需重启服务；
5. 设备级配置（`POST /api/direct/update`）逐帧生效，推荐用设备级覆盖做用例配置。

产物与清理：脚本会在 `tmp/` 写 `<脚本名>_result.json` 与启动日志 `tmp/server*.log`（`tmp/` 已 gitignore）：

```bash
rm -f tmp/*.log tmp/*.json   # 只清产物；测试脚本已入库在 tests/e2e/
```
