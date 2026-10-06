import type { Hub } from './hub'

/**
 * Hub 单例
 *
 * 为什么要这么一层：写通知的代码在 **HTTP 路由**里（点赞 / 收藏 / 关注 / 评论），
 * 而 Hub 是 **WebSocket 层** 的对象，两个模块互不相识。
 *
 * 备选方案是「把 hub 一路当参数传下去」，但 HTTP 路由的签名是 Express 定的，
 * 塞不进 hub；而全局变量又会让测试没法注入一个假的。
 * 所以这里保留一个模块级单例：启动时 setHub() 一次，
 * 路由里 getHub() 拿，**拿不到就安静地跳过推送**（比如单测里没起 WS），
 * 通知照样落库 —— 推送是增强，不是数据一致性的前提。
 */
let _hub: Hub | null = null

export function setHub(hub: Hub): void {
  _hub = hub
}

/** 测试用：清掉，避免上一条用例注册的 hub 漏到下一条 */
export function resetHub(): void {
  _hub = null
}

export function getHub(): Hub | null {
  return _hub
}
