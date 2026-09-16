import { Config } from '@core/config'
import { Database } from '@core/database'
import { lockManager } from '@core/locks'
import { bus } from '@core/bus'
import { DirectModule } from '@modules/directModule'
import { dryBurnComponent } from '@modules/autoControl/components/dryBurn'
import { buildAutoConfig, loadConfigDefaults } from '@modules/autoControl/utils'
import { AutoCtx } from '@modules/autoControl'
import type { WsData } from '@/types/types'

/**
 * 加热棒干烧保护验证（真实库，进程内构造，不需要起服务）
 * 运行：`pnpm exec tsx tests/e2e/dry_burn.ts`（仓库根目录）
 *
 * 覆盖：
 *  ① seeds 落库：dry_burn_enabled / dry_burn_seconds / dry_burn_heat_rate 三个配置行
 *  ② 组件判定：窗口内加热累计达标 + heat_rate 低于阈值 → 关加热 + 加 dry_burn 锁（deny heat）+ 告警
 *  ③ 锁定生效：`DirectModule.setValue(heat=1)` 被拒（关动作不受限）
 *  ④ 手动复位：`resetBlock()` 释放锁、按快照恢复（**加热保持关闭**，不自动恢复加热）
 *  ⑤ 复位后条件仍成立可再次判定
 */
const D_NO = 'DRY_E2E'

const config = new Config('@root/config.json')
const db = new Database()
await db.setConfig(config.database)
const dm = new DirectModule()
dm.setDatabase(db)

const checks: Array<{ name: string; ok: boolean }> = []
const check = (name: string, cond: boolean) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}

const cleanup = async () => {
  lockManager.releaseAll(D_NO)
  lockManager.clearSnapshot(D_NO)
  await db.delete('direct', { d_no: { operator: '=', value: D_NO } })
  await db.delete('control_log', { d_no: { operator: '=', value: D_NO } })
}
await cleanup()
dryBurnComponent.clearState?.(D_NO)

// ---------- ① 配置行已落库 ----------
const defaults = await loadConfigDefaults(db)
check(
  '① seeds 已落库 dry_burn_enabled/seconds/heat_rate',
  defaults.get('dry_burn_enabled') === '1' &&
    defaults.get('dry_burn_seconds') === '15' &&
    defaults.get('dry_burn_heat_rate') === '0.4',
)

// ---------- ② 组件判定 ----------
const cfg = buildAutoConfig(defaults)
const frame = (heat: '0' | '1', rate: string): WsData => ({
  d_no: D_NO,
  timestamp: '2026-09-16 10:00:00',
  wen_du1: '20',
  wen_du2: '30',
  jia_re: heat,
  shui_beng: '1',
  liu_liang1: '0.00',
  liu_liang2: '5',
  pressure: '5',
  heat_rate: rate,
  avg_flow: '5',
})

const ctxOf = (heat: '0' | '1', rate: string, now: number): AutoCtx => ({
  d_no: D_NO,
  data: frame(heat, rate),
  cfg,
  state: { pumpOn: true, pumpStartedAt: now, blocked: false, history: [] },
  now,
  inPumpGrace: false,
  values: new Map<string, string>([
    ['heat', heat],
    ['water', '1'],
  ]),
})

// 先写入设备级 heat=1（模拟正在加热）
await dm.setValue({ config_id: 'heat', value: '1', d_no: D_NO, source: 'auto', notify: false })

let decision = dryBurnComponent.evaluate(ctxOf('1', '0', 0))
check('② 加热累计未达标时不判定', decision === null)
decision = dryBurnComponent.evaluate(ctxOf('1', '0', (cfg.dryBurnSeconds + 1) * 1000))
check('② 达标 + 加热速度为 0 → 判定干烧并关加热', decision?.alarm?.code === 'dry_burn')
check('② 干烧锁已加且禁止加热', lockManager.isDenied(D_NO, 'heat'))

// ---------- ③ 锁拦截加热（关闭动作不受限） ----------
let blocked = false
try {
  await dm.setValue({ config_id: 'heat', value: '1', d_no: D_NO, source: 'manual', notify: false })
} catch (err) {
  blocked = true
  console.log(`   拦截信息：${err instanceof Error ? err.message : String(err)}`)
}
check('③ 锁住后开启加热被拒', blocked)
await dm.setValue({ config_id: 'heat', value: '0', d_no: D_NO, source: 'manual', notify: false })
check('③ 关闭加热不受锁限制', true)

// ---------- ④ 手动复位 ----------
await dm.resetBlock(D_NO)
const heatAfterReset = (await dm.listByDevice(D_NO)).find((row) => row.config_id === 'heat')
check('④ 复位释放干烧锁', lockManager.get(D_NO, 'dry_burn') === undefined)
check('④ 复位后加热保持关闭（快照 heat=0）', heatAfterReset?.value === '0')

// ---------- ⑤ 复位后可再次判定 ----------
dryBurnComponent.clearState?.(D_NO)
dryBurnComponent.evaluate(ctxOf('1', '0', 100_000))
const again = dryBurnComponent.evaluate(ctxOf('1', '0', 100_000 + (cfg.dryBurnSeconds + 1) * 1000))
check('⑤ 复位后条件仍成立可再次判定', again?.alarm?.code === 'dry_burn')

await cleanup()
dm.close()
await db.close()
bus.emitEvent('shutdown', { reason: 'e2e' })

if (checks.some((c) => !c.ok)) {
  console.log(
    'FAILED:',
    checks
      .filter((c) => !c.ok)
      .map((c) => c.name)
      .join(' | '),
  )
  process.exit(1)
}
console.log('DRY_BURN_OK')
process.exit(0)
