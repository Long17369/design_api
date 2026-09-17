# 测试与校验

## 命令

| 命令                 | 作用                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `pnpm test`          | 运行 vitest 单测（`tests/**/*.test.ts`，套件规模见命令输出，<1s） |
| `pnpm test:watch`    | vitest watch 模式                                                 |
| `pnpm type-check`    | `tsc --noEmit`（覆盖 `src` + `tests`）                            |
| `pnpm exec eslint .` | 类型感知 lint（`tests/e2e/*.mjs` 关闭类型感知，`tmp/` 忽略）      |
| `pnpm dev`           | tsx 直接起服务（勿用 ts-node）                                    |

## 单测（仓库内，`tests/`）

| 文件                                         | 覆盖内容                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/autoControl/components.test.ts`       | 堵塞三判定（压力归零/流量不变/温度异常）、空转去抖、恒温上下限、流量目标、过压冷却期与锁、逆温差预警                                                             |
| `tests/autoControl/pidTemp.test.ts`          | PID：未启用/防干烧/缺测/占空比开关/积分限幅饱和/抗积分饱和（升温段不污染稳定段）/时间量纲与 PWM 最小导通                                                         |
| `tests/alarmModule/sendAlarm.test.ts`        | `sendAlarm`（告警写入统一入口）分类/类型/颜色透传、时间归一化（UTC 字面量）、堵塞补推组装                                                                        |
| `tests/autoControl/autoConfig.test.ts`       | 阈值配置读取：功能开关默认值（等于加开关前的现状）、`direct` 设备值 > 默认值 > 内置默认、空串回退                                                                |
| `tests/autoControl/dryBurn.test.ts`          | 干烧保护：加热累计时长阈值（含 PWM 断续只算导通段）、加热速度边界与负值、缺测/关开关不判定、锁定后不重复、复位后可再判定、优先级高于温控                         |
| `tests/autoControl/interlock.test.ts`        | 引擎级安全不变式（泵热联锁）：泵停关加热（指令值/上报值任一为泵停、开关可关、幂等）、关泵前补关加热（不重复补、非关泵原样）、联锁不进组件注册表                  |
| `tests/sensorModule/spike.test.ts`           | 跳变阈值边界、关闭字段、缺测不误判                                                                                                                               |
| `tests/sensorModule/sensorOffline.test.ts`   | 离线监控判据（开关/阈值/只告一次）、离线与恢复的告警定义（code/等级/分类/type）                                                                                  |
| `tests/sensorModule/offline.test.ts`         | 无效上报值剔除（按 `sensor_data_mapper.invalid_value` 配置：温度/压力 6553.5、流量 655.35、开关 65535；字符串/数字形态、未配置字段不动）+ 缺测不污染派生值与落库 |
| `tests/sensorModule/derive.test.ts`          | 库口径派生：落库时间/时间文本解析、字段映射取列、落库行→窗口采样点（缺测跳过）、基准帧+本帧积分（含 `max_gap_seconds` 封顶）、累计量头尾两点相减（缺测按 0） |
| `tests/core/cache.test.ts`                   | KV/TTL/标签失效/`remember` 只加载一次                                                                                                                            |
| `tests/core/chart.test.ts`                   | 桶步长边界（向上取整/最小 1s）、SQL 结构与参数顺序、客户端 URL 与别名                                                                                            |
| `tests/core/where.test.ts`                   | WHERE 操作符：四组形态的 SQL 与参数（单值/集合/区间/空值）、非法值与未知操作符抛错、列白名单、分页参数顺序、`parseWhere` 400 校验                                |
| `tests/core/wsUrl.test.ts`                   | WS 契约接口：`WS_PATH` 与后端路径一致、`connectWebSocket` 返回连接实例（含 `location` 拼地址/无 location 报错）                                                  |
| `tests/core/logger.test.ts`                  | logger 控制台输出接收器：默认走 console、接管后接收器收到格式化文本与错误标记、传 null 恢复                                                                      |
| `tests/cli/args.test.ts`                     | CLI 启动参数：位置参数 / `-c` / `--config` / `--config=` 等价、`-h`/`--help`、缺值与未知参数抛错、帮助文本                                                       |
| `tests/cli/commands.test.ts`                 | CLI 命令：短名与全名解析（大小写、restart 仅全名）、帮助文本、r/u/c/q/restart/h 执行与错误兜底                                                                   |
| `tests/cli/screen.test.ts`                   | 终端布局引擎：滚动区设定/复位、底部两行重绘、日志进滚动区、尺寸变化、非 TTY 退化；行编辑与历史                                                                   |
| `tests/core/configReload.test.ts`            | 配置热更新协议：按已注册 section 的 diff（深比较/归属标注）、广播与回报、超时兜底按未生效、重复/非本次变更回报忽略                                               |
| `tests/core/locks.test.ts`                   | 锁通道：`reset()` 清空内存锁与快照、不广播（供进程内重启对齐真实重启语义）                                                                                       |
| `tests/core/databaseRetry.test.ts`           | 连接断开自愈：读操作重试一次（连接类错误）、写操作不重试、非连接类错误不重试、`checkHealth` 探活与跳过时机、关闭后快速失败                                       |
| `tests/core/typesIsolation.test.ts`          | 契约目录纯净性：`src/types/` 内只允许 `./` 引用，出现外部引用即失败                                                                                              |
| `tests/directModule/configHierarchy.test.ts` | 配置层级门控（递归隐藏、`\|` 多值、父值回退 `default_value`）                                                                                                    |
| `tests/directModule/deviceSync.test.ts`      | 设备状态同步：上报值归一化、连续不一致计数（缺测/一致清零、指令变化留宽限）、达到阈值回写、heat/water 独立计数、clear                                            |

约定：组件与锁通道是**进程级单例**，用例需在 `beforeEach` 清理（`clearState` / `releaseAll`）；vitest 已配置串行执行（`fileParallelism: false`）。

## E2E / 集成脚本（`tests/e2e/`，入库）

需要真实 MySQL、MQTT broker 与本地服务（HTTP 10452），**从仓库根目录运行**（脚本读 `config.json`，
产物写到 `tmp/`；用 `E2E_CONFIG=<路径>` 可指向别的配置，按该配置里的 `port` / `mqtt` 连服务与 broker）：

```bash
(pnpm exec tsx src/main.ts > tmp/server.log 2>&1 &)   # 起服务
node tests/e2e/blocked.mjs                            # 例：堵塞保护全链路
node tests/e2e/flow_db.mjs                            # 派生指标库口径 + 流量总计查询/清零
node tests/e2e/runtime.mjs                           # 累计运行时长查询（头尾两点相减）
pnpm exec tsx tests/e2e/blocked_bus.ts                # 总线级（进程内构造模块，不需要服务）
pnpm exec tsx tests/e2e/ws_path.ts                    # WS 路径锁定（进程内起临时端口，什么都不依赖）
pnpm exec tsx tests/e2e/verify_seeds.ts               # seeds 等价性（只需数据库）
pnpm exec tsx tests/e2e/db_pool.ts                    # 连接池排队/释放（只需数据库）
pnpm exec tsx tests/e2e/db_recovery.ts                # 连接断开自愈（只需数据库；自带 TCP 代理）
pnpm exec tsx tests/e2e/dry_burn.ts                   # 干烧保护：判定/锁拦截/手动复位（只需数据库）
pnpm exec tsx tests/e2e/device_sync.ts                # 设备状态同步：按上报帧对账、以设备为准回写（需服务在跑）
```

需要在**隔离环境**里验证（不动正在跑的服务与真机）时：复制 `config.json` 改掉 `port` 与 `mqtt.mqtt_port`，
另起一个 mosquitto 监听该端口，再 `pnpm exec tsx src/main.ts --config <该配置>` 起第二个实例，
最后 `E2E_CONFIG=<该配置> pnpm exec tsx tests/e2e/<脚本>.ts` 跑脚本。

| 脚本                                                                                                            | 覆盖                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocked.mjs`                                                                                                   | 堵塞保护全链路（判堵塞 → 加锁 → WS → 复位）                                                                                                       |
| `frame_eval.mjs`                                                                                                | 每帧评估 + 组件自幂等                                                                                                                             |
| `control.mjs` / `dispatch.mjs`                                                                                  | 手动控制与拒绝、指令下发（Modbus 帧）                                                                                                             |
| `temp_limit.mjs` / `pump_heat.mjs` / `pump_idle.mjs` / `overpressure.mjs` / `reverse_temp.mjs` / `pid_temp.mjs` | 各保护组件（恒温、关泵连带关加热、空转去抖、过压冷却期、逆温差、PID PWM）                                                                         |
| `flow_target.mjs` / `flow_resume.mjs`                                                                           | 累计流量目标、累计流量重启续算（两阶段）                                                                                                          |
| `flow_db.mjs`                                                                                                   | 派生指标库口径（`sensor.derive.source=database`）：逐帧累加、落库帧算指标、流量总计查询（头尾两点相减）、清零后从 0 重新累加                      |
| `runtime.mjs`                                                                                                   | 累计运行时长接口：头尾两点相减（水泵/加热）、传 `start`/`end` 换头尾帧、无数据与参数校验（**需服务在跑**）                                        |
| `device_override.mjs`                                                                                           | 设备级配置覆盖优先级（前端改配置立即生效）                                                                                                        |
| `device_sync.ts`  / `sensor_offline.mjs` / `sensor_spike.mjs`                                                   | 设备状态回写、离线告警（含无效上报值 6553.5/65535 按缺测不入库）、跳变标记                                                                        |
| `ws_push.mjs`                                                                                                   | WS 定向推送与重连（`goal`）                                                                                                                       |
| `chart.mjs`                                                                                                     | 历史图表降采样接口                                                                                                                                |
| `config_hierarchy.mjs`                                                                                          | 配置项层级门控（`GET /api/direct/config?d_no=`）                                                                                                  |
| `blocked_bus.ts`                                                                                                | 总线级堵塞联动（进程内构造模块）                                                                                                                  |
| `ws_path.ts`                                                                                                    | WS 路径锁定 + 契约 `connectWebSocket(goal?)` 建连（其它路径 400；进程内临时端口）                                                                 |
| `lock_persist_a.mjs` / `lock_persist_b.mjs`                                                                     | 锁持久化：A 触发并落库 → B 重启后恢复与开泵拦截（两阶段）                                                                                         |
| `verify_seeds.ts` / `print_configs.ts`                                                                          | seeds 等价性校验 / 打印指令配置列表（排查工具）                                                                                                   |
| `db_pool.ts`                                                                                                    | 连接池：小池下并发排队等待（不丢请求）、初始化未就绪即发起时的等待、`close()` 释放（**只需数据库**）                                              |
| `db_recovery.ts`                                                                                                | 连接断开自愈：读重试一次（新连接）、写不重试（错误上抛）、`checkHealth()` 自动重连、`close()` 后快速失败（**只需数据库**；自带 TCP 代理掐断连接） |
| `dry_burn.ts`                                                                                                   | 干烧保护：seeds 配置落库、组件判定、`dry_burn` 锁拦住 `setValue(heat=1)`、`resetBlock` 后加热保持关闭、复位可再判定（**只需数据库**）             |
| `pid_calib.mjs`                                                                                                 | PID 控温「稳在目标」标定/验收统计（**只读、不起服务**；读数占比/带宽/静态偏差/duty 分布）                                                         |

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

| 指标               | 达标                                                    |
| ------------------ | ------------------------------------------------------- |
| 读数恒为目标的占比 | ≥ 99%                                                   |
| 读数带宽           | ≤ 1 个上报步长（现为 0.1 ℃）                            |
| 加热占比           | 与理论平衡 duty 同量级（实测升温:散热 ≈ 7~9:1 ⇒ ≈ 13%） |

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

| 配置         | 现状 | 推荐      | 说明                                                                             |
| ------------ | ---- | --------- | -------------------------------------------------------------------------------- |
| `pid_kp`     | 4    | **2**     | 降低对 0.1 ℃ 量化台阶的敏感度（台阶 × Kp = 占空比跳变）                          |
| `pid_target` | 40   | **40.02** | 半步补偿（详见步骤 1）                                                           |
| `pid_cycle`  | 60   | **8**     | 段长 = duty×周期（上限 2s）⇒ 周期越小段越短、纹波越小（纹波 ≈ 段长 × 0.015 ℃/s） |
| `pid_kd`     | 0.5  | **0**     | 量化台阶下微分项只放大卡点噪声                                                   |

效果（12 h 仿真：安静探头 / 含 ±0.02 慢抖与 0.05 尖峰）：显示目标占比 **31.7% → 99.0%**（含抖动 89.6%），
下发次数 366~984/h → **493/h**（`pid_cycle`=8 ⇒ 开 1.1s 关 6.9s）。
若要少开关：`pid_cycle`=60 ⇒ 96.2%（含抖动 91.7%）、**330/h**；周期再长也不会更少（段长被上限 2s 截住）。

**机理：纹波 = 导通段长 × 0.015 ℃/s**（满功率升温率），而平均开关周期 ≈ 段长 / duty。
因此「稳在目标」与「少开关」是**硬权衡**（实测：纹波(℃) × 开关次数(/h) ≈ 14.8）：

| 段长  | 纹波(峰峰) | 开关次数 | 显示目标 |
| ----- | ---------- | -------- | -------- |
| 1.1 s | 0.03 ℃     | ~490/h   | 99.0%    |
| 2 s   | 0.06 ℃     | ~330/h   | 96.2%    |
| 8 s   | 0.25 ℃     | ~82/h    | 7~31%    |

段长由 `duty × pid_cycle` 决定（下限 1 帧、上限 2 s），所以调 `pid_cycle` 就是在两个目标之间选点。

边界（避免设定不可达的验收目标）：

- **「完全不变」物理上不可达**：真值纹波下限 ≈ 0.02 ℃（PWM 开关 + 散热波动的极限）。
- 要求**读数恒为 40.0** 且设备端只有 0.1 ℃ 精度时：上表组合可做到 ≈ 95~99% 的时间显示 40.0；
  剩下那几 % 来自探头零星抖动（±0.05 尖峰 ≈ −4 pp）与纹波带（0.10~0.12）略宽于一个 bin。
  若设备端愿意把水温上报精度提到 0.01 ℃，可进一步逼近「读数不变」（仿真：真值 40.002 ± 0.05）。
- 若真机温度计与日志读数**恒差一个固定量**（如日志 40.0、温度计 40.2），先查**探头校准与测点位置**（水温分层），
  控制器只能把它读到的值稳到目标。

## 文档格式（markdownlint）

`docs/*.md` 由编辑器的 markdownlint 扩展检查（**本仓库没有配置文件 → 走扩展默认配置**），
**提交前应保持零告警**（VS Code「问题」面板里 `docs/` 不应剩下告警）。

踩过的坑（判据来自扩展内置的 markdownlint 实现）：

- **表格必须完全对齐（MD060）**：对齐按**显示宽度**算 —— CJK / 全角字符记 **2 列**，
  所以「按字符数补齐」的表格在它眼里仍是错位的。表头、分隔行、数据行的竖线位置要一致；
  分隔行两侧各留 1 个空格、宽度与列宽相同。若表格没对齐，它会退一步按 compact 规则报
  「pipe has extra space to the left」—— **真正的修法是让竖线对齐，不是删空格**。
- 单元格里的字面 `|` 要转义成 `\|`，否则被当成多一列（MD056）
- 表格前后要有空行；**列表项内嵌的表格同样要**（MD058）
- `<d_no>` 这类尖括号占位符放进代码 span，否则被当内联 HTML（MD033）
- 不要连续空行（MD012）

重排一张表可手写，也可临时写脚本按显示宽度补齐（`unicodedata.east_asian_width`：`W`/`F` 记 2、
其余记 1，变体选择符 / ZWJ / 组合标记记 0）；改完看编辑器诊断确认清零。
