import { describe, expect, it } from 'vitest'
import {
  buildQuerySQL,
  buildTableInfoMap,
  buildWhereSQL,
  findTableInfo,
} from '@core/database/utils'
import sensor_data from '@core/database/tables/sensor_data'
import { HttpError, parseWhere } from '@gateways/http/utils'
import { Where, WHERE_OPERATORS } from '@/types/types'

/** WHERE 条件：四组操作符的 SQL 形态与参数、非法条件抛错、HTTP 入口 400 校验 */
const tables = buildTableInfoMap([sensor_data])
const info = findTableInfo(tables, 'sensor_data')

/** 绕过类型构造运行时脏条件（模拟未过 `parseWhere` 校验的入参） */
const dirty = (where: unknown): Where => where as Where

describe('buildWhereSQL（操作符 → SQL 形态）', () => {
  it('单值操作符：比较与模糊都是「列 OP ?」，参数按声明顺序', () => {
    const { sql, params } = buildWhereSQL(info, {
      d_no: { operator: '=', value: 'DEV1' },
      field1: { operator: 'like', value: '%超温%' },
      field2: { operator: 'not like', value: 'x%' },
      c_time: { operator: '>=', value: '2026-09-01 00:00:00' },
    })

    expect(sql).toBe(
      ' WHERE `d_no` = ? AND `field1` LIKE ? AND `field2` NOT LIKE ? AND `c_time` >= ?',
    )
    expect(params).toEqual(['DEV1', '%超温%', 'x%', new Date('2026-09-01 00:00:00')])
  })

  it('集合操作符：in / not in 展开为 n 个占位符（单值视为 1 元集合）', () => {
    const multi = buildWhereSQL(info, { d_no: { operator: 'in', value: ['A', 'B', 'C'] } })
    expect(multi.sql).toBe(' WHERE `d_no` IN (?, ?, ?)')
    expect(multi.params).toEqual(['A', 'B', 'C'])

    const single = buildWhereSQL(info, { d_no: { operator: 'not in', value: 'A' } })
    expect(single.sql).toBe(' WHERE `d_no` NOT IN (?)')
    expect(single.params).toEqual(['A'])
  })

  it('区间操作符：between / not between 生成「BETWEEN ? AND ?」', () => {
    const between = buildWhereSQL(info, {
      c_time: { operator: 'between', value: ['2026-09-01 00:00:00', '2026-09-02 00:00:00'] },
    })
    expect(between.sql).toBe(' WHERE `c_time` BETWEEN ? AND ?')
    expect(between.params).toEqual([
      new Date('2026-09-01 00:00:00'),
      new Date('2026-09-02 00:00:00'),
    ])

    const notBetween = buildWhereSQL(info, {
      c_time: { operator: 'not between', value: ['a', 'b'] },
    })
    expect(notBetween.sql).toBe(' WHERE `c_time` NOT BETWEEN ? AND ?')
    expect(notBetween.params).toEqual(['a', 'b'])
  })

  it('空值操作符：is null / is not null 不带占位符', () => {
    const isNull = buildWhereSQL(info, { field1: { operator: 'is null' } })
    expect(isNull.sql).toBe(' WHERE `field1` IS NULL')
    expect(isNull.params).toEqual([])

    const isNotNull = buildWhereSQL(info, { field1: { operator: 'is not null' } })
    expect(isNotNull.sql).toBe(' WHERE `field1` IS NOT NULL')
    expect(isNotNull.params).toEqual([])
  })

  it('同一列多个条件（数组）：按数组顺序 AND 拼接', () => {
    const { sql, params } = buildWhereSQL(info, {
      c_time: [
        { operator: '>=', value: 's' },
        { operator: '<=', value: 'e' },
      ],
      d_no: { operator: '=', value: 'DEV1' },
    })

    expect(sql).toBe(' WHERE `c_time` >= ? AND `c_time` <= ? AND `d_no` = ?')
    expect(params).toEqual(['s', 'e', 'DEV1'])
  })

  it('空条件不生成 WHERE 子句；id 列同样在白名单内', () => {
    expect(buildWhereSQL(info, {})).toEqual({ sql: '', params: [] })
    expect(buildWhereSQL(info, { id: { operator: 'in', value: ['1', '2'] } }).sql).toBe(
      ' WHERE `id` IN (?, ?)',
    )
  })
})

describe('buildWhereSQL（非法条件一律抛错）', () => {
  it('值个数不符：区间给 1 或 3 个、集合给空数组', () => {
    expect(() =>
      buildWhereSQL(info, dirty({ c_time: { operator: 'between', value: ['a'] } })),
    ).toThrow('恰好 2 个条件值')
    expect(() =>
      buildWhereSQL(info, dirty({ c_time: { operator: 'between', value: ['a', 'b', 'c'] } })),
    ).toThrow('恰好 2 个条件值')
    expect(() => buildWhereSQL(info, dirty({ d_no: { operator: 'in', value: [] } }))).toThrow(
      '至少需要 1 个条件值',
    )
  })

  it('值类型不符：单值给数组/数字，集合里混入非字符串', () => {
    expect(() => buildWhereSQL(info, dirty({ d_no: { operator: '=', value: ['A'] } }))).toThrow(
      '需要 1 个条件值',
    )
    expect(() => buildWhereSQL(info, dirty({ d_no: { operator: '=', value: 1 } }))).toThrow(
      '需要 1 个条件值',
    )
    expect(() =>
      buildWhereSQL(info, dirty({ d_no: { operator: 'in', value: ['A', null] } })),
    ).toThrow('条件值必须是字符串或日期')
  })

  it('时间条件值可直接传 Date（内部时间条件，如窗口起点 / 图表时间段）', () => {
    const at = new Date('2026-09-12T00:00:00')
    const { sql, params } = buildWhereSQL(info, { c_time: { operator: '>=', value: at } })
    expect(sql).toBe(' WHERE `c_time` >= ?')
    expect(params).toEqual([at])
  })

  it('时间列的字符串条件值（JSON 形式时间）解析成 Date 再比较', () => {
    const { params } = buildWhereSQL(info, {
      c_time: {
        operator: 'between',
        value: ['2026-09-12T00:00:00.000Z', '2026-09-12T01:00:00.000Z'],
      },
    })
    expect(params).toEqual([
      new Date('2026-09-12T00:00:00.000Z'),
      new Date('2026-09-12T01:00:00.000Z'),
    ])
  })

  it('未知操作符与不存在的列', () => {
    expect(() => buildWhereSQL(info, dirty({ d_no: { operator: 'regexp', value: 'x' } }))).toThrow(
      '不支持的操作符',
    )
    expect(() => buildWhereSQL(info, { not_exist: { operator: '=', value: 'x' } })).toThrow(
      '列 not_exist 不存在于表 sensor_data',
    )
  })
})

describe('buildQuerySQL（与分页/排序组合）', () => {
  it('新操作符可用，参数顺序为 where → LIMIT → OFFSET', () => {
    const { sql, params } = buildQuerySQL(tables, {
      table: 'sensor_data',
      where: {
        d_no: { operator: 'in', value: ['A', 'B'] },
        field1: { operator: 'is not null' },
        c_time: { operator: 'between', value: ['s', 'e'] },
      },
      limit: '5',
      offset: '10',
    })

    expect(sql).toContain(
      'WHERE `d_no` IN (?, ?) AND `field1` IS NOT NULL AND `c_time` BETWEEN ? AND ?',
    )
    expect(sql).toMatch(/LIMIT \? OFFSET \?$/)
    expect(params).toEqual(['A', 'B', 's', 'e', 5, 10])
  })
})

describe('parseWhere（HTTP 入参校验）', () => {
  it('放行全部合法形态', () => {
    const where = {
      d_no: { operator: 'in', value: ['A', 'B'] },
      field1: { operator: 'like', value: '%x%' },
      c_time: [{ operator: 'between', value: ['s', 'e'] }, { operator: 'is not null' }],
    }

    expect(parseWhere(JSON.stringify(where))).toEqual(where)
  })

  it('非法形状返回 400（未知操作符 / 空集合 / 区间非 2 元素 / 值类型不符 / 缺值 / 嵌套数组）', () => {
    const cases: unknown[] = [
      { d_no: { operator: 'regexp', value: 'x' } },
      { d_no: { operator: 'in', value: [] } },
      { d_no: { operator: 'in', value: [1, 2] } },
      { c_time: { operator: 'between', value: ['s'] } },
      { c_time: { operator: 'between', value: ['s', 'e', 'x'] } },
      { c_time: { operator: 'between', value: 's' } },
      { d_no: { operator: '=', value: ['A'] } },
      { d_no: { operator: '=', value: 1 } },
      { d_no: { operator: 'like' } },
      { d_no: [{ operator: '=' }] },
      { d_no: [[{ operator: '=', value: 'A' }]] },
      { d_no: [] },
    ]

    for (const where of cases) {
      expect(() => parseWhere(JSON.stringify(where)), JSON.stringify(where)).toThrow(HttpError)
    }
  })

  it('WHERE_OPERATORS 契约白名单 = 四组常量之和', () => {
    expect(WHERE_OPERATORS).toEqual([
      '=',
      '!=',
      '>',
      '>=',
      '<',
      '<=',
      'like',
      'not like',
      'in',
      'not in',
      'between',
      'not between',
      'is null',
      'is not null',
    ])
  })
})
