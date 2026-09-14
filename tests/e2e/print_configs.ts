import { Config } from '@core/config'
import { Database } from '@core/database'
import { DirectModule } from '@modules/directModule'

const config = new Config('@root/config.json')
const database = new Database()
database.setConfig(config.database)
const dm = new DirectModule()
dm.setDatabase(database)
const list = await dm.listConfigs()
console.log('接口返回条数:', list.length)
console.log(`指令配置共 ${list.length} 项（内部堵塞标记已迁至 device_locks，不再出现在配置列表中）`)
process.exit(0)
