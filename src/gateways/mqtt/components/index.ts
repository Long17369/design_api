/**
 * MQTT 入站主题注册
 * data/ 为设备上报数据；control/ 为服务器下发指令（出站，不订阅）
 * 类型契约（TopicHandler 等）统一在 datatype.d.ts 中声明，不在实现文件内定义
 */
const topics = [(await import('./data')).default]

export default topics
