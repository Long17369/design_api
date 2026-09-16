import { AutoCtx, AutoDecision, ControlAction, RelayedControl } from '@modules/autoControl'

/**
 * 引擎级安全不变式：**加热只在有水流时允许通电**（泵热联锁）。
 *
 * 为什么放在引擎而不是做成组件：这两条是引擎必须无条件保证的**不变式**，而不是"某个可开关的判定规则"——
 * 判定组件是"看数据 → 出决策"，可能被宽限期跳过、也可能被前一个决策的 `stop` 终止，而本条必须**始终成立**。
 * 因此由引擎在**两个固定点**调用（调用点见 `index.ts`）：
 * - `ensureHeatOffBeforePumpOff`：**执行决策前**改写控制序列（关水泵前先关加热）；
 * - `enforcePumpHeatOff`：**全部决策执行完、设备状态同步之前**兜底（泵已停而加热仍开 → 立刻关加热）。
 */

/**
 * 不变式①：控制序列里出现「关水泵」且此时加热仍开时，自动在**前面**补一条「关加热」
 * —— 水泵停机后加热器不得继续工作（防干烧）。
 *
 * 注意：按序跟踪（`heatClosing`）——若决策自身已经先关了加热（如堵塞保护 `[heat, water]`），
 * 则不再补重复的控制，保证一次决策对同一目标只下一次指令。
 *
 * @param ctx 当前帧上下文（读 `values` 里加热的当前值）
 * @param controls 决策给出的控制序列
 * @returns 补好「关加热」的控制序列（补出来的那条带 `relay` 标记）
 */
export function ensureHeatOffBeforePumpOff(
  ctx: AutoCtx,
  controls: ControlAction[],
): RelayedControl[] {
  const out: RelayedControl[] = []
  let heatClosing = ctx.values.get('heat') !== '1'
  for (const control of controls) {
    if (control.target === 'heat' && control.value === '0') heatClosing = true
    if (control.target === 'water' && control.value === '0' && !heatClosing) {
      out.push({ target: 'heat', value: '0', relay: true })
      heatClosing = true
    }
    out.push(control)
  }
  return out
}

/**
 * 不变式②：水泵已停（**指令值或上报泵状态任一为泵停**）而加热仍开 → 立刻关加热。
 *
 * 覆盖「设备自行停泵」「手动关泵」等绕过自动控制决策的场景（这就是它必须读**遥测**的原因，
 * 只靠下发通道拦截不足以保证）；受 `pump_heat_interlock_enabled` 控制，可整体关闭。
 *
 * @param ctx 当前帧上下文
 * @returns 需要关加热时的决策（理由即落库文案）；无事可做返回 null
 */
export function enforcePumpHeatOff(ctx: AutoCtx): AutoDecision | null {
  const { cfg, values, data } = ctx
  if (!cfg.pumpHeatInterlockEnabled) return null
  if (values.get('heat') !== '1') return null

  const pumpStopped = values.get('water') === '0' || data.shui_beng !== '1'
  if (!pumpStopped) return null

  return {
    reason: '安全规则：水泵停止，关闭加热',
    controls: [{ target: 'heat', value: '0' }],
  }
}
