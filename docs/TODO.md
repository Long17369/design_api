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
>
> 测试与校验命令见 `docs/TESTING.md`（`pnpm test` / `pnpm type-check` / `tests/e2e/` 下的 E2E）。

## 自动控制 · 保护组件（`src/modules/autoControl/components/`）

- [x] 堵塞保护：打散为 4 个独立判定 —— `pressureZero`(10) / `flowZero`(12) / `flowUnchanged`(14) / `tempAnomaly`(16)，命中即 `heat=0+water=0` + 持久化 `blocked` + 加锁 + 告警
  - **2026-09-14 修「停泵被误判堵塞」**：`flowUnchanged`（累计流量不变）原先**不看水泵状态**，
    而停泵后累计流量本就不会变化 —— 真实记录：15:55:09 停泵 → 累计值冻结在 **791.08**
    （泵关期间 1072/1085 帧完全不变）→ **15:56:29 误报「水管堵塞：累计流量无变化」**（并上 `blocked` 锁）。
    现加两道前置：① 规则开关 **`flow_unchanged_enabled`**（默认开，新增配置项，配置页可关）；
    ② **水泵已稳定运行 ≥ `pump_start_grace` 秒**（复用该配置：泵停即清计时 ⇒ 不再误报；泵刚启动的
    宽限期内累计值可能还没开始增长，也不判定）⇒ 重新开泵后需重新累计满 `flow_unchanged_seconds`
  - 同类风险已核查：`pressureZero` 无泵状态前置，但实测停机期间压力为 **0.5~1.3**（不归零）⇒ 现状不会误报，暂不改
- [x] 恒温保护 `tempLimit`(80)：超 `temp_max` 关加热；低于 `temp_min` 且水泵运行中才开加热（防干烧）；上限优先；幂等
- [x] 累计流量目标 `flowTarget`(70)：跨越 `total_flow_target` 关泵一次，可随累计流量回落/调大目标重新触发
- [x] `overpressure` 冷却期（已实现）：超压 → 关加热关泵 + 加 `overpressure` 锁（**锁即状态**，冷却期 = 锁的 `expiresAt`）；期满压力仍高 → **顺延**（保留原快照）；压力回落 → 解锁，行为按配置：`overpressure_delay`(20s) / `overpressure_auto_release`(1) / `overpressure_on_release`(hold|resume，默认 hold)；`delay=0` 表示不限时（只等压力回落）
- [x] `reverseTemp` 逆温差（已实现）：**加热中** 且 出水(`wen_du2`) < 进水(`wen_du1`) − Δ 持续 `reverse_temp_seconds`(60s) → 黄色预警（**不控制设备**、不加锁）；状态组件自持（`since`/`alerted`，恢复正常即解除并可再次触发）；缺测/未加热不判定；`reverse_temp_seconds=0` 关闭。配置：`reverse_temp_delta`(2°C) / `reverse_temp_seconds`(60s)
- [x] `pumpIdle` 水泵空转（已实现，**并入 `flow_zero` 组件**）：水泵运行中 + 瞬时流量归零持续 `pump_idle_seconds`(60s) → 关泵（引擎自动先关加热）+ 黄色告警；**不加锁、不判堵塞**、流量恢复自动解除；`pump_idle_seconds=0` 关闭该保护。原「瞬时流量归零立即判堵塞」会误伤（泵停时流量本就为 0 + 单帧抖动即上锁），已修正为「泵运行 + 去抖 + 可恢复」
- [ ] `pfMismatch` 压力流量不匹配：**暂缓** —— 等真实数据标定 X/Y 阈值后再做（「建议降功率」需设备支持调速，暂不做）
- [x] `leak` 严重泄漏：**不实现（2026-09-13 决策）** —— 旧项目判定（泵开 + 压力骤降至 ≈0（<0.1kPa）+ 流量归零（<0.01L/min）持续 `leak_duration`(3s) → 关泵 + 可选 `leak` 锁；`leak_enable` **默认 `'0'` 关闭**）已被现有组件覆盖且反应更强：`pressureZero`(10) 压力 < `pressure_zero` 即 `blocked` 锁 + 关泵关加热；`flowZero`(12) 泵开 + 流量归零去抖即关泵告警。故**不新增组件、不 seed 那 5 项 `leak_*` 配置**（避免配置页出现永不生效的项）；`LockType` 的 `'leak'` 作为**预留成员保留**（对外类型稳定），代码/文档已标注「预留，无组件产生」。若将来真实数据表明需要「近零压力/流量时**只关泵不加锁**」的弱反应，再按本条重开
- [x] `pidTemp` PID 控温（已实现）：完整 PID（Kp/Ki/Kd，积分限幅防 windup）+ **PWM**（每 `pid_cycle` 秒一个周期，按占空比开关加热，每周期最多开关各一次 → 下发次数有界）；泵未运行/温度缺测不输出（防干烧）并重置 PID 状态；priority 75，排在恒温保护（80）之前，**超温等安全判定仍会覆盖其输出**；默认关闭（`pid_enabled=0`）。配置：`pid_target`(30)/`pid_kp`(4)/`pid_ki`(0.02)/`pid_kd`(0.5)/`pid_cycle`(60s)/`pid_sensor`(2)
  - **2026-09-14 修「升温段污染稳定段」（抗积分饱和）**：原先升温段把积分灌到限幅上限（`∫≤50` × Ki=0.02 **等效 100% 输出**），到温后比例项被积分顶住 → 输出维持 10~20%，温度停在目标之上 **30+ 分钟**（记录：14:38–15:10 钉在 40.2）。现改为：① 条件积分（输出已同向饱和时停止积分）② 积分项按**等效输出**限幅 `Ki·∫ ≤ 0.2` ③ **过冲（误差转负）/ 目标变化时清积分**。真实数据回放：平台期输出 15.0% → 3.2%
  - **2026-09-14 修「微分 60× 放大」（`fd96af0`）**：`dt` 原用**分钟**（`/60000`）而帧间隔约 1s、Ki/Kd 按秒给的量级 ⇒ 微分项放大 60 倍（0.1 ℃ 抖动 → `Kd·de = +3` → duty 打到 0/100%）。改为 `dtSec` 并限幅 `[0.2s, 10s]`；文档注明 **Ki/Kd 时间量纲为秒**（既存参数值需按此重新理解/整定）。探针：40.3→40.2→40.1 缓降时由 `heat=1（100%）` 变为 `heat=0`
  - **2026-09-14 修 PWM「0% 却开加热」（`1d29347`）**：原判定 `elapsed < duty × cycle` 在周期起点对任意小 duty 都为真 ⇒ 每周期白导通一帧（一帧满功率 ≈ 7~9 s 散热量，平均占空比被抬到 ~10%）。改为**按实际导通时长累计**（`onSec`，周期切换清零）+ **最小导通时间** `MIN_ON_SEC=1s`，`onSec` 只增不减 ⇒ 一旦关掉本周期不再开（天然最小关断时间）；`duty ≥ 1` 常开；日志占空比保留 1 位小数。含噪声闭环仿真：duty 分布 `=0% 54.4%/≥20% 31.2%` → `=0% 3.0%/1~19% 83.9%/≥20% 13.1%`
  - **2026-09-14 控温精度标定**（`tmp/pid_quant.ts`：真实组件 + 实测热模型 + **上报量化 0.1 ℃** + 传感器抖动，3 h 闭环，统计**真实水温**）：
    - 现有参数（Kp4/Ki0.02/Kd0.5，周期 60s）：偏差均值 −0.025 ℃、最坏 −0.07 ℃、**|偏差|>0.1 ℃ 时间占比 0%**（区间 [39.9, 40.0]，加热占比 13.7%）；`Kd=0` 结果相同（量纲修正后 Kd 影响很小）
    - **Kp 调小反而更差**：Kp1 → 13.1% 时间超 0.1；Kp0.5 → 52.3%（比例项不足、只能靠积分爬，稳态往下偏）。故 Kp≈4 合理，**不要往小调**
    - **不可控项（决定"能不能保证"）**：探头绝对偏置 —— 读数偏低 0.2 ℃ ⇒ 真值被抬到 40.1~40.2（100% 时间超 0.1），读数偏高 0.2 ⇒ 真值被压到 39.7~39.8。控制器只能把**它读到的值**稳到目标，**修不了探头误差**。若真机温度计钉在 40.2 而日志读数≈40.0，先查探头校准与测点位置（水温分层）
    - **硬件下限**：上报分辨率 0.1 ℃ ⇒ 控制器看到的误差自带 ±0.05 台阶 ⇒ 理论下限 ±0.05 ℃
    - 副产物：Kp=4 配 0.1 台阶 ⇒ duty 在 `0%`/`50%` 间跳（86%/14%）；温度不抖只因水箱热惯性大（实测时间常数 ≈ 1.7 h），不代表输出精细
    - **待定方案（未实现，需用户选）**：① `pid_deadband`（±0.1 ℃ 死区：偏差在带内不动作，代价是可能停在偏侧 39.9）；② 输出平滑/自适应（消量化 bang-bang）；③ 偏置修正（针对稳定负偏 −0.03~−0.1）
  - **2026-09-14 「稳在 40.0」标定**（`tmp/pid_hold40.ts` 仿真 + `tmp/probe_noise.mjs` 真机探头噪声）：
    - 真机探头**很安静**（14:00–18:00 相邻帧 |ΔT|=0 占 **94.4%**、±0.1 占 5.4%、无抖动）→ 按「无测量噪声」档取结论
    - **静态偏差 = 负的半个上报步长**：读数 = 目标对应的真值区间是 `[t−0.05, t+0.05]`，而控制器在**下沿**（读数一旦 = 目标）就停加热 ⇒ 真值停在 `t−0.044`（仿真 39.956）。**补偿量 = +半个步长（+0.05）**，实测最优值与理论一致
    - 但 **Kp=4 时补偿不稳定**：δ≥0.025 就整步跳档（真值 → 40.056、读数变 40.1）；**Kp=1 时鲁棒**（δ∈[0.02,0.06] 可单调微调）
      | 配置 | 真值均值 | 纹波带 | 显示 40.0 占比 |
      |---|---|---|---|
      | Kp4 δ0（现状） | 39.956 | **0.02** | 86% |
      | Kp1 δ0 | 39.956 | 0.02 | 86% |
      | **Kp1 δ+0.05（建议）** | **39.999** | 0.12 | **95%** |
      | Kp4 δ+0.05 | 40.056（整步跳） | 0.02 | 14%（显示 40.1） |
    - **建议（现场标定，零代码）**：`pid_kp` 4 → **1**、`pid_target` 40.0 → **40.05**（半步补偿）⇒ 真值稳在 40.00（均值 39.999）、95% 时间显示 40.0
      （**已被下面的第二轮结论取代**：还需把 `pid_cycle` 缩短，见下）
    - **「完全不变」不可达**：真值纹波下限 ≈ **0.02 ℃**（PWM 开关 + 散热波动的物理极限）。要**读数恒为 40.0** 必须把设备端水温上报精度 **0.1 → 0.01 ℃**（仿真：真值 40.002 ± 0.05、偏差>0.05 占比 0%）
    - 待定：半步补偿写进 `pid_target` 会与配置页"目标温度"显示冲突 → 可选加配置项 `pid_target_offset`（默认 0，表内仍显示 40.0），等用户选
    - **第二轮：以「显示 40.0 的时长占比」为目标扫参**（`tmp/pid_maxat40.ts` 网格 + `tmp/pid_verify.ts` 12 h 验证）
      - 关键机理：纹波带 ≈ **一个 PWM 周期内连续导通时长 × 0.015 ℃/s**（= `duty × pid_cycle × 0.015`）
        —— 带子只由**周期**决定、与 Kp/Ki 关系不大（这就是一堆参数组合都卡在 95% 的原因）
      - 12 h 实测（安静探头 / 含 ±0.02 慢抖 + 0.05 尖峰 / 下发次数）：
        | 配置 | 显示 40.0 | 有噪声 | 下发/h |
        |---|---|---|---|
        | 现状 Kp4 Kd0.5 δ0 周期60 | 86.3% | 86.3% | **985** |
        | **Kp2 Kd0.5 δ0.04 周期25（推荐）** | **98.6%** | **94.7%** | 412~463 |
        | Kp2 Kd0.5 δ0.04 周期30 | 96.9% | 94.6% | 384~476 |
        | Kp1 Kd0 δ0.05 周期30 | 97.8% | 93.9% | 322~563 |
        | Kp2 Kd0 δ0.05 周期25 | 95.3% | 93.4% | 417~427 |
      - **最终建议（零代码，只改 3 个配置值）**：`pid_kp` 4 → **2**、`pid_target` 40 → **40.04**（半步补偿）、
        `pid_cycle` 60 → **25**；Kd 影响可忽略（保留 0.5）
        ⇒ 显示 40.0 的时长占比 **86% → 98.6%**（含零星抖动 94.7%），且下发次数**减少一半以上**
        （**已被下面的第三轮取代**：加上硬滞环后同一配置为 96.5%、但开关次数降到 288/h）
      - 试过把 PWM 换成 **ΔΣ 调制**（按「欠账」导通、导通段 = 1 帧）：只多 +0.5 pp，但下发翻倍（→ 988/h）⇒ **不做**（补丁已还原）
      - 剩余越界来源：① 探头零星抖动把读数推出 bin（±0.05 尖峰 ≈ −4 pp）② 纹波带 0.10~0.12 略宽于 bin 0.1；
        周期 25 s 已是「纹波 vs 1 帧占空比颗粒（=1/周期）」的最优点（更短周期颗粒变粗：15 s → 96.8%）
    - **第三轮：设备是机械继电器 ⇒ 开关次数优先**（`1d29347` 后新加硬滞环，见下）
      - 发现缺陷：旧实现允许「关掉后 duty 回升又开」⇒ duty 在量化台阶边缘抖动时继电器**帧级反复吸合**，
        实测 750~985 次/h，**把周期拉长到 300 s 也压不下来**（851/h）——即旧实现根本做不到「少开关」
      - **修复：硬滞环**（本周期关掉即锁定 + 关断后 ≥3 s 才允许再开；`duty` 饱和的升温路径也守 3 s）
        ⇒ 开关次数 = **2/周期**（`pid_cycle` 25 → 288/h，60 → 120/h，300 → 24/h），可精确预测
        ⚠️ 代价：修正延后到下一周期 ⇒ **必须配 `δ` 补偿**（`δ=0` 时真值挂低 0.1 ℃、显示占比只有 6.6%）
      - 权衡表（12 h、安静探头；**纹波(℃) × 开关次数(/h) ≈ 14.8** 是硬规律，两种调制方式交叉验证）：
        | `pid_cycle` | 开关次数 | 显示 40.0 |
        |---|---|---|
        | 20 s | 360/h | 97.1% |
        | **25 s（推荐）** | **288/h** | **96.5%**（含抖动 83.1%） |
        | 30 s | 240/h | 95.0% |
        | 60 s | 120/h | 79.7% |
        | 120 s | 60/h | 40.3% |
        | 300 s | 24/h | 16.1% |
      - **最终建议（继电器场景）**：`pid_kp` 4 → **2**、`pid_kd` 0.5 → **0**、`pid_target` 40 → **40.04**、`pid_cycle` 60 → **25**
        ⇒ 显示 40.0 **6.6% → 96.5%**，开关 985 → **288 次/h**（要更少开关就取 60 s → 120/h、占比 79.7%）
      - 用户思路「开 1s 关 9s」= 同一权衡的另一端（极小周期，实测 987 次/h、96.5%）⇒ 温度最稳但开关最多
    - **第四轮：用户要求「优先保证不出 0.1 偏差」⇒ PWM 改 ΔΣ 调制**（`c107619`）
      - 旧实现按周期清零欠账 ⇒ 每周期占空比量化成整数帧：`pid_cycle`=8 时每周期最多 1 帧 = 12.5%，
        而需求 13.7% ⇒ 温度被钉在 38.7 ℃（差 1.3 ℃）——即「1s 段」在旧实现下根本给不出正确占空比
      - 新机制：欠账 `∫(duty − 实际导通)` **跨周期累积**，满一段就开、还清就关；
        段长 = `clamp(duty × pid_cycle, 1s, 2s)`（`pid_cycle` 仍是平均周期；上限 2s 防大周期段长过粗）
      - 两个关键坑（均已修 + 用例覆盖）：① 关断开锁会把累积欠账压掉 ⇒ 导通段被截断；
        ② 过冲不清欠账 ⇒ OFF 期累积的欠账在过冲后继续放热，实测大过冲 0.61 ℃（修后 0.02 ℃）
      - 12 h 实测（安静探头 / 含抖动 / 下发次数）：
        | 配置 | 显示目标 | 含抖动 | 下发/h |
        |---|---|---|---|
        | **Kp2 Ki0.02 Kd0 δ0.02 周期8（推荐）** | **99.0%** | 89.6% | 493 |
        | Kp2 Ki0.02 Kd0 δ0.04 周期60（少开关） | 96.2% | 91.7% | 330 |
        | 现状（Kp4 Kd0.5 δ0 周期60） | 31.7% | 63.3% | 366~984 |
    - 工具：`tests/e2e/pid_calib.mjs`（只读标定/验收统计：读数占比、带宽、静态偏差、duty 分布；流程与判定标准见 `docs/TESTING.md`）
  - 仍未处理（后续）：**参数需按「秒」重新整定**（Ki/Kd 量纲变更 + 实测升温:散热 ≈ 7~9:1，稳定段所需 duty 约 13%）；数据库 `pid_enabled` 仍为 0（PID 实际未启用）；`E2E_BLOCK` 遗留的设备/锁记录待清
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
- [x] 离线告警 `sensor_offline`（已实现）：引擎内 **5s 轻量定时器**（`unref` 不阻塞退出）扫描最近上报时刻，超过 `sensor_offline_seconds`(60s，支持设备级覆盖) → 写 `error_msg(field3='offline')` + WS 告警（warning，只告警一次）；恢复上报推 `type='reset'`（前端清横幅），再次离线可再次告警；**不做**旧项目的「暂停自动控制」
- [x] **传感器离线哨兵值剔除**（2026-09-14）：设备传感器断线时上报 **6553.5**（= 0xFFFF/10，实测 `temp_in`/`temp_out` 各 41~42 帧，其余字段正常），原先会当作**真实温度**进入自动控制（超温关加热、温度异常判堵塞）与前端曲线。现于**数据入口**（`sensorModule.process` 首行）统一剔除为**空串**（缺测）
  - 下游天然一致：`toNum('')` → null（组件按缺测跳过）、`buildSensorRow` 跳过空值（该列**落库为 NULL**）、`pushSample`/`accumulateFlow` 跳过 null ⇒ 一处生效
  - 覆盖字段：`temp_in` / `temp_out` / `pressure` / `flow_rate`（开关类字段不参与）；哨兵常量 `OFFLINE_SENTINELS = [65535, 6553.5]`（`sensorModule/utils.ts`）
- [x] 设备状态同步（已实现）：设备上报开关状态与 `direct` 指令值**连续 `device_sync_frames` 帧不一致** → 以**设备实际状态**为准回写（写 direct + 下发 + `source='device'` 通知 + `control_log(field1='device')` + `device_sync` 告警）；指令值一变化即重新计数（避免下发的控制被设备上报滞后同步回去）；**默认 0（关闭）**，可按设备启用
- [x] 关泵连带关加热（两层防护，已实现）：① 引擎统一规则 —— 任何「关泵」动作若加热仍开，自动在其前面补一条「关加热」（按序跟踪，决策自身已关加热时不重复下发）；② 状态兜底 —— 水泵停止（**指令值或上报泵状态任一为「泵停」**）且加热仍开 → 立即关加热（不受启动宽限期影响，放在决策之后执行避免重复写库）
- [x] 数据质量标记 `WsData.invalid`（已实现）：**阈值配置化**（`sensor_spike_temp`(10°C)/`sensor_spike_pressure`(20kPa)/`sensor_spike_flow`(100L/min)）+ **多帧累计防抖**（`sensor_spike_frames`，默认 0=关闭，连续 N 帧跳变才标记 invalid，恢复正常即清除）；缺测不算跳变；只在 WS `data` 上标记（前端曲线标注），不影响落库与控制
- [x] 告警类型区分：`AlarmDef` 增加 `type`（'alarm' | 'error' | 'reset'）与 `category`（写 `error_msg.field3`，默认 `'block'`）由组件自带，替代写死的 `error_msg.field3='block'`；既有组件不传新字段 → 行为不变

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
- [x] 历史图表：`GET /api/{sensor|behavior|error|control}/chart`（时间桶 AVG 降采样：`d_no`/`start`/`end`/`buckets`；旧契约 `/api/data/chart` 由客户端 `'data'` 别名兼容；客户端函数 `api.ts::getChartData`）
- [x] 指令配置/数据：`GET /api/direct/config`、`GET /api/direct/data?d_no=`、`POST /api/direct/update`
- [x] 手动控制 `POST /api/control`：`auto=1` 时拒绝手动开/关；写 direct + 下发 + WS 通知 + `control_log(manual)`
- [x] 手动复位：`POST /api/control/reset`
- [x] 前端契约：`api.ts::sendControlCommand` / `resetDeviceBlock`
- [x] `direct_config.blocked` 内部标记外泄给 `GET /api/direct/config`：**已解决** —— 配置行删除（列表回到 18 项），堵塞标记改由 `device_locks` 承担
- [x] 配置项层级门控：`GET /api/direct/config?d_no=` 按 `ref_code`/`ref_value` **递归**过滤（父开关未开启时子配置不下发到配置页）；子项重新挂到各自开关（`pid_enabled`/`flow_target_enabled`/`sensor_spike_enabled`），跳变检测由 `sensor_spike_frames>0` 改为显式开关 `sensor_spike_enabled`；不传 `d_no` 仍返回全量（向后兼容）。迁移 SQL 见 `docs/API-CHANGES.md`
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
- [x] WS 服务路径固定为 `/api/ws`（与 HTTP `/api` 前缀对齐）：非该路径的 upgrade 返回 HTTP 400；`?goal=` 照常可用（前端 URL 需同步加 `/api` 前缀）
- [x] 契约导出 WS 连接接口：`connectWebSocket(goal?)` 直接返回连接实例（地址按 `location` 拼绝对地址；`goal` 用于重连复用 token）
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
- [x] 缓存 key 规范与清单：`@core/cache` 只提供通用能力（KV + TTL + tag 失效），**key 由使用它的模块自己定义**（不在 core 集中登记）；命名 `<模块>:<用途>`、`tag` 必须等于来源表名；清单与编码规范见 `docs/CACHE.md`
- [x] seeds 一致性自检：`tests/e2e/verify_seeds.ts` 逐表逐列比对「seeds 定义 vs 库中现有行」（输出 `SEEDS_EQUIVALENT_OK`）；借此发现并修掉 `sensor_spike_*` 的 `order` 漂移（新增开关行后原 4 行未后移，出现重复 21 号）——seeds 只补不覆盖，改既有行定义必须手工迁移（SQL 见 `docs/API-CHANGES.md` 升级须知）
- [x] 累计流量持久化（已实现）：进程启动后首次上报时，从该设备**最后一条落库帧**（mapper 中 `api_name='liu_liang1'` 对应列，默认 `field5`）恢复累计值 → 重启不再归零（日志「累计流量已恢复: <d_no> = <N>L」）；无历史数据则从 0 开始

## 工程 / 工具 / 依赖

- [x] 运行与校验：`tsx` 运行（勿用 ts-node）、`pnpm type-check` / `lint` / `format`
- [x] 类型出口统一：`MQTTMessageOut` 以 `src/types/types.ts` 为唯一定义来源；`types.ts` 属对外契约保持稳定
- [x] 清理：删除空 `runtime/` 目录、移除 `test` 占位脚本
- [x] 测试工程化：**vitest 单测**（`pnpm test`，`tests/` 7 文件 41 用例）覆盖组件判定/告警/PID/缓存/图表/配置层级/跳变检测；**E2E 全链路脚本已入库到 `tests/e2e/`**（22 个，依赖真实 MySQL/MQTT/服务，用法见 `docs/TESTING.md`）；`pnpm type-check` 覆盖 `src`+`tests`；`tmp/` 只留运行产物（已 gitignore）
- [x] `MQTT_MESSAGE`：**保留**声明 —— 骨架期设计的「入站消息经 bus 广播」事件，后改为 topicHandlers 直接处理后闲置；将来做统一入站分发可复用（此处备注来历，不删）
- [x] `errorMessage`：**暂留** —— 为后续「服务器驱动化」重构预留的事件通道，届时再定去留
- [x] 死依赖：**不动**（`uuid` / `dotenv` / `nodemon` / `ts-node` 保留；`jiti` 为 ESLint 加载 TS 配置所需，勿删）
