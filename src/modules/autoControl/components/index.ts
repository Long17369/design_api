import { AutoComponent } from '@modules/autoControl'
import { lowPressureComponent } from './lowPressure'
import { highPressureComponent } from './highPressure'
import { zeroFlowComponent } from './zeroFlow'

/**
 * 自动控制组件注册表（按 priority 升序执行）。
 * 新增规则 = 实现 AutoComponent 接口 + 在此注册，引擎无需改动。
 */
export const autoComponents: AutoComponent[] = [
  lowPressureComponent,
  highPressureComponent,
  zeroFlowComponent,
].sort((a, b) => a.priority - b.priority)
