/**
 * 可释放资源的模块生命周期接口。
 * 所有“构造后需持有连接/订阅/监听等资源”的模块都应实现 close()，
 * 用于释放其持有的资源。
 *
 * 例外：EventBus(全局事件中枢) 与 logger 为进程级单例，
 * 随进程存活，不需要实现本接口。
 */
export interface Closable {
  close(): void | Promise<void>
}
