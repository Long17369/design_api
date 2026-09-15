import { describe, expect, it } from 'vitest'
import { bus } from '@core/bus'
import { registerConfigSection } from '@core/config'
import { applyConfigChanges, diffConfigSections } from '@core/config/utils'
import type { Config, ConfigChange } from '@core/config'

/** 伪造配置（只用到 section 值） */
const fakeConfig = (mqttPort: number, dbHost: string): Config =>
  ({
    mqtt: { mqtt_host: 'localhost', mqtt_port: mqttPort },
    database: { host: dbHost },
    port: 10452,
  }) as unknown as Config

const MQTT: ConfigChange = { section: 'mqtt', owner: 'TestMqtt' }
const PORT: ConfigChange = { section: 'port', owner: 'TestHttp' }
const DATABASE: ConfigChange = { section: 'database', owner: 'TestDatabase' }

/** 收集一次广播（订阅后自行取消） */
function observe(): { payloads: unknown[]; stop: () => void } {
  const payloads: unknown[] = []
  const stop = bus.onEvent('CONFIG_CHANGED', (payload) => {
    payloads.push(payload)
  })
  return { payloads, stop }
}

describe('配置 diff（按已注册 section）', () => {
  it('只报有变更的 section，并带上注册时标注的归属组件', () => {
    registerConfigSection({ name: 'mqtt', owner: MQTT.owner })
    registerConfigSection({ name: 'port', owner: PORT.owner })
    const changed = diffConfigSections(fakeConfig(1883, 'localhost'), fakeConfig(1884, 'localhost'))
    expect(changed).toEqual([{ section: 'mqtt', owner: 'TestMqtt' }])
  })

  it('逐键深比较：值相同（含键顺序不同）视为无变更', () => {
    registerConfigSection({ name: 'mqtt', owner: MQTT.owner })
    const a = { mqtt: { mqtt_host: 'h', mqtt_port: 1883 } } as unknown as Config
    const b = { mqtt: { mqtt_port: 1883, mqtt_host: 'h' } } as unknown as Config
    expect(diffConfigSections(a, b)).toEqual([])
  })
})

describe('热更新广播与回报（applyConfigChanges）', () => {
  it('全部回报后立即返回（不必等超时），状态如实收集', async () => {
    const start = Date.now()
    const stop = bus.onEvent('CONFIG_CHANGED', ({ changed, config, report }) => {
      expect(changed).toEqual([MQTT, PORT])
      expect(config.mqtt.mqtt_port).toBe(1884)
      report('mqtt', 'applied')
      report('port', 'restart-required')
    })
    const results = await applyConfigChanges([MQTT, PORT], fakeConfig(1884, 'localhost'))
    stop()

    expect(results.get('mqtt')).toBe('applied')
    expect(results.get('port')).toBe('restart-required')
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('无订阅者回报 → 超时兜底按未生效处理', async () => {
    const results = await applyConfigChanges([MQTT], fakeConfig(1884, 'localhost'), 20)
    expect(results.get('mqtt')).toBe('failed')
  })

  it('同一 section 重复回报只取首次', async () => {
    const stop = bus.onEvent('CONFIG_CHANGED', ({ report }) => {
      report('mqtt', 'applied')
      report('mqtt', 'failed')
    })
    const results = await applyConfigChanges([MQTT], fakeConfig(1884, 'localhost'))
    stop()
    expect(results.get('mqtt')).toBe('applied')
  })

  it('回报非本次变更的 section 被忽略（不产生多余项）', async () => {
    const stop = bus.onEvent('CONFIG_CHANGED', ({ report }) => {
      report('database', 'applied')
    })
    const results = await applyConfigChanges([MQTT], fakeConfig(1884, 'localhost'), 20)
    stop()

    expect(results.has('database')).toBe(false)
    expect(results.get('mqtt')).toBe('failed')
    expect([...results.keys()]).toEqual(['mqtt'])
  })

  it('多个订阅者各自处理自己的 section', async () => {
    const stopA = bus.onEvent('CONFIG_CHANGED', ({ changed, report }) => {
      if (changed.some((item) => item.section === 'mqtt')) report('mqtt', 'applied')
    })
    const stopB = bus.onEvent('CONFIG_CHANGED', ({ changed, report }) => {
      if (changed.some((item) => item.section === 'database'))
        report('database', 'restart-required')
    })
    const results = await applyConfigChanges([MQTT, DATABASE], fakeConfig(1884, '127.0.0.1'))
    stopA()
    stopB()

    expect(results.get('mqtt')).toBe('applied')
    expect(results.get('database')).toBe('restart-required')
  })

  it('广播载荷含新配置（组件据此取自己那一段）', async () => {
    const { payloads, stop } = observe()
    await applyConfigChanges([MQTT], fakeConfig(1885, 'db2'), 20)
    stop()

    const payload = payloads[0] as { config: Config }
    expect(payload.config.mqtt.mqtt_port).toBe(1885)
    expect(payload.config.database.host).toBe('db2')
  })
})
