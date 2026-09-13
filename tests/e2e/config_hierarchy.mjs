import fs from 'node:fs'
import mysql from 'mysql2/promise'

/**
 * 配置层级门控端到端（GET /api/direct/config?d_no=）：
 *  ① 不带 d_no：返回全量配置（含未启用功能的子项）
 *  ② 带 d_no（auto=1、各开关默认关闭）：只返回当前可见项 ——
 *     阈值可见；heat/water（手动项）隐藏；PID/跳变/流量目标子项隐藏
 *  ③ 开启对应开关后：其子项出现（设备值优先于默认值）
 *  ④ auto=0：手动项可见、自动阈值隐藏；递归 → 开关自身与其子项都隐藏
 */
const API = 'http://127.0.0.1:10452/api'
const D_NO = 'E2E_HIER'

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8')).database
const db = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.username,
  password: cfg.password,
  database: cfg.database_name,
})
const q = async (sql, params = []) => (await db.query(sql, params))[0]

const listConfigs = async (dNo) => {
  const url = dNo ? `${API}/direct/config?d_no=${encodeURIComponent(dNo)}` : `${API}/direct/config`
  const res = await fetch(url)
  const body = await res.json()
  return (body.data ?? []).map((c) => c.id)
}
const update = (config_id, value) =>
  fetch(`${API}/direct/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id, value, d_no: D_NO }),
  }).then((r) => r.status)
const reset = () =>
  fetch(`${API}/control/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d_no: D_NO }),
  }).catch(() => undefined)

await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await q('INSERT INTO direct (config_id, value, d_no, c_time) VALUES (?,?,?,NOW())', [
  'auto',
  '1',
  D_NO,
])

const result = {}

// ---------- ① 全量 ----------
const all = await listConfigs()
result.allCount = all.length
result.allHasChildren = ['pid_target', 'sensor_spike_temp', 'total_flow_target'].every((id) =>
  all.includes(id),
)

// ---------- ② auto=1、开关默认关闭 ----------
const autoOnly = await listConfigs(D_NO)
result.autoOnly = {
  hasThreshold: autoOnly.includes('temp_max'),
  hasManual: autoOnly.includes('heat') || autoOnly.includes('water'),
  hasPidChildren: autoOnly.some((id) => id.startsWith('pid_') && id !== 'pid_enabled'),
  hasSpikeChildren: autoOnly.some(
    (id) => id.startsWith('sensor_spike_') && id !== 'sensor_spike_enabled',
  ),
  hasFlowTargetChild: autoOnly.includes('total_flow_target'),
}

// ---------- ③ 逐个开启开关 ----------
result.setPid = await update('pid_enabled', '1')
result.setSpike = await update('sensor_spike_enabled', '1')
result.setFlow = await update('flow_target_enabled', '1')
const enabled = await listConfigs(D_NO)
result.enabled = {
  hasPidTarget: enabled.includes('pid_target'),
  hasPidSensor: enabled.includes('pid_sensor'),
  hasSpikeTemp: enabled.includes('sensor_spike_temp'),
  hasSpikeFrames: enabled.includes('sensor_spike_frames'),
  hasFlowTarget: enabled.includes('total_flow_target'),
}

// ---------- ④ auto=0 ----------
await update('auto', '0')
const manual = await listConfigs(D_NO)
result.manual = {
  hasHeat: manual.includes('heat'),
  hasWater: manual.includes('water'),
  hasThreshold: manual.includes('temp_max'),
  hasPidEnabled: manual.includes('pid_enabled'),
  hasPidTarget: manual.includes('pid_target'),
}

// ---------- 清理 ----------
await reset()
for (const table of ['direct', 'error_msg', 'control_log', 'device_locks']) {
  await q(`DELETE FROM ${table} WHERE d_no = ?`, [D_NO])
}
await db.end()
fs.writeFileSync('tmp/config_hierarchy_result.json', JSON.stringify(result, null, 2))

// ---------- 断言 ----------
const checks = []
const check = (name, cond) => {
  checks.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}
check(
  '① 不带 d_no 返回全量（含 PID/跳变/流量目标子项）',
  result.allCount >= 30 && result.allHasChildren,
)
check(
  '② 自动模式且开关关闭：阈值可见、手动项与各子项隐藏',
  result.autoOnly.hasThreshold &&
    !result.autoOnly.hasManual &&
    !result.autoOnly.hasPidChildren &&
    !result.autoOnly.hasSpikeChildren &&
    !result.autoOnly.hasFlowTargetChild,
)
check(
  '③ 开启开关后子项出现（PID/跳变/流量目标）',
  result.enabled.hasPidTarget &&
    result.enabled.hasPidSensor &&
    result.enabled.hasSpikeTemp &&
    result.enabled.hasSpikeFrames &&
    result.enabled.hasFlowTarget,
)
check(
  '④ auto=0：手动项可见、阈值与 PID（含其子项）隐藏',
  result.manual.hasHeat &&
    result.manual.hasWater &&
    !result.manual.hasThreshold &&
    !result.manual.hasPidEnabled &&
    !result.manual.hasPidTarget,
)

console.log('\n汇总:', JSON.stringify(result))
if (checks.some((c) => !c.ok)) {
  console.log(
    'FAILED:',
    checks
      .filter((c) => !c.ok)
      .map((c) => c.name)
      .join(' | '),
  )
  process.exit(1)
}
console.log('E2E_CONFIG_HIERARCHY_OK')
process.exit(0)
