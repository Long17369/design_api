import { AlarmModule } from './alarmModule'
import { AutoControlModule } from './autoControl'
import { DirectModule } from './directModule'
import { LockModule } from './lockModule'
import { SensorModule } from './sensorModule'

declare module '@modules' {
  AlarmModule
  AutoControlModule
  DirectModule
  LockModule
  SensorModule
}
