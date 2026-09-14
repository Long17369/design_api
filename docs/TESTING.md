# 测试与校验

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm test` | 运行 vitest 单测（`tests/**/*.test.ts`，24 个用例，<1s） |
| `pnpm test:watch` | vitest watch 模式 |
| `pnpm type-check` | `tsc --noEmit`（覆盖 `src` + `tests`） |
| `pnpm exec eslint .` | 类型感知 lint（`tmp/` 已忽略） |
| `pnpm dev` | tsx 直接起服务（勿用 ts-node） |

## 单测（仓库内，`tests/`）

| 文件 | 覆盖内容 |
|---|---|
| `tests/autoControl/components.test.ts` | 堵塞保护（压力归零/流量不变/温度异常）、空转保护去抖、恒温上下限、累计流量目标、过压冷却期与锁、逆温差预警 |
| `tests/autoControl/alarm.test.ts` | `sendAlarm` 的分类/类型/颜色透传、告警时间归一化（UTC 字面量）、堵塞补推告警组装 |
| `tests/sensorModule/spike.test.ts` | 跳变检测阈值边界、关闭字段、缺测不误判 |
| `tests/core/cache.test.ts` | KV/TTL/标签失效/`remember` 只加载一次 |

约定：组件与锁通道是**进程级单例**，用例需在 `beforeEach` 清理（`clearState` / `releaseAll`）；vitest 已配置串行执行（`fileParallelism: false`）。

## E2E / 集成脚本（`tmp/`，不入库）

依赖真实 MySQL、MQTT broker 与本地服务（HTTP 10452）：

```bash
(pnpm exec tsx src/main.ts > tmp/server.log 2>&1 &)   # 起服务
node tmp/e2e_blocked.mjs                              # 例：堵塞保护全链路
```

- 脚本清单：`tmp/e2e_*.mjs`（HTTP+MQTT+WS 全链路）、`tmp/e2e_blocked_bus.ts`（总线级，进程内构造模块）
- 注意：
  1. 脚本**起止各调用一次** `POST /api/control/reset {d_no}` —— 保护锁存在服务进程内存里，删库行不会释放锁；
  2. `e2e_flow_target` 依赖**进程内累计流量**（删库不重置）→ 必须在服务刚启动时运行（脚本内有前置断言）；
  3. 改**全局** `direct_config` 的用例需在服务启动前改好（引擎/传感器模块的默认值走缓存；应用内写库才会自动失效）；
  4. 设备级配置（`POST /api/direct/update`）逐帧生效，推荐用设备级覆盖做用例配置。
