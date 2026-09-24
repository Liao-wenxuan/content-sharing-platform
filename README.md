# 内容社区 (Content Sharing Platform)

一个仿小红书 UI/UX 的全栈内容社区前端 + 后端项目。零外部依赖、本地 SQLite 存储、纯手写实现（不引入 UI 组件库 / ORM），目标是展示一个完整的前后端分离项目的工程能力。

## ✨ 已实现功能

| 模块     | 功能                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| 账号     | 注册 / 登录 / JWT 鉴权 / 自动登录态持久化 (Pinia + localStorage)                                           |
| 内容     | 发布笔记 (文本 + 1~9 张图) / 双列瀑布流 feed / 笔记详情 / 多图轮播 (首页 +N 徽章)                          |
| 互动     | 点赞 (可选登录态) / 评论 (登录态) / 评论列表                                                               |
| 个人主页 | banner / 头像 / 三栏统计 / 浏览记录 + 钱包入口 / 推荐关注 / 4 个 tab + 公开/私密/合集筛选 / 编辑资料 modal |
| 消息     | 三个分类卡片 (赞和收藏 / 新增关注 / 评论和@) + 活动流 + 推荐关注 + 通知开关（UI 框架已搭好）               |
| 侧边栏   | 小红书风格抽屉（9 个分组菜单 + 3 个底部圆形按钮 + 暗色独立配色）                                           |
| 首页 tab | 双层 tab 栏：上层频道（关注 / 发现 / 雅安）/ 下层分类（推荐 / 视频 / 热点 / 直播 / 短剧 / 经验）           |
| 设置     | 设置页（5 组设置项 + 深色模式切换 + 退出登录 + 协议链接）                                                  |
| 主题     | 暗色 / 亮色切换 (URL 参数可强制 + localStorage 持久化)                                                     |

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
- **可测试架构**：db 模块用 Proxy 模式让测试注入 `:memory:` 实例，schema 抽成函数生产测试共用；vitest 覆盖 auth / posts / likes 31 个 case

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
