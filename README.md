# 内容社区 (Content Sharing Platform)

一个仿小红书 UI/UX 的全栈内容社区前端 + 后端项目。零外部依赖、本地 SQLite 存储、纯手写实现（不引入 UI 组件库 / ORM），目标是展示一个完整的前后端分离项目的工程能力。

## ✨ 已实现功能

| 模块     | 功能                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| 账号     | 注册 / 登录 / JWT 鉴权 / 自动登录态持久化 (Pinia + localStorage)                                             |
| 内容     | 发布笔记 (文本 + 1~9 张图，带上传进度条) / masonry 瀑布流 feed + hover 预览 / 笔记详情 / 图片 carousel       |
| 互动     | 点赞 (可选登录态) / 评论 (登录态) / 评论列表                                                                 |
| 个人主页 | banner / 头像 / 三栏统计 / 浏览记录 + 钱包入口 / 推荐关注 / 4 个 tab + 公开/私密/合集筛选 / 编辑资料 modal   |
| 消息     | 3 个 tab pill（赞 / 新增关注 / 评论和@）+ 活动流过滤 + 推荐关注 + 通知开关（UI 框架已搭好）                  |
| 侧边栏   | 小红书风格抽屉（用户卡片 + 9 个分组菜单 + 3 个底部圆形按钮 + 玻璃拟态）                                      |
| 首页 tab | 双层 tab 栏：上层频道（关注 / 发现 / 雅安）/ 下层分类（推荐 / 视频 / 热点 / 直播 / 短剧 / 经验），fixed 吸顶 |
| 设置     | 设置页（5 组设置项 + 深色模式切换 + 退出登录 + 协议链接）                                                    |
| 主题     | 暗色 / 亮色切换 (URL 参数可强制 + localStorage 持久化)                                                       |

> 路线图见 [docs/architecture.md](docs/architecture.md#路线图)

## 🛠 技术栈

**前端** ([client/](client/))

- Vue 3.5 (Composition API + `<script setup>`)
- TypeScript 5.6
- Vite 6 (含 `/uploads` 反代解决 dev 跨域)
- Pinia 4 + `pinia-plugin-persistedstate` (auth 持久化)
- Vue Router 4
- Axios 1 (formdata 走原生 XHR 绕开 multipart bug)

**后端** ([server/](server/))

- Node.js + Express 5
- better-sqlite3 (同步 SQLite，本地文件)
- bcryptjs (密码哈希)
- jsonwebtoken (JWT 鉴权)
- multer (multipart/form-data 上传，diskStorage)

## 🚀 本地开发

```bash
# 1. 启动后端（:3000）
cd server
npm install
npm run dev          # tsx watch src/index.ts

# 2. 启动前端（:5173）
cd client
npm install
npm run dev          # vite
```

打开 http://localhost:5173/ 注册账号即可使用。图片会上传到 `server/uploads/`，前端 `/uploads/*` 通过 `server.proxy` 反代到 3000（生产 nginx 同源直出）。

## 📁 项目结构

```
content-sharing-platform/
├─ client/                     # Vue 3 + Vite 前端
│  ├─ src/
│  │  ├─ views/                # 路由级页面（HomeView / ProfileView / PublishView / PostDetailView / MessagesView / MarketView / LoginView）
│  │  ├─ components/           # BottomNav 等复用组件
│  │  ├─ api/                  # request.ts (axios 实例 + 拦截器) / auth.ts / posts.ts
│  │  ├─ stores/               # Pinia: auth.ts
│  │  ├─ router/               # Vue Router 配置
│  │  └─ constants.ts          # 客户端常量（与 server mirror）
│  └─ vite.config.ts           # 含 /uploads 反代
│
├─ server/                     # Express + SQLite 后端
│  ├─ src/
│  │  ├─ index.ts              # 入口，挂载中间件 + 路由
│  │  ├─ lib/db.ts             # better-sqlite3 连接 + 建表
│  │  ├─ middleware/auth.ts    # JWT 校验 (requireAuth / optionalAuth)
│  │  ├─ routes/               # auth / users / posts / comments / likes / uploads
│  │  └─ constants.ts          # 服务端常量（与 client mirror）
│  └─ uploads/                 # multer 落地目录（.gitignore）
│
└─ docs/
   └─ architecture.md          # 架构图 / 数据模型 / 关键流程
```

## 🎯 设计决策（简历可以聊的点）

- **不引 UI 库**：所有交互组件（dropzone / modal / tabs / bottom nav / sidebar / drawer）手写，证明能直接落地设计稿
- **不引 ORM**：手写 SQL（`better-sqlite3.prepare(...).all()`），同步接口比 async 好读
- **不引 Tailwind**：CSS variables 主题切换 + scoped CSS，便于改设计 token
- **Liquid Glass 设计系统**：iOS / visionOS 风格，`backdrop-filter: blur()` + 半透明 + 1px 折射线 + 灰阶浮动光斑背景；所有组件统一玻璃感；dark / light 双主题共用一套 token
- **防御性校验**：所有限制（content ≤ 500 字、图 ≤ 10MB）双端校验，client 立即反馈 + server 拒绝非法请求
- **Vue 3 reactivity 坑**：uploaded image 对象用 `reactive()` 显式包一层，绕开 `ref([]).push(plain)` 不会自动 proxy 子项的陷阱（详见 [docs/architecture.md](docs/architecture.md#踩过的坑)）
- **后端 hardening**：dotenv + 启动期 env 校验、express-rate-limit（auth 5/min，写接口 20/min）、统一错误中间件（multer / JSON parse / 404）、password 列名迁移到 password_hash
- **可测试架构**：db 模块用 Proxy 模式让测试注入 `:memory:` 实例，schema 抽成函数生产测试共用；vitest 覆盖 auth / posts / likes / comments / users / uploads **53 个 case**

## 💡 工程亮点（面试可以深聊的点）

### 前端

| 亮点                            | 实现                                                                                                                                                                                        | 踩过的坑                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Liquid Glass 设计系统**       | 8 个玻璃 token（`--glass-bg/strong/weak/border/highlight/blur/shadow`）+ 4 个 utility class（`.glass` / `.glass-pill` / `.glass-input` / `.glass-toggle`），dark / light 双主题共用一套变量 | 用 `color-mix()` 而不是硬编码 dark/light 两套色值，避免双主题样式分叉                                                 |
| **fixed vs sticky 的取舍**      | 顶部 tab 栏本来用 `position: sticky`，实测在 `html, body { overflow-x: hidden }` 下会静默失效（scroll 越过元素后整个消失），改成 `fixed` + 容器 `padding-top` 让位                          | sticky 的有效性取决于**所有祖先**的 `overflow` / `transform` / `filter`，比想象中苛刻得多；fixed 更可控               |
| **共享状态用 store 不用 props** | `homeTabs` Pinia store 让 `App.vue` 的 HomeTopTabs 和 `HomeView` 的 watch 订阅同一份 channel / category state                                                                               | 组件层级跨越 `router-view` 时 props drilling 不可行                                                                   |
| **路由级错误边界**              | `ErrorBoundary.vue` 用 `onErrorCaptured` 捕获 render 期同步异常，渲染降级 UI + 重试按钮，避免白屏                                                                                           | 只兜同步异常；异步错误靠每个 view 自己的 `errorMsg` ref                                                               |
| **抽 EmptyState 消除重复**      | 3 个 variant（loading / empty / error）+ `compact` prop，替代 4 个 view 里各自写的 `class="state empty"`                                                                                    | —                                                                                                                     |
| **404 catch-all**               | `/:pathMatch(.*)*` 路由 + 玻璃风格 NotFoundView                                                                                                                                             | —                                                                                                                     |
| **上传进度条绕开 axios**        | 用原生 `XMLHttpRequest.upload.onprogress` 而不是 axios                                                                                                                                      | axios 1.x 在 instance 默认 `Content-Type: application/json` 时会把 FormData 转成 JSON 字符串发出去，multer 收不到文件 |
| **图片 carousel**               | 主图（4:5）+ 计数徽章 + 左右切换 + 圆点指示器（激活态拉长）+ 缩略图条                                                                                                                       | —                                                                                                                     |
| **masonry 瀑布流**              | 纯 CSS：2 列 grid + 6 张一组循环 `aspect-ratio`（1/1 → 3/4 → 4/5 → 3/5 → 2/3 → 5/6）+ `align-items: start`                                                                                  | 浏览器原生 `grid-template-rows: masonry` 只有 Firefox 支持，只能模拟                                                  |

### 后端

| 亮点                         | 实现                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **可测试架构（Proxy 注入）** | `db.ts` 用 `new Proxy()` 包装，测试用 `setTestDb(new Database(':memory:'))` 注入内存实例，生产文件 DB 和测试实例互不污染 |
| **schema 抽取复用**          | `CREATE TABLE` 抽到 `lib/schema.ts` 的 `initSchema(db)`，生产启动和每个测试文件共用同一份 DDL                            |
| **53 个集成测试**            | vitest 6 个测试文件覆盖 auth / posts / likes / comments / users / uploads；`fileParallelism: false` 避免共享 DB 竞态     |
| **分层限流**                 | `express-rate-limit` 三档：auth 5/min、writes 20/min、uploads 30/min，`NODE_ENV=test` 自动跳过                           |
| **全局错误中间件**           | `AppError` 类 + 4 个 catch 层（multer / JSON parse / 404 / 未知错误），统一响应格式，日志分级                            |
| **env 启动校验**             | `lib/env.ts` 用 dotenv 加载后校验 `JWT_SECRET` 必填，缺失直接 fail fast 而不是运行时才炸                                 |

### 工程化

| 亮点                             | 实现                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ESLint + Prettier + Husky**    | lint-staged 在 pre-commit 跑 eslint + prettier；commitlint 强制 conventional commits（subject ≤ 72 字符）                                                                                                        |
| **ESLint / Prettier 规则解冲突** | `semi: false` 的 prettier 会删分号，但 `eslint:recommended` 的 `no-extra-semi` 会报错，两者来回翻转。接入 `eslint-config-prettier` 并放在 `extends` **最后**，关闭所有纯格式规则，让 prettier 成为格式的唯一权威 |
| **GitHub Actions CI**            | 3 个并行 job：`server`（vitest + tsc）/ `client`（vue-tsc + build）/ `lint`（eslint + prettier --check），ubuntu-latest + Node 20；本地能过的命令 CI 也必须能过                                                  |
| **零 console 残留**              | 调试日志统一走 `[Prefix]` 格式，方便后期清理或加日志级别                                                                                                                                                         |

## 📚 文档

- [架构图 / 数据模型 / 关键流程 / 踩坑记录](docs/architecture.md)
- 路线图：发布笔记 → 点赞 / 评论 → 个人主页重构 → 图片上传 → **当前**（布局对齐 + 代码抛光）

## 🔐 安全性

- 密码 bcryptjs hash（不存明文）
- JWT 7 天有效期，前端 Pinia 持久化 token
- 所有写接口（发布 / 评论 / 点赞 / 上传）走 `requireAuth` 中间件
- 上传：multer 校验 mimetype + 单文件 ≤ 10MB + 一次 ≤ 9 张
- SQL：用 `?` 参数化，无字符串拼接
- CORS：开发全开；生产应限制 origin

## 📄 License

MIT — 仅用于学习与作品投递。
