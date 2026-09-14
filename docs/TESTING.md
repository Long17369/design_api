# 测试与校验

## 命令

| 命令                 | 作用                                                           |
| -------------------- | -------------------------------------------------------------- |
| `pnpm test`          | 运行 vitest 单测（`tests/**/*.test.ts`，9 文件 52 用例，<1s）  |
| `pnpm test:watch`    | vitest watch 模式                                             |
| `pnpm type-check`    | `tsc --noEmit`（覆盖 `src` + `tests`）                        |
| `pnpm exec eslint .` | 类型感知 lint（`tests/e2e/*.mjs` 关闭类型感知，`tmp/` 忽略）  |
| `pnpm dev`           | tsx 直接起服务（勿用 ts-node）                                |

## 单测（仓库内，`tests/`）

| 文件                                   | 覆盖内容                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tests/autoControl/components.test.ts` | 堵塞三判定（压力归零/流量不变/温度异常）、空转去抖、恒温上下限、流量目标、过压冷却期与锁、逆温差预警            |
| `tests/autoControl/pidTemp.test.ts`    | PID：未启用/防干烧/缺测/占空比开关/积分限幅饱和/抗积分饱和（升温段不污染稳定段）/时间量纲与 PWM 最小导通 |
| `tests/autoControl/alarm.test.ts`      | `sendAlarm` 分类/类型/颜色透传、时间归一化（UTC 字面量）、堵塞补推组装                                          |
| `tests/sensorModule/spike.test.ts`     | 跳变阈值边界、关闭字段、缺测不误判                                                                              |
| `tests/sensorModule/offline.test.ts`   | 离线哨兵值（0xFFFF/10 = 6553.5）剔除：温度/压力/流量、字符串与数字形态、邻近正常值不动                          |
| `tests/core/cache.test.ts`             | KV/TTL/标签失效/`remember` 只加载一次                                                                           |
| `tests/core/chart.test.ts`             | 桶步长边界（向上取整/最小 1s）、SQL 结构与参数顺序、客户端 URL 与别名                                           |
| `tests/core/wsUrl.test.ts`             | WS 契约接口：`WS_PATH` 与后端路径一致、`connectWebSocket` 返回连接实例（含 `location` 拼地址/无 location 报错） |
| `tests/core/typesIsolation.test.ts`    | 契约目录纯净性：`src/types/` 内只允许 `./` 引用，出现外部引用即失败                                             |
| `tests/directModule/configHierarchy.test.ts` | 配置层级门控（递归隐藏、`|` 多值、父值回退 `default_value`）                                             |

约定：组件与锁通道是**进程级单例**，用例需在 `beforeEach` 清理（`clearState` / `releaseAll`）；vitest 已配置串行执行（`fileParallelism: false`）。

## E2E / 集成脚本（`tests/e2e/`，入库）

需要真实 MySQL、MQTT broker 与本地服务（HTTP 10452），**从仓库根目录运行**（脚本读 `config.json`，
产物写到 `tmp/`）：

```bash
(pnpm exec tsx src/main.ts > tmp/server.log 2>&1 &)   # 起服务
node tests/e2e/blocked.mjs                            # 例：堵塞保护全链路
pnpm exec tsx tests/e2e/blocked_bus.ts                # 总线级（进程内构造模块，不需要服务）
pnpm exec tsx tests/e2e/ws_path.ts                    # WS 路径锁定（进程内起临时端口，什么都不依赖）
pnpm exec tsx tests/e2e/verify_seeds.ts               # seeds 等价性（只需数据库）
```

| 脚本                                                                                                            | 覆盖                                                                              |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `blocked.mjs`                                                                                                   | 堵塞保护全链路（判堵塞 → 加锁 → WS → 复位）                                       |
| `frame_eval.mjs`                                                                                                | 每帧评估 + 组件自幂等                                                             |
| `control.mjs` / `dispatch.mjs`                                                                                  | 手动控制与拒绝、指令下发（Modbus 帧）                                             |
| `temp_limit.mjs` / `pump_heat.mjs` / `pump_idle.mjs` / `overpressure.mjs` / `reverse_temp.mjs` / `pid_temp.mjs` | 各保护组件（恒温、关泵连带关加热、空转去抖、过压冷却期、逆温差、PID PWM）         |
| `flow_target.mjs` / `flow_resume.mjs`                                                                           | 累计流量目标、累计流量重启续算（两阶段）                                          |
| `device_override.mjs`                                                                                           | 设备级配置覆盖优先级（前端改配置立即生效）                                        |
| `device_sync.mjs` / `sensor_offline.mjs` / `sensor_spike.mjs`                                                   | 设备状态回写、离线告警（含哨兵值 6553.5 按缺测不入库）、跳变标记                  |
| `ws_push.mjs`                                                                                                   | WS 定向推送与重连（`goal`）                                                       |
| `chart.mjs`                                                                                                     | 历史图表降采样接口                                                                |
| `config_hierarchy.mjs`                                                                                          | 配置项层级门控（`GET /api/direct/config?d_no=`）                                  |
| `blocked_bus.ts`                                                                                                | 总线级堵塞联动（进程内构造模块）                                                  |
| `ws_path.ts`                                                                                                    | WS 路径锁定 + 契约 `connectWebSocket(goal?)` 建连（其它路径 400；进程内临时端口） |
| `lock_persist_a.mjs` / `lock_persist_b.mjs`                                                                     | 锁持久化：A 触发并落库 → B 重启后恢复与开泵拦截（两阶段）                         |
| `verify_seeds.ts` / `print_configs.ts`                                                                          | seeds 等价性校验 / 打印指令配置列表（排查工具）                                   |
| `pid_calib.mjs`                                                                                                 | PID 控温「稳在目标」标定/验收统计（**只读、不起服务**；读数占比/带宽/静态偏差/duty 分布） |

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

## PID 控温精度：标定与验收（`tests/e2e/pid_calib.mjs`）

**只读、不起服务**，直接读 MySQL 统计「稳在目标」的达成度，报告同时写入 `tmp/pid_calib_<时间戳>.md`：

```bash
node tests/e2e/pid_calib.mjs                  # 最近 30 分钟、全部设备
node tests/e2e/pid_calib.mjs 14:40 15:00      # 指定当天窗口
node tests/e2e/pid_calib.mjs 14:40 15:00 <d_no>
```

判定标准（**读数口径**；真值需独立温度计比对）：

| 指标                                     | 达标                                            |
| ---------------------------------------- | ----------------------------------------------- |
| 读数恒为目标的占比                       | ≥ 99%                                           |
| 读数带宽                                 | ≤ 1 个上报步长（现为 0.1 ℃）                    |
| 加热占比                                 | 与理论平衡 duty 同量级（实测升温:散热 ≈ 7~9:1 ⇒ ≈ 13%） |

标定步骤（偏差规律已由仿真 + 真机数据确认）：

1. 先跑工具看**静态偏差（读数均值 − 目标）**：
   - ≈ **负半个上报步长**（现为 −0.05）⇒ 控制器停在「读数 = 目标」区间的**下沿**（读数一旦等于目标就停止加热），
     真值被钉在 `目标 − 半步`。补偿 = 把控制目标上调**半个步长**（+0.05）；真机实测偏差 −0.044，与理论一致。
   - ≈ 0 ⇒ 已居中，无需补偿。
   - ≈ **一个整步长**（+0.1）⇒ 补偿过量（跳档），改回半步。
2. 补偿**必须配 `pid_kp` 降档**：仿真显示 `Kp=4` 时 +0.04 会**整步跳档**（真值 → `+0.06`、读数变 40.1），
   而 `Kp=1~2` 时可单调微调（数据见 `docs/TODO.md` 的标定条目）。
3. **缩短 `pid_cycle`**（60 → **25 s**）：纹波带 ≈ `duty × pid_cycle × 0.015 ℃/s`，
   带子只由周期决定 —— 这是把「显示目标占比」从 95% 抬到 **98.6%** 的关键（详见下）。
4. 改完**再跑一次工具复验**（对比改动前后的占比、带宽、加热占比）。

**推荐参数组合**（目标「显示 40.0 的时长最多」；零代码，只改配置值）

| 配置 | 现状 | 推荐 | 说明 |
| --- | --- | --- | --- |
| `pid_kp` | 4 | **2** | 降低对 0.1 ℃ 量化台阶的敏感度（台阶 × Kp = 占空比跳变） |
| `pid_target` | 40 | **40.02** | 半步补偿（详见步骤 1） |
| `pid_cycle` | 60 | **8** | 段长 = duty×周期（上限 2s）⇒ 周期越小段越短、纹波越小（纹波 ≈ 段长 × 0.015 ℃/s） |
| `pid_kd` | 0.5 | **0** | 量化台阶下微分项只放大卡点噪声 |

效果（12 h 仿真：安静探头 / 含 ±0.02 慢抖与 0.05 尖峰）：显示目标占比 **31.7% → 99.0%**（含抖动 89.6%），
下发次数 366~984/h → **493/h**（`pid_cycle`=8 ⇒ 开 1.1s 关 6.9s）。
若要少开关：`pid_cycle`=60 ⇒ 96.2%（含抖动 91.7%）、**330/h**；周期再长也不会更少（段长被上限 2s 截住）。

**机理：纹波 = 导通段长 × 0.015 ℃/s**（满功率升温率），而平均开关周期 ≈ 段长 / duty。
因此「稳在目标」与「少开关」是**硬权衡**（实测：纹波(℃) × 开关次数(/h) ≈ 14.8）：

| 段长 | 纹波(峰峰) | 开关次数 | 显示目标 |
| --- | --- | --- | --- |
| 1.1 s | 0.03 ℃ | ~490/h | 99.0% |
| 2 s | 0.06 ℃ | ~330/h | 96.2% |
| 8 s | 0.25 ℃ | ~82/h | 7~31% |

段长由 `duty × pid_cycle` 决定（下限 1 帧、上限 2 s），所以调 `pid_cycle` 就是在两个目标之间选点。

边界（避免设定不可达的验收目标）：

- **「完全不变」物理上不可达**：真值纹波下限 ≈ 0.02 ℃（PWM 开关 + 散热波动的极限）。
- 要求**读数恒为 40.0** 且设备端只有 0.1 ℃ 精度时：上表组合可做到 ≈ 95~99% 的时间显示 40.0；
  剩下那几 % 来自探头零星抖动（±0.05 尖峰 ≈ −4 pp）与纹波带（0.10~0.12）略宽于一个 bin。
  若设备端愿意把水温上报精度提到 0.01 ℃，可进一步逼近「读数不变」（仿真：真值 40.002 ± 0.05）。
- 若真机温度计与日志读数**恒差一个固定量**（如日志 40.0、温度计 40.2），先查**探头校准与测点位置**（水温分层），
  控制器只能把它读到的值稳到目标。

