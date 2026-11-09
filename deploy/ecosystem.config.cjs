/**
 * pm2 进程定义 —— 裸机部署用。
 *
 * 对应线上 `pm2 describe csp-api` 的实测值：
 *   name=csp-api / fork_mode / cwd=<repo>/server / script=dist/index.js / interpreter=node
 *
 * 为什么 fork 而不是 cluster：SQLite 是单文件、WS 会话在进程内存里，
 * 多进程要么抢写锁，要么各存一份会话状态，两边都得额外做一层同步。
 * 这个项目的瓶颈从来不在 Node 的 CPU 上，起多实例纯属给自己找事。
 *
 * 用法（密钥从文件注入，不写进版本库）：
 *   set -a; . ./deploy/.env; set +a
 *   pm2 start deploy/ecosystem.config.cjs --only csp-api
 *   pm2 save                       # 写进开机自启列表
 */
// 目标永远是 Linux 服务器上的路径，直接用 `/` 拼。
// 不用 path.join：在 Windows 上加载这份文件时它会把 /srv/... 拧成 D:\...\srv\...，
// 配置看起来「加载成功」，DB_PATH 却指向一个根本不存在的盘符。
const repo = process.env.DEPLOY_DIR || '/srv/csp/repo'
const dataDir = process.env.CSP_DATA_DIR || '/srv/csp/data'

module.exports = {
  apps: [
    {
      name: 'csp-api',
      cwd: `${repo}/server`,
      script: 'dist/index.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      // 关 WS 连接、落 SQLite 的钩子靠 SIGINT/SIGTERM 触发，别用 SIGKILL
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '3000',
        // SQLite 数据目录故意放在 repo 外面 —— 换版本时 dist 可以整个替换，
        // 数据库和 uploads 永远不该被发布流程碰到。
        DB_PATH: process.env.DB_PATH || `${dataDir}/app.db`,
        TOKEN_EXPIRES_IN: process.env.TOKEN_EXPIRES_IN || '7d',
        // 前面挂了一层 Caddy：只有显式声明跳数，rate-limit 才认 X-Forwarded-For。
        // 留空等于不信任任何代理头，见 server/src/lib/trust-proxy.ts。
        TRUST_PROXY: process.env.TRUST_PROXY || '1',
        // 同源部署，浏览器不会发跨站请求；CORS_ORIGINS 用 env.ts 的默认值即可。
        //
        // 密钥必须来自环境。留空不是「给个默认值」，而是让 server/src/lib/env.ts
        // 在启动期直接 throw —— 宁可起不来，也不能拿弱密钥上线。
        JWT_SECRET: process.env.JWT_SECRET || ''
      }
    }
  ]
}
