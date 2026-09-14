import fs from 'node:fs'
import path from 'node:path'
import Ajv from 'ajv'
import { log } from '@core/logger'
import { ConfigSectionDef, ConfigSectionName } from '.'

const logger = log.getLogger('Config')

/**
 * 已注册的配置 section（name → 定义）。
 * 内容由**消费该 section 的组件**自行登记（见 `registerConfigSection`），本模块不自带清单。
 */
const registeredSections = new Map<ConfigSectionName, ConfigSectionDef>()

/**
 * 注册配置 section —— 由**消费该 section 的组件**在构造时调用
 * （与 `Config` 的类型注册同源：谁消费谁声明，见 `config.d.ts`）。
 *
 * 同名覆盖：进程内重建（`Server.restart()`）会重建组件并重新注册，不会重复累积。
 */
export function registerConfigSection(section: ConfigSectionDef): void {
  registeredSections.set(section.name, section)
}

/** 当前已注册的配置 section（按注册顺序） */
export function getConfigSections(): ConfigSectionDef[] {
  return [...registeredSections.values()]
}

/** 解析 '@root/...' 等 tsconfig paths 别名为项目根下的真实路径（开发期以进程工作目录为根） */
function resolveConfigPath(p: string): string {
  if (p.startsWith('@root/')) {
    return path.resolve(process.cwd(), p.slice('@root/'.length))
  }
  return path.resolve(process.cwd(), p)
}

export class Config {
  private path: string
  private schemaPath: string

  constructor(path: string, schemaPath: string = '@root/config.schema.json') {
    this.path = path
    this.schemaPath = schemaPath
    try {
      this.init()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`读取配置文件失败: ${message}`)
    }
  }

  /** 同步读取并校验配置文件，将结果合并到实例属性上 */
  private init() {
    const config = JSON.parse(fs.readFileSync(resolveConfigPath(this.path), 'utf-8')) as object
    const schema = JSON.parse(
      fs.readFileSync(resolveConfigPath(this.schemaPath), 'utf-8'),
    ) as object
    const ajv = new Ajv({
      useDefaults: true,
      removeAdditional: true,
      coerceTypes: false,
      allErrors: false,
      strict: false,
    })
    const validate = ajv.compile(schema)
    if (!validate(config)) {
      logger.error(`验证配置文件失败: ${validate.errors?.map((e) => e.message).join(', ')}`)
      return
    }
    Object.assign(this, config)
  }
}
