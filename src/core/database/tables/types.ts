export class ColumnTypeBase {
  public base: string

  constructor(base: string) {
    this.base = base
  }

  public toSQL(): string[] {
    return [this.base]
  }
}

export class ColumnTypeINT extends ColumnTypeBase {
  declare base: 'int'
  public length?: number
  public unsigned?: boolean

  constructor(length?: number, unsigned?: boolean) {
    super('int')
    if (length !== undefined) this.length = length
    if (unsigned !== undefined) this.unsigned = unsigned
  }

  public toSQL(): string[] {
    const sql = super.toSQL()
    if (this.length !== undefined) sql.push(`(${this.length})`)
    if (this.unsigned) sql.push('UNSIGNED')
    return sql
  }
}

export class ColumnTypeFLOAT extends ColumnTypeBase {
  declare base: 'float'
  public length?: number
  public unsigned?: boolean

  constructor(length?: number, unsigned?: boolean) {
    super('float')
    if (length !== undefined) this.length = length
    if (unsigned !== undefined) this.unsigned = unsigned
  }

  public toSQL(): string[] {
    const sql = super.toSQL()
    if (this.length !== undefined) sql.push(`(${this.length})`)
    if (this.unsigned) sql.push('UNSIGNED')
    return sql
  }
}

export class ColumnTypeVARCHAR extends ColumnTypeBase {
  declare base: 'varchar'
  public length?: number

  constructor(length?: number) {
    super('varchar')
    if (length !== undefined) this.length = length
  }

  public toSQL(): string[] {
    const sql = super.toSQL()
    if (this.length !== undefined) sql.push(`(${this.length})`)
    return sql
  }
}

export class ColumnTypeENUM extends ColumnTypeBase {
  declare base: 'enum'
  public values: string[]

  constructor(values: string[]) {
    super('enum')
    this.values = values
  }

  public toSQL(): string[] {
    const sql = super.toSQL()
    if (this.values.length > 0) {
      const escapedValues = this.values.map((value) => `'${value.replace(/'/g, "''")}'`)
      sql.push(`(${escapedValues.join(', ')})`)
    }
    return sql
  }
}

export class ColumnTypeDateTime extends ColumnTypeBase {
  declare base: 'datetime'

  constructor() {
    super('datetime')
  }

  public toSQL(): string[] {
    return super.toSQL()
  }
}
