import { describe, expect, it } from 'vitest'
import { filterVisibleConfigs } from '@modules/directModule/utils'
import { DirectConfig } from '@/types/types'

/**
 * 配置层级门控（`ref_id`/`ref_value`）单测：
 *  ① 顶层（无 ref_id）恒可见
 *  ② 父值取「设备值 → 父 default_value」，命中 ref_value 才可见（支持 '1|2' 多值）
 *  ③ 递归：祖先不可见 → 后代一律不可见
 *  ④ 父不存在 / 父值为空 → 不可见；ref_value 为空时父值非空即可见
 */
const cfg = (id: string, over: Partial<DirectConfig> = {}): DirectConfig =>
  ({
    id,
    ref_id: null,
    ref_value: null,
    t_name: id,
    f_type: '2',
    f_value: null,
    mode: null,
    max: null,
    min: null,
    order: '1',
    topic: null,
    preffix: null,
    icon: null,
    type: 'string',
    default_value: null,
    ...over,
  }) as DirectConfig

const ids = (list: DirectConfig[]) => list.map((c) => c.id)

describe('filterVisibleConfigs（配置层级门控）', () => {
  const CONFIGS: DirectConfig[] = [
    cfg('auto', { default_value: '0' }),
    cfg('heat', { ref_id: 'auto', ref_value: '0', default_value: '0' }),
    cfg('water', { ref_id: 'auto', ref_value: '0', default_value: '0' }),
    cfg('temp_max', { ref_id: 'auto', ref_value: '1', default_value: '35' }),
    cfg('pid_enabled', { ref_id: 'auto', ref_value: '1', default_value: '0' }),
    cfg('pid_target', { ref_id: 'pid_enabled', ref_value: '1', default_value: '30' }),
    cfg('pid_kp', { ref_id: 'pid_enabled', ref_value: '1', default_value: '4' }),
    cfg('flow_target_enabled', { ref_id: 'auto', ref_value: '1', default_value: '0' }),
    cfg('total_flow_target', {
      ref_id: 'flow_target_enabled',
      ref_value: '1',
      default_value: '100',
    }),
    cfg('multi', { ref_id: 'auto', ref_value: '0|2', default_value: '7' }),
    cfg('anyvalue', { ref_id: 'auto', ref_value: null, default_value: 'x' }),
    cfg('orphan', { ref_id: 'not_exists', ref_value: '1', default_value: null }),
    cfg('empty_parent', { ref_id: 'auto', ref_value: null, default_value: '8' }),
    cfg('null_default', { default_value: null }),
    cfg('child_of_null', { ref_id: 'null_default', ref_value: '1', default_value: '1' }),
  ]

  it('未指定设备值：按父 default_value 判定（auto=0 → 手动项可见、自动项隐藏）', () => {
    const visible = ids(filterVisibleConfigs(CONFIGS))
    expect(visible).toContain('auto')
    expect(visible).toContain('heat')
    expect(visible).toContain('water')
    expect(visible).not.toContain('temp_max')
    expect(visible).not.toContain('pid_enabled')
    expect(visible).not.toContain('pid_target')
  })

  it('自动模式（auto=1）：阈值可见、手动项隐藏；PID 未开启时其子项仍隐藏', () => {
    const visible = ids(filterVisibleConfigs(CONFIGS, new Map([['auto', '1']])))
    expect(visible).toContain('temp_max')
    expect(visible).toContain('pid_enabled') // 开关本身可见
    expect(visible).not.toContain('pid_target') // 开关未开启 → 子项隐藏
    expect(visible).not.toContain('heat')
    expect(visible).not.toContain('water')
  })

  it('开启 PID 后其子项出现（设备值优先于 default_value）', () => {
    const values = new Map([
      ['auto', '1'],
      ['pid_enabled', '1'],
    ])
    const visible = ids(filterVisibleConfigs(CONFIGS, values))
    expect(visible).toContain('pid_target')
    expect(visible).toContain('pid_kp')
    // 更深一层：流量目标未开启 → 其子项不出现
    expect(visible).toContain('flow_target_enabled')
    expect(visible).not.toContain('total_flow_target')
  })

  it('递归：祖先不可见则后代不可见（auto=0 时 pid 子项也隐藏）', () => {
    const visible = ids(filterVisibleConfigs(CONFIGS, new Map([['pid_enabled', '1']])))
    expect(visible).not.toContain('pid_enabled') // 父 auto=0 → 开关自身不可见
    expect(visible).not.toContain('pid_target')
  })

  it('多值与边界：ref_value 支持 1|2；父缺失/父值真为空 → 隐藏；ref_value 为空则父值非空即可见', () => {
    const visible = ids(filterVisibleConfigs(CONFIGS, new Map([['auto', '2']])))
    expect(visible).toContain('multi')
    expect(visible).toContain('anyvalue')
    expect(visible).toContain('empty_parent')
    expect(visible).not.toContain('orphan')

    // 设备值为 '' → 回退父 default_value（'0'）→ 手动项与「任意值」子项仍可见，自动项隐藏
    const emptyDeviceValue = ids(filterVisibleConfigs(CONFIGS, new Map([['auto', '']])))
    expect(emptyDeviceValue).toContain('heat')
    expect(emptyDeviceValue).toContain('anyvalue')
    expect(emptyDeviceValue).not.toContain('temp_max')

    // 父值真正为空（父 default_value 为 null 且无设备值）→ 子项隐藏
    expect(ids(filterVisibleConfigs(CONFIGS))).not.toContain('child_of_null')
  })
})
