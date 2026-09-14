import fs from 'node:fs'
import http from 'node:http'
import { WebSocket as WsClient } from 'ws'
import { WebSocketServer } from '@gateways/websocket'
import { WS_PATH } from '@gateways/utils'
import { connectWebSocket } from '@/types/api'

/**
 * WS 服务路径锁定校验（进程内起临时端口，不依赖 MySQL / MQTT）：
 *  ① 正确路径（`WS_PATH`，由共享 `API_BASE` 派生）可握手，并收到欢迎消息（含 goal）
 *  ② 正确路径带 `?goal=` 仍可握手（路径锁不影响重连 token 复用）
 *  ③ 其它路径握手被拒（HTTP 400）
 *  ④ 契约导出的 `connectWebSocket()` 能真的建连并收到欢迎消息（返回的是连接，不是地址）
 *  ⑤ 契约 `connectWebSocket(goal)` 能按旧 token 复用连接身份
 *
 * 用法：`pnpm exec tsx tests/e2e/ws_path.ts`（从仓库根目录运行，产物写 tmp/）
 */
const server = http.createServer()
const gateway = new WebSocketServer()
gateway.attach(server)

await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('无法获取临时端口')
const port = address.port
const origin = `ws://127.0.0.1:${port}`

/** 探测一次握手：open / rejected / error / timeout */
function probe(path: string): Promise<{ path: string; result: string; detail: string | null }> {
  return new Promise((resolve) => {
    const client = new WsClient(`${origin}${path}`)
    let welcome: string | null = null
    const timer = setTimeout(() => {
      client.terminate()
      resolve({ path, result: 'timeout', detail: null })
    }, 3000)

    client.on('message', (raw) => {
      welcome = raw.toString()
    })
    client.on('open', () => {
      setTimeout(() => {
        clearTimeout(timer)
        client.close()
        resolve({ path, result: 'open', detail: welcome })
      }, 100)
    })
    client.on('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      resolve({ path, result: 'rejected', detail: `HTTP ${res.statusCode}` })
    })
    client.on('error', (err) => {
      clearTimeout(timer)
      resolve({ path, result: 'error', detail: err.message })
    })
  })
}

/** 视为「握手被拒」：显式 rejected，或客户端报 400 错误 */
function isRejected(p: { result: string; detail: string | null }): boolean {
  return p.result === 'rejected' || (p.result === 'error' && (p.detail ?? '').includes('400'))
}

/**
 * 用契约导出的 `connectWebSocket(goal?)` 建连（第④⑤项校验）。
 * Node 环境没有 `location`，先注入一个假的（契约正是按 `location` 拼绝对地址）。
 */
function probeContractConnection(
  goal?: string,
): Promise<{ path: string; result: string; detail: string | null }> {
  return new Promise((resolve) => {
    const path = `${WS_PATH} · 契约 connectWebSocket${goal ? ' + goal' : ''}`
    ;(globalThis as { location?: unknown }).location = {
      protocol: 'http:',
      host: `127.0.0.1:${port}`,
    }
    const connection = connectWebSocket(goal)
    const timer = setTimeout(() => {
      connection.close()
      resolve({ path, result: 'timeout', detail: null })
    }, 3000)

    connection.onmessage = (event) => {
      clearTimeout(timer)
      const detail = String(event.data)
      connection.close()
      resolve({ path, result: 'open', detail })
    }
    connection.onerror = () => {
      clearTimeout(timer)
      resolve({ path, result: 'error', detail: null })
    }
  })
}

const ok = await probe(WS_PATH)
const okWithGoal = await probe(`${WS_PATH}?goal=e2e-ws-path`)
const bad = await probe('/ws')
const badTrailing = await probe(`${WS_PATH}/`)
const contractConn = await probeContractConnection()
const contractConnGoal = await probeContractConnection('e2e-contract-goal')
// 撤掉探针注入的假 location，避免影响后续
const globals = globalThis as { location?: unknown }
delete globals.location

const checks = [
  {
    name: '正确路径可握手且收到欢迎消息',
    pass: ok.result === 'open' && !!ok.detail?.includes('goal'),
  },
  { name: '带 ?goal= 仍可握手', pass: okWithGoal.result === 'open' },
  { name: '旧路径 /ws 被拒', pass: isRejected(bad) },
  { name: '多余斜杠 /api/ws/ 被拒', pass: isRejected(badTrailing) },
  {
    name: '契约 connectWebSocket 建连并收到欢迎消息',
    pass: contractConn.result === 'open' && !!contractConn.detail?.includes('goal'),
  },
  {
    name: '契约 connectWebSocket(goal) 复用 token 建连',
    pass:
      contractConnGoal.result === 'open' &&
      !!contractConnGoal.detail?.includes('e2e-contract-goal'),
  },
]

const result = {
  origin,
  wsPath: WS_PATH,
  probes: [ok, okWithGoal, bad, badTrailing, contractConn, contractConnGoal],
  checks,
  pass: checks.every((check) => check.pass),
}

fs.writeFileSync('tmp/ws_path_result.json', JSON.stringify(result, null, 2))
for (const check of checks) console.log(`${check.pass ? 'OK  ' : 'FAIL'} ${check.name}`)
for (const p of result.probes) {
  console.log(`     ${p.path} → ${p.result}${p.detail ? ` (${p.detail.slice(0, 60)})` : ''}`)
}

gateway.close()
server.close()
console.log(result.pass ? '\nWS_PATH_OK' : '\nWS_PATH_FAILED')
process.exit(result.pass ? 0 : 1)
