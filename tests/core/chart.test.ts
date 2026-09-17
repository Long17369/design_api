import { describe, expect, it } from 'vitest'
import { buildChartSQL, resolveChartStep } from '@core/database/utils'
import { buildTableInfoMap } from '@core/database/utils'
import sensor_data from '@core/database/tables/sensor_data'
import { findTableInfo } from '@core/database/utils'
import { getChartData } from '@/types/api'

/**
 * 图表聚合（时间桶降采样）单测：
 *  ① 步长计算：总时长/桶数向上取整、最小 1 秒、桶数上限收敛
 *  ② SQL 结构：桶标签取 MAX(c_time)、数据列 AVG、GROUP BY 步长、时间范围条件与参 数顺序
 *  ③ 附加过滤条件（d_no）拼接；无 c_time 列的表报错
 */
const info = findTableInfo(buildTableInfoMap([sensor_data]), 'sensor_data')

/** 'YYYY-MM-DD HH:mm:ss'（本机墙钟）→ Date */
const at = (value: string) => new Date(value.replace(' ', 'T'))

describe('resolveChartStep（时间桶步长）', () => {
  it('总时长 / 桶数，向上取整，最小 1 秒', () => {
    // 1000s / 100 桶 → 每桶 10s
    expect(resolveChartStep(at('2026-09-12 00:00:00'), at('2026-09-12 00:16:40'), 100)).toBe(10)
    // 1000s / 999 桶 → ceil(1.001) = 2
    expect(resolveChartStep(at('2026-09-12 00:00:00'), at('2026-09-12 00:16:40'), 999)).toBe(2)
    // 1s 窗口 + 1000 桶 → 最小 1 秒
    expect(resolveChartStep(at('2026-09-12 00:00:00'), at('2026-09-12 00:00:01'), 1000)).toBe(1)
  })

  it('非法/逆序时间与非法桶数退化为 1 秒；桶数超上限收敛', () => {
    expect(resolveChartStep(new Date('bad'), new Date('also-bad'), 100)).toBe(1)
    expect(resolveChartStep(at('2026-09-12 00:00:10'), at('2026-09-12 00:00:00'), 100)).toBe(1)
    expect(resolveChartStep(at('2026-09-12 00:00:00'), at('2026-09-12 01:00:00'), 0)).toBe(
      Math.ceil(3600 / 1000),
    )
    // buckets 超上限（10000）时按上限计算：3600s / 10000 → ceil(0.36) = 1
    expect(resolveChartStep(at('2026-09-12 00:00:00'), at('2026-09-12 01:00:00'), 999_999)).toBe(1)
  })
})

describe('buildChartSQL（聚合 SQL）', () => {
  it('按桶 AVG 数据列并带时间范围条件（参数顺序：where 在前、step 在末）', () => {
    const { sql, params } = buildChartSQL(info, {
      where: { d_no: { operator: '=', value: 'DEV1' } },
      start: at('2026-09-12 00:00:00'),
      end: at('2026-09-12 00:16:40'),
      buckets: 100,
    })

    // 桶标签取桶内最大 c_time（Date，驱动按本机时区解析；不再库侧 DATE_FORMAT）
    expect(sql).toContain('MAX(`c_time`) AS `c_time`')
    // 数据列按桶平均（sensor_data 为 field1..field7）
    expect(sql).toContain('AVG(`field1`) AS `field1`')
    expect(sql).toContain('AVG(`field7`) AS `field7`')
    // 分组与排序
    expect(sql).toContain('GROUP BY FLOOR(UNIX_TIMESTAMP(`c_time`) / ?)')
    expect(sql).toContain('ORDER BY `c_time` ASC')
    // 时间范围条件
    expect(sql).toContain('`c_time` >= ?')
    expect(sql).toContain('`c_time` <= ?')
    expect(sql).toContain('`d_no` = ?')
    // 参数：d_no → start → end → step（时间条件值就是 Date）
    expect(params).toEqual(['DEV1', at('2026-09-12 00:00:00'), at('2026-09-12 00:16:40'), 10])
  })

  it('无附加条件时仅含时间范围参数；不聚合非 fieldN 列', () => {
    const { sql, params } = buildChartSQL(info, {
      start: at('2026-09-12 00:00:00'),
      end: at('2026-09-12 00:10:00'),
    })
    expect(sql).not.toContain('`d_no` = ?')
    expect(sql).not.toContain('AVG(`id`)')
    expect(sql).not.toContain('AVG(`d_no`)')
    expect(params).toEqual([at('2026-09-12 00:00:00'), at('2026-09-12 00:10:00'), 1])
  })

  it('表无 c_time 列时报错', () => {
    const mapperInfo = findTableInfo(buildTableInfoMap([sensor_data]), 'sensor_data')
    // 伪造一张没有 c_time 的表信息
    const fake = {
      ...mapperInfo,
      name: 'fake_table',
      columns: new Map([['field1', { name: 'field1' }]]),
    }
    expect(() =>
      buildChartSQL(fake as never, {
        start: at('2026-09-12 00:00:00'),
        end: at('2026-09-12 00:01:00'),
      }),
    ).toThrow(/没有 c_time 列/)
  })
})

describe('api.ts::getChartData（前端契约）', () => {
  it('默认走 sensor 资源，data 别名重定向，参数与默认 buckets 正确', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      return { json: async () => ({ success: true, data: [] }) }
    }) as never

    try {
      const params = { d_no: 'DEV1', start: '2026-09-12 00:00:00', end: '2026-09-12 01:00:00' }
      await getChartData(params)
      await getChartData({ ...params, buckets: 200 })
      await getChartData({ ...params, source: 'data' }) // 旧命名
      await getChartData({ ...params, source: 'error' })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calls[0]).toContain('/api/sensor/chart?')
    expect(calls[0]).toContain('d_no=DEV1')
    expect(calls[0]).toContain('buckets=1000')
    // URLSearchParams 把空格编码为 '+'（express 会解码回空格）
    expect(calls[0]).toContain('start=2026-09-12+00%3A00%3A00')
    expect(calls[1]).toContain('buckets=200')
    expect(calls[2]).toContain('/api/sensor/chart?') // 'data' → sensor
    expect(calls[3]).toContain('/api/error/chart?')
  })
})
