import fs from 'node:fs'
import mysql from 'mysql2/promise'

/**
 * PID 控温**现场标定 / 验收**统计（只读，不写库、不起服务）：
 *  ① 读数稳定性：显示目标温度的占比、读数带宽、相邻帧跳变率
 *  ② 静态偏差：读数均值 − 目标（**读数口径**，真值需独立温度计）
 *     —— 若 ≈ −半个上报步长，说明控制器停在「读数=目标」区间的**下沿**，
 *        需给目标加 +半步补偿（且必须把 pid_kp 降到 1 才稳定，见 docs/TODO.md）
 *  ③ 加热占比、control_log 里的 duty 分布
 *
 * 用法（仓库根目录）：node tests/e2e/pid_calib.mjs [HH:MM] [HH:MM] [d_no]
 *   默认最近 30 分钟、全部设备。报告同时写入 tmp/pid_calib_<时间戳>.md
 */
const [, , fromArg, toArg, dNoArg] = process.argv

const pad = (n) => String(n).padStart(2, '0')
const day = new Date()
const stamp = (hhmm) =>
  `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())} ${hhmm}:00`
const nowStamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

const from = fromArg ? stamp(fromArg) : nowStamp(new Date(Date.now() - 30 * 60 * 1000))
const to = toArg ? stamp(toArg) : nowStamp(day)

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8')).database
const db = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.username,
  password: cfg.password,
  database: cfg.database_name,
})
const q = async (sql, params = []) => (await db.query(sql, params))[0]

const mapper = await q('SELECT api_name, db_name FROM sensor_data_mapper')
const map = new Map(mapper.map((r) => [r.api_name, r.db_name]))
const col = (api) => {
  const c = map.get(api)
  if (!c) throw new Error(`sensor_data_mapper 缺 ${api}，现有：${[...map.keys()].join(',')}`)
  return c
}
const tempCol = col('temp_out')
const heatCol = col('heat_Y1')

const dNoFilter = dNoArg ? 'AND d_no = ?' : ''
const dNoParams = dNoArg ? [dNoArg] : []

const rows = await q(
  `SELECT d_no, c_time, \`${tempCol}\` AS t, \`${heatCol}\` AS heat FROM sensor_data
     WHERE c_time BETWEEN ? AND ? ${dNoFilter} ORDER BY c_time ASC LIMIT 60000`,
  [from, to, ...dNoParams],
)
const ctrl = await q(
  `SELECT d_no, c_time, field4, field5 FROM control_log
     WHERE field5 LIKE '%PID%' AND c_time BETWEEN ? AND ? ${dNoFilter} ORDER BY id ASC LIMIT 20000`,
  [from, to, ...dNoParams],
)
await db.end()

if (!rows.length) {
  console.log(`窗口 ${from} ~ ${to} 内没有 sensor_data，无法标定`)
  process.exit(0)
}

/** 按设备分组统计 */
const byDevice = new Map()
for (const r of rows) {
  if (!byDevice.has(r.d_no)) byDevice.set(r.d_no, [])
  byDevice.get(r.d_no).push({ raw: String(r.t), v: Number(r.t), heat: String(r.heat) })
}

/** 从 control_log 的 reason 里取实际生效的目标 + duty（按设备分组） */
const pidInfo = []
const pidTargetByDevice = new Map()
for (const r of ctrl) {
  const m = /目标\s*([\d.]+)[，,]\s*实测\s*([\d.]+)[，,]\s*占空比\s*([\d.]+)%/.exec(r.field5 ?? '')
  if (m) {
    pidInfo.push({
      d_no: r.d_no,
      t: r.c_time,
      target: Number(m[1]),
      measured: Number(m[2]),
      duty: Number(m[3]) / 100,
    })
    pidTargetByDevice.set(r.d_no, Number(m[1]))
  }
}

const reports = []
const lines = []
for (const [dNo, samples] of byDevice) {
  const n = samples.length
  if (n < 30) continue
  const vals = samples.map((s) => s.v)
  const raws = samples.map((s) => s.raw)
  const decimals = Math.max(0, ...raws.map((v) => (v.includes('.') ? v.split('.')[1].length : 0)))
  const quantum = decimals > 0 ? 10 ** -decimals : 1
  const target = pidTargetByDevice.get(dNo) ?? [...pidTargetByDevice.values()][0] ?? null
  const mean = vals.reduce((a, c) => a + c, 0) / n
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  let jumps = 0
  const dist = {}
  for (let i = 0; i < n; i++) {
    dist[vals[i].toFixed(decimals)] = (dist[vals[i].toFixed(decimals)] ?? 0) + 1
    if (i > 0 && vals[i] !== vals[i - 1]) jumps++
  }
  const heatOn = samples.filter((s) => s.heat === '1').length
  const atTarget = target === null ? null : (dist[target.toFixed(decimals)] ?? 0) / n
  const bias = target === null ? null : mean - target

  const top = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}℃ ${((v / n) * 100).toFixed(1)}%`)

  const r = {
    dNo,
    n,
    quantum,
    target,
    mean,
    min,
    max,
    band: max - min,
    atTarget,
    bias,
    jumpRate: jumps / (n - 1),
    onRatio: heatOn / n,
    top,
  }
  reports.push(r)
  lines.push(
    [
      `### ${dNo}（${n} 帧）`,
      ``,
      `- 上报分辨率 **${quantum} ℃**（半步 ${quantum / 2}）`,
      `- 读数分布：${top.join('、')}`,
      `- 读数均值 **${mean.toFixed(decimals)}**${target === null ? '' : `（目标 ${target}，静态偏差 **${bias >= 0 ? '+' : ''}${bias.toFixed(3)}**）`}`,
      `- 读数带宽 **${(max - min).toFixed(decimals)} ℃**（[${min.toFixed(decimals)}, ${max.toFixed(decimals)}]）、跳变率 ${(r.jumpRate * 100).toFixed(1)}%`,
      `- 加热占比 **${(r.onRatio * 100).toFixed(1)}%**`,
      target === null
        ? `- ⚠️ 窗口内没有 PID 控制记录，目标未知（无法判静态偏差）`
        : atTarget !== null && atTarget >= 0.99
          ? `- ✅ 读数恒为 ${target.toFixed(decimals)}℃（占比 ${(atTarget * 100).toFixed(1)}%）`
          : `- ❌ 读数并非恒定 ${target.toFixed(decimals)}℃（占比 ${(atTarget * 100).toFixed(1)}%）`,
      bias !== null && Math.abs(bias + quantum / 2) <= quantum / 2
        ? `- 提示：静态偏差 ≈ **负半步**（${bias.toFixed(3)} vs ${(-quantum / 2).toFixed(3)}）→ 控制器停在「读数=目标」区间下沿；加 **+${quantum / 2}** 半步补偿可把真值抬到目标（须同时把 \`pid_kp\` 降到 1，否则会整步跳档到 +${quantum}）`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

const dutyDist = {}
for (const p of pidInfo) {
  const k = `${(Math.round(p.duty * 10) * 10).toFixed(0)}%`
  dutyDist[k] = (dutyDist[k] ?? 0) + 1
}
const dutyTop = Object.entries(dutyDist)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([k, v]) => `${k} ${((v / pidInfo.length) * 100).toFixed(0)}%`)

const out = [
  `# PID 控温标定/验收（${from} ~ ${to}）`,
  ``,
  `控制记录 ${pidInfo.length} 条${pidInfo.length ? `，duty 分布：${dutyTop.join('、')}` : ''}`,
  ``,
  ...lines,
  ``,
  `> 注：静态偏差是**读数口径**。真值需独立温度计（若真值恒差半个/一个步长，先查探头校准与测点位置）。`,
  `> 判定标准（「稳在目标」）：读数恒为目标占比 ≥ 99%；读数带宽 ≤ 1 个上报步长；加热占比与理论平衡 duty 同量级（实测升温:散热 ≈ 7~9:1 ⇒ 约 13%）。`,
  ``,
].join('\n')

const outFile = `tmp/pid_calib_${day.getTime()}.md`
fs.writeFileSync(outFile, out)
console.log(out)
console.log(`报告已写入 ${outFile}`)
