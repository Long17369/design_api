import { AutoComponent } from '@modules/autoControl'
import { flowTargetComponent } from './flowTarget'
import { flowUnchangedComponent } from './flowUnchanged'
import { flowZeroComponent } from './flowZero'
import { highPressureComponent } from './highPressure'
import { pressureZeroComponent } from './pressureZero'
import { reverseTempComponent } from './reverseTemp'
import { tempAnomalyComponent } from './tempAnomaly'
import { tempLimitComponent } from './tempLimit'

/**
 * 自动控制组件注册表（按 priority 升序执行）。
 * 新增规则 = 实现 AutoComponent 接口 + 在此注册（并自行保证幂等），引擎无需改动。
 *
 * 堵塞保护（block=true，命中即加锁（持久化在 device_locks，由 LockModule 负责））拆为 3 个独立判定：
 * 压力归零(10) / 累计流量不变(14) / 温度异常(16)，统一排在过压(20) 之前；
 * 流量归零(12) 已改为**可恢复的水泵空转保护**（泵运行 + 流量归零去抖 → 关泵告警，不加锁不判堵塞）。
 */
export const autoComponents: AutoComponent[] = [
  pressureZeroComponent,
  flowZeroComponent,
  flowUnchangedComponent,
  tempAnomalyComponent,
  highPressureComponent,
  reverseTempComponent,
  tempLimitComponent,
  flowTargetComponent,
].sort((a, b) => a.priority - b.priority)
