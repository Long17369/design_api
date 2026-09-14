/**
 * 对外路由常量（**唯一来源，不要在别处再定义或起别名**）。
 *
 * - `API_BASE`：HTTP 接口前缀（路由在 `gateways/http` 注册）
 * - `WS_PATH`：WebSocket 服务路径（网关用它锁定 upgrade，非该路径直接 400）
 *
 * 引用方：`gateways/http`、`gateways/websocket`、对外契约 `src/types/api.ts`
 * （前端由它拼出连接地址）。
 */
export const API_BASE = '/api'

/** WebSocket 服务路径（与 HTTP 前缀对齐） */
export const WS_PATH = `${API_BASE}/ws`
