import type { Express } from 'express'
import { env } from './env'

/**
 * 反向代理信任设置（app.set('trust proxy', N)）
 *
 * 为什么单独抽出来而不在 index.ts 里写一行：
 *
 * 1. 可测试 —— index.ts 顶部一执行就 app.listen，supertest 进不去；
 *    抽成纯函数（app 传入、不 listen）才能单测。
 *
 * 2. 这个配置错了的后果是**静默的半瘫**，值得一个显式的开关和文档：
 *
 *    2026-11-06 线上事故：Caddy 反代带 X-Forwarded-For，但 trust proxy
 *    没开。express-rate-limit v7 的 validate.xForwardedForHeader 检测到
 *    「XFF 存在但代理未被信任」这种矛盾配置，直接把 ValidationError 抛给
 *    错误中间件 → 该 IP 的首个过限流器的请求吃 500（ERR_ERL_UNEXPECTED_X_FORWARDED_FOR）。
 *    而且每个校验只触发一次，日志里就一条，看起来像偶发抖动。
 *
 *    开了 trust proxy 之后还有第二个好处：req.ip 才是真实客户端 IP，
 *    按 IP 限流才不会把所有访客算成 Caddy 一个 IP 一起限死。
 *
 * 用法：部署在 nginx/Caddy 后面时 server/.env 设 TRUST_PROXY=1（跳数）。
 * 本地直跑不设，行为不变（信任 127.0.0.1 之外的一切代理头都无意义）。
 */
export function applyTrustProxy(app: Express): void {
  if (!env.TRUST_PROXY) return
  // Express 的 compileTrust 只认**数字**类型的跳数（app.set('trust proxy', 1)）；
  // 字符串 '1' 会被当 IP/CIDR 列表去解析，静默产出「永远不匹配」的结果。
  // 所以 '1' → 1、'true' → true，其余原样透传（IP 列表等留给部署者）。
  const raw = env.TRUST_PROXY.trim()
  const hops = Number(raw)
  const value = raw === 'true' ? true : Number.isFinite(hops) ? hops : raw
  app.set('trust proxy', value)
}
