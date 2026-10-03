# 面试问答稿

> 这份文档的用途：**面试前 30 分钟过一遍**，把项目里每个技术点的「为什么这么做」和「踩过什么坑」理顺。
> 每一节的结构是：问题 → 我怎么做的 → 为什么不用另一种做法 → 面试官可能的追问 → 我踩过的坑。
>
> 规则：**只写代码里真实存在的东西**。文档里提到的每个文件、每个数字都能在仓库里对上，
> 被追问细节时能立刻跳到那行代码。经不起追问的漂亮话不如不写。

---

## 0. 开场：怎么介绍这个项目

### 30 秒版本

> 这是一个仿小红书的内容社区，PC 桌面端三栏布局，前端 Vue 3 + TypeScript + Element Plus，
> 后端 Express + SQLite 手写 SQL。功能上有账号、内容、搜索、互动、消息中心，
> 最花时间的是**用 `ws` 库手写的 WebSocket 1v1 实时聊天**——多端同步、已读回执、
> 正在输入、断线重连补偿都自己实现了，没用 Socket.IO。
> 工程上配了 222 条单元测试、覆盖率当 CI 门禁，还有一套 Playwright 端到端回归。

### 简历上怎么写（3~5 条，别写多）

- 基于 **Vue 3 + TypeScript + Element Plus** 实现桌面端内容社区前端，路由懒加载、
  Pinia 状态持久化、Element Plus 主题变量全量接管（交付的是自有设计系统而非默认蓝）。
- 用 **`ws` 库手写 JSON 协议**实现 1v1 实时聊天，服务端以 `Map<userId, Set<WebSocket>>`
  承载多端同步；客户端实现指数退避 + 随机抖动的断线重连、心跳保活、离线消息补偿，
  以及基于 `tempId → 本地负数 id` 映射表的**乐观发送与乱序 ack 收敛**。
- 后端 **Express + SQLite（better-sqlite3）手写 SQL**，含 JWT 鉴权、游标分页、
  LIKE 通配符转义、multer 分片上传、WS 握手鉴权（失败 4401 直接关闭）。
- 建立 **222 条单元测试**（后端 107 / 前端 115，覆盖 WS 状态机、乐观发送 ack 收敛、
  组件键盘导航等真实交互），前端覆盖率门槛写入 CI 配置，跌破即红。
- 搭建三 job 并行 CI（typecheck / test / lint），并提供 **`docker compose up` 一键起全栈**
  （多阶段构建 + nginx 反代 `/api` `/uploads` `/ws`）。

### 一句话说清「这个项目难在哪」

> 难的不是把功能写出来，是**让功能在异常路径下也是对的**：WS 断了要能自动接回来、
> 接回来要补上断线期间的消息、消息 ack 乱序回来要落到正确的那条上。
> 所以我给这些路径都写了单测，而不是只测「正常情况下能用」。

---

## 1. 架构与选型

### Q：为什么用 Element Plus，最后又全部重写样式？不如自己写？

**我做的**：组件库只提供行为和骨架（弹窗、菜单、表单校验、下拉定位），
视觉层在 `client/src/assets/styles/element-theme.css` 里重写 `--el-*` 变量 +
覆写组件选择器，`theme.css` 再补一套自有 design token。

**为什么**：自己从零写 `Select` / `DatePicker` / `Dialog` 的**无障碍行为**（焦点管理、
`aria-*`、Esc 关闭、点击外部关闭、键盘循环）成本极高，而这块恰恰是自己最容易做残的。
反过来，视觉一致性是产品风格问题，组件库不应该绑架它。

**追问**：那你怎么保证覆写后还能跟得上组件库升级？
→ 覆写集中在 `:root` / `.el-*` 作用域，**不碰组件内部的 DOM 结构和 class**，
组件库小版本升级时基本不会冲突。真正深度依赖内部结构的只有动效那一层，
所以我把动效收进 `motion.css` 并全部用 token 表达时长和缓动。

**坑**：`core.autocrlf` 在 Windows 上会让 `unplugin-vue-components` 生成的
`components.d.ts` 出现「`git status` 显示 M 但 `git diff` 是空的」假阳性，
`git add` 一下就干净了，不用加 `.gitattributes` 去治。

---

### Q：后端为什么不用 ORM？

**我做的**：`better-sqlite3` 的同步 API 直接 `prepare().all() / .get() / .run()`。

**为什么**：SQLite 本来就是同步的，ORM 反而要你去 `await` 一个本来立刻就返回的值，
读起来比手写 SQL 更绕。而且这个项目的数据模型（users / posts / comments / likes /
conversations / messages）关系简单，手写 SQL 反而更直观，面试时每一行都能解释。

**追问**：那分页怎么做的？数据量大了 OFFSET 分页会不会慢？
→ 列表接口用 `page/offset`，但**消息历史用的是游标分页**（`before=上一页的 nextBefore`），
因为聊天是「一直往下追加」的流式场景，OFFSET 越翻越慢，而且中间插入新消息会导致
翻页时重复或漏掉。游标分页正好对症。

**坑**：游标分页写第一版时用了 `Array.reverse()` 原地修改，
结果**每页都漏一条**（`reverse` 返回同一个数组引用，链式调用时后续 filter 作用在已反转的数组上）。
现在用 `const next = [...arr].reverse()` 显式拷贝，并有单测钉住。

---

### Q：为什么不用 IndexedDB / localStorage 做数据层，非要后端？

**我做的**：所有数据走 HTTP + JWT，localStorage 只存登录态和搜索历史。

**为什么**：这个项目要展示的是「完整的前后端分离项目的工程能力」，
把数据放前端就失去了练后端的机会。localStorage 只用来存**确实该存本地**的东西：
登录态（免去每次刷新重新登录）和搜索历史（不该上服务端、换设备也不该带过去）。

**追问**：搜索历史为什么用模块级 `ref` 而不是 Pinia？
→ 它就是几行字符串，够不上 store 的分量；而模块级单例天然保证
「顶栏下拉删掉一条，搜索结果页里的历史也少一条」，不需要额外的同步代码。
放 `composables/` 是为了和 `useTheme` 保持同一层抽象。

---

## 2. 实时通信（本项目最花时间的部分）

### Q：为什么用 `ws` 手写协议，不用 Socket.IO？

**我做的**：`ws` + 自己定义的 JSON 帧（`ping/pong`、`send_message`、`read`、`typing`、
服务端侧 `ready/sync/message/read_receipt/typing/error`）。

**为什么**：Socket.IO 有一套自己的协议、重连策略、房间模型和二进制打包，
我需要的行为里有**一半它并不支持**（比如「重连后只补增量、不重置状态」）。
自己写意味着每一行行为都可控、可逐层讲，代价是要自己实现重连和心跳——
但这些恰好就是我想练的部分。零重依赖也是附带收益。

**追问**：协议长什么样？
→ 见 `server/src/ws/protocol.ts`（服务端帧）和 `client/src/api/wsProtocol.ts`（前端镜像）。
类型在前端是**复用**的而不是抄一份：REST 拉历史和 WS 推送返回的是同一批数据结构，
各写一份的话字段名迟早对不上，而这种对不上极难发现。

---

### Q：同一个账号开两个标签页，怎么做到两边都收到消息？

**我做的**：`server/src/ws/hub.ts` 里维护 `Map<userId, Set<WebSocket>>`，
推消息时把这个 Set **全部**推一遍。

**为什么**：这是整个 IM 里最关键的一个数据结构决定。
如果用 `Map<userId, WebSocket>`（一对一），用户的第二个标签页会直接把第一个**顶掉**变成哑巴——
这个 bug 表现为「偶发收不到消息」，非常难查。换成 Set 之后，
「电脑发手机收」和「本机两个标签页都收」都成了自然结果，不需要任何额外同步代码。

**追问**：连接怎么清理？
→ `socket.onclose` 里从 Set 里删掉，Set 空了再把 key 删掉，
否则 `Map` 会随着来过的用户无限膨胀（内存泄漏）。

**测试**：`scripts/chat-smoke.mjs` 里开两个浏览器上下文（同账号）验证两端同时收到，
外加一条「断线重连后补发断线期间消息」。

---

### Q：token 怎么带？听说放 URL 里不安全。

**我做的**：握手时用 `?token=<JWT>` 走 query 传，校验失败立刻用 **4401** 关闭连接，
**全程不打握手 URL**（包括日志）。

**为什么**：浏览器 WebSocket API **不能自定义 header**，没有别的办法。
放 query 的真实风险是「可能进网关 / 代理的访问日志」，所以对冲手段是：
① 校验失败立即关闭，不给重试机会；② 业务日志里只打 `userId`，不打 URL；
③ 生产可以给 WS 单独一个短时效的 ticket。

**追问**：那为什么 4401 收到就不重连了？
→ 因为 token 还是那个 token，重试一万次也是 4401，只会白白打服务端。
所以 4401 直接进 `closed` 终态，等用户重新登录触发新连接。
其他错误码才走指数退避重连。

---

### Q：断线重连怎么写？

**我做的**（`client/src/composables/useWebSocket.ts`）三件事：

1. **指数退避 + 随机抖动**：`1s → 2s → 4s → 8s → 16s → 30s 封顶`，
   每次再乘 `0.5 ~ 1.0` 的随机系数。
2. **重连后带 sync 补偿帧**：服务端在握手成功时推一次 `sync`，
   带这段时间内的新会话和新消息。
3. **心跳保活**：25s 一次 ping，10s 内没等到 pong 就判定连接僵死、主动断开走重连流程。

**为什么退避要加抖动**：不加的话，服务重启后所有客户端会在**同一毫秒**一起冲上来，
刚起来的进程很可能再被打挂。抖动把重连时刻打散，这是「防惊群」。

**为什么心跳还要单独做**：TCP 拔网线是不会报错的，连接看起来还在但数据发不出去。
心跳是唯一能发现「假连接」的手段。

**追问**：为什么 ping 超时要**比**心跳间隔短？
→ 10s < 25s，意味着一轮心跳发出后最多再等 10s 就判定失败，
两轮心跳之间不会漏检。反过来的话会出现「已经判死了但下一轮 ping 又发出去」的窗口。

**坑**：`socket.readyState !== WebSocket.OPEN` 这种写法在测试/埋点场景下会静默失效——
任何替换 `window.WebSocket` 的代码（polyfill、埋点、测试 hook）都可能只挂 prototype 不挂静态常量，
一旦常量丢了，这个比较**恒为 true**，症状是「明明连上了却永远发不出去」。
所以产品代码里用的是字面量 `readyState === 1`，并且有一条单测专门把 `WebSocket.OPEN`
改成一个错的值来证明这一点。

---

### Q：消息发出去怎么保证「就是这一条」？

**我做的**（`client/src/composables/useChat.ts`）乐观发送：

```
点发送 → 立刻上屏一条「临时消息」（本地负数 id，灰色）
       → 同时在 tempIdToLocalId 里记 tempId → localId
       → 发 WS 帧（带 tempId）
       → 服务端回 ack（带同一个 tempId + 真实 id）
       → 按 tempId 查到 localId，在原位置替换成真实消息
```

**为什么不用「id 是负数」反查**：连续发两条时，「第一条的负数 id」和「本次的 tempId」
根本不是同一条，按负数找会让两条 ack 都命中第一条，列表直接乱掉。
**必须按 tempId 查映射表精确定位。**

**为什么用负数 id 而不是临时字符串**：渲染时只拿得到消息对象本身，拿不到当初那个 tempId，
所以「发送失败要标红」这件事只能按 id 记，用负数正好和服务端自增 id 不撞。

**追问**：发送失败了怎么办？
→ 服务端带 `tempId` 回一个 `error` 帧，本地反查映射表把**那一条**标红；
完全没连上（`sendWs` 返回 false）时当场标红并弹提示。
注意区分：通用错误文案「服务端处理失败」不再弹 toast，只标红就够了。

**测试**：`client/tests/use-chat.test.ts` 里有专门的**乱序 ack 用例**——
两条连发、ack 倒序回来，断言两条各自落到正确位置。这条用例就是上面那个 bug 的回归钉子。

---

## 3. 前端

### Q：瀑布流怎么实现的？

**我做的**：把分列逻辑抽成纯函数 `client/src/utils/masonry.ts`：
列数换算（按容器宽度）、图片高度估算（按宽高比）、**最短列优先**分列、关键词切分。

**为什么抽纯函数**：这部分逻辑是「喂数据 → 得到结果」的映射，
不需要 DOM 就能断言。挂组件测只能测「渲染出来有没有」，测不到
「分列是不是均衡」「高度估算对不对」这些真正容易错的地方。
抽出来之后 25 条单测直接喂边界数据（0 张图、超长文本、脏 localStorage）。

**追问**：为什么是最短列优先而不是轮流分？
→ 轮流分（round-robin）只保证**条数**均衡，不保证**高度**均衡——
图片高度差异大时，轮流分会让某一列明显矮一截。
最短列优先按累积高度选列，视觉上更均匀。测试里有一条是拿两种算法做定量对比。

**坑**：早期高亮渲染时把用户输入的关键词直接塞进 `innerHTML`，
搜 `<script>` 会真的执行。现在是先做 HTML 转义再插入，
单测里断言 `wrapper.find('script').exists()` 必须为 false。

---

### Q：搜索框的联想下拉怎么做的？为什么不用 el-autocomplete？

**我做的**：自己写面板，因为内容要分「笔记 / 话题 / 用户」三组、每组样式不同，
而且需要**完整的 ↑↓ / Enter / Esc 键盘导航**。

**怎么做键盘导航**：把所有候选项**展平成一条线性数组** `rows`，再用 `groups`
按类型分桶渲染（`groups` 的顺序和 `rows` 严格一致）。
键盘按下标走，渲染按下标高亮，两边不可能对不上。

**追问**：为什么展平而不是直接在分组里上下移动？
→ 展平之后 ↑↓ 就是 `(index ± 1 + len) % len`，首尾环绕只需要一行；
分组导航要维护「当前在第几组第几个」，边界处理容易漏。

**两个容易被忽略的细节**（都写了单测）：

1. **过期响应不能覆盖新结果**：每次输入带一个自增 `reqSeq`，
   响应回来先比对 `seq === reqSeq`，不是就直接丢。快速连打时后到的旧请求不能盖掉新结果。
2. **面板开着才拦方向键**，否则要留给页面滚动——
   `if (!panelVisible) return` 必须放在 `ArrowDown` 分支**之前**，
   但 `Escape` 要放在它**之前**（Esc 任何时候都该能关面板）。

**搜索接口**（`server/src/routes/posts.ts`）：

- `LIKE` 通配符**必须转义**：搜 `100%` 不转义的话 `%` 会被当通配符，整表被捞出来。
  用了 `ESCAPE '\'` 显式声明转义符。
- `ORDER BY` **走白名单**：绝不能把 `req.query.sort` 直接拼进 SQL。
- 建议接口 `/search/suggest` 和结果接口 `/search` **刻意分开**：
  一个要「少量、去重、按相关度稳定的短列表」，一个要「按排序分页的完整列表」，
  语义和排序都不同，复用会让两边都不对。

---

### Q：动效是怎么做的？会不会很卡？

**我做的**：`client/src/assets/styles/motion.css`，**零动画库**。
五档时长 + 缓动字典 + CSS 原生弹簧（`linear()` 函数），
只碰 `transform / opacity / color / border-color` 这几个不触发重排的属性。

**为什么不用 GSAP / anime.js**：
这个项目的动效需求（卡片 hover、消息入场、红点 pop、铃铛摆）用 CSS 就能覆盖，
引一个 40KB+ 的库不划算。而且**面试时能逐层讲清每一段 CSS 在干什么**，比讲库的 API 有价值。

**怎么保证不打扰用户**：全局 `@media (prefers-reduced-motion: reduce)` 兜底，
把动画时长压到 `0.01ms`（**不是 0**）——部分浏览器在时长为 0 时不触发
`animationend` / `transitionend`，靠它做后续逻辑（移除元素、串下一个动画）会卡死。

**怎么证明动效真的在动**（不是代码写了就以为在动）：
`scripts/motion-check.mjs` 逐帧采 `getComputedStyle`，
在**触发动作之前**就启动采样器（点击到读结果之间隔着一次 IPC，事后轮询会错过动画），
然后按「元素数量变化点」切出动画那一段，分别在
`reducedMotion: 'no-preference'` 和 `'reduce'` 两组下跑。
判据是「opacity 有没有出现中间值」，而不是「首帧是不是终态」——
降级时首帧仍然是 from 状态，只是下一帧就到终态。

---

## 4. 测试与工程化

### Q：为什么前端也要写组件测试？纯函数测试不够吗？

**我做的**：222 条单测（后端 107 / 前端 115），前端里有 59 条是
composable 和组件级的（之前全是纯函数）。

**为什么纯函数不够**：这个项目里最容易出错的三个点都不是纯函数：

1. **WS 状态机**——`onopen` 到底算不算 open、4401 要不要重连，这些是「事件 → 状态」的转移。
2. **乐观发送的 ack 收敛**——涉及 `ref` 数组的原地替换和时序。
3. **建议下拉的键盘导航**——涉及 `rows` 展平顺序和 `groups` 渲染顺序是否一致。

这三件事单测纯函数都测不到，只有真的驱动一遍才看得出来。

**关键技术点**：我**没有把 `useWebSocket` 整个 mock 掉**，只把 `WebSocket` 换成一个
可手动驱动的假实现（`tests/helpers/fake-socket.ts`），这样测的仍是真实链路。
如果把整个 composable mock 掉，等于把要测的东西一起 mock 没了。

**覆盖率不是目标，是回归线**：`client/vitest.config.ts` 里 thresholds 四项都设 60%，
跌破直接让 CI 红。统计范围只含 `utils / composables / components`——
把 `main.ts` 和样式算进去只会把数字做低，没有任何信息量。

**踩过的两个静默失败的坑**（测试安静地挂在「某个东西没出现」上，不报错）：

- `vi.resetModules()` 之后，之前 import 出来的模块对象上的 `vi.spyOn` **完全失效**，
  表现是「mock 看着设了，实际打到了本机 dev 后端」。必须用 `vi.mock` 工厂从源头替换。
- `vi.useFakeTimers()` 默认会把 `setImmediate` 也假掉，
  而 `flushPromises` 内部靠 `setImmediate` 排微任务 → 直接死等。
  要显式 `toFake: ['setTimeout', 'clearTimeout', ...]`。

---

### Q：CI 配了什么？遇到过什么问题？

**我做的**：3 个并行 job —— `server`（tsc + vitest）/ `client`（vue-tsc + vitest+coverage + build）/ `lint`（eslint + prettier --check）。

**两个真实踩过、值得主动讲的坑**：

1. **Node 版本**：一开始写的是 `node-version: '20'`，CI 连续红 3 次。
   根因是 `vitest@5` 要求 `^22.12 || ^24 || >=26`、`better-sqlite3@13` 要求 `>=22`，
   **两边都不支持 Node 20**。难查的地方在于 `npm ci` 遇到 engines 不匹配**只发 warning 不失败**，
   所以「Install deps」那一步显示绿灯，很有迷惑性；紧接着的 `vitest run` 才挂，
   只留下一个没有上下文的 `Process completed with exit code 1`。
   本地是 Node 24，所以本地完全复现不出来。现在统一 24。
2. **类型检查曾经是假的**：`client/tsconfig.json` 是 solution-style
   （`files: []` + `references`），直接跑 `vue-tsc --noEmit` 等于什么都没检查，
   10+ 个 TS 报错被 CI 静默放过。改成显式 `-p tsconfig.app.json` 后立刻暴露。

**追问**：为什么 lint 要在 CI 里再跑一遍，Husky 不是已经在本地跑了吗？
→ Husky 只在有 commit 的时候跑，`--no-verify` 能绕过，而且别人 clone 下来不会触发。
CI 这层是**兜底**，保证「本地能过的命令 CI 也必须能过」。

**关于 pre-commit**：走真实的 Husky + lint-staged，**没有用 `--no-verify`**。
lint-staged 对 `*.{ts,vue}` 跑 `eslint --fix` + `prettier --write`，
对 `*.{json,md,css}` 跑 `prettier --write`；commit message 由 commitlint 按
Conventional Commits 校验（subject ≤ 72 字符）。

---

### Q：Docker 化做了什么？为什么这么设计？

**我做的**：`docker compose up --build` 一键起全栈。
`web`（nginx 托管前端静态产物 + 反代）+ `server`（只在容器网络内 expose，不对宿主机开端口）。
浏览器只访问 8080 一个 origin，**不存在跨域，也不用配 CORS**。

**值得讲的四个点**：

1. **多阶段构建**：后端镜像只在构建阶段装 `python3 / make / g++`
   （`better-sqlite3` 是原生模块，没有匹配到 prebuild 时会退回源码编译，缺了会 node-gyp 失败），
   运行时阶段 `npm prune --omit=dev` 删掉 devDeps，工具链不进最终镜像。
2. **`CMD ["node", "dist/index.js"]` 而不是 `npm start`**：
   npm 会多起一层进程转发信号，结果后端的优雅退出钩子（先关 WS 连接再关 HTTP）
   收不到 `SIGTERM`，只能等超时被强杀。
3. **SQLite 挂载**：`better-sqlite3` 存的是**单个文件**，而 Docker 的 named volume
   **只能挂目录不能挂文件**，所以把 `DB_PATH` 单独暴露成环境变量，
   compose 里挂目录再指进去（默认路径不变，本地开发完全无感）。
4. **`VITE_API_BASE` 在构建期注入**：vite 会把 `import.meta.env.VITE_*` **静态替换**进 bundle，
   运行时再设环境变量是没用的（那时 bundle 早就生成了）。
   容器里前后端同源，用相对路径 `/api`，产物里不含任何 `localhost:3000` 硬编码
   （这一点我是直接 grep 构建产物验证的，不是想当然）。

**追问**：nginx 配置里为什么 `/ws` 要单独写？
→ WebSocket 反代必须带 `Upgrade` 和 `Connection: upgrade` 两个头，
`proxy_http_version` 也要 1.1，写在通用 `location /api/` 里不会生效。
另外读超时给到 3600s：不靠 nginx 超时兜底，真断线时后端的 pong 超时会**先一步**把连接关掉。

---

## 5. 挑战性问题的准备

### Q：你这个项目没上线，怎么证明它真的能用？

> 我理解上线与否不是这个项目的目标，但**能不能跑通**和**部署在哪**是两件事。
> 我能证明的是：① 端到端回归脚本覆盖了完整登录态链路（注册 → 导航 → 发笔记 → 点赞 →
> 评论 → 编辑资料 → 主题切换 → 退出），并且同时断言「零 console error + 零失败请求」——
> 很多功能能点通但底下在刷红，这类问题普通手工测试根本发现不了；
> ② 每次提交都过三 job CI（typecheck / test / lint）；
> ③ 提供了 `docker compose up` 的完整容器化方案，结构和我计划的真实部署一致。

### Q：这个项目还有什么没做好的？

> 三个我清楚的：
> ① **没有真实的全文检索**。搜索是 `LIKE` + 索引友好的模糊匹配，
> 数据量到十万级就得换 FTS5 或 Elasticsearch，届时要重做排序和分页。
> ② **SQLite 不适合多实例**。它是单文件、单机写入，现在的后端一旦要横向扩容就会撞上
> 文件锁，写库要换 Postgres；WS 的 `Map<userId, Set<WebSocket>>` 也是**进程内**的，
> 多实例必须换成 Redis Pub/Sub 做跨进程广播。这是最优先要动的一处。
> ③ **通知 Tab 还是 mock 数据**（赞和收藏 / 关注 / 评论），只有聊天走了真实链路。

### Q：如果让你重做一遍，哪里会不一样？

> 会更早抽一层 **API 类型自动生成**。现在前后端的接口类型是手写对齐的
> （`client/src/api/wsProtocol.ts` 复用服务端定义算是做对了一半），
> 字段改名时没有编译期保障，只能靠测试撞出来。
> 其次会把**搜索历史**和**未读数**这类跨页面状态统一进一个 store，
> 现在它们靠模块级单例 + localStorage 隐式共享，能跑但不够显式。

---

## 6. 一分钟自检清单

面试前确认这 12 条能不看文档说出来：

- [ ] 前端为什么用 Element Plus 却要重写全部样式
- [ ] `Map<userId, Set<WebSocket>>` 为什么不能是一对一
- [ ] token 走 query 的风险和三个对冲手段
- [ ] 4401 为什么不重连
- [ ] 退避加抖动的理由（防惊群）
- [ ] 心跳超时为什么比心跳间隔短
- [ ] 乐观发送为什么必须按 tempId 查而不能按负数 id 查
- [ ] 搜索为什么 `LIKE` 要转义、`ORDER BY` 为什么走白名单
- [ ] 建议下拉为什么要把 rows 展平
- [ ] 瀑布流为什么是最短列优先而不是轮流分
- [ ] `vi.resetModules()` + `vi.spyOn` 为什么会静默失效
- [ ] CI 里 Node 版本那个「假绿」的坑

---

## 附：关键文件索引

| 想讲什么                      | 去哪看                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| WS 帧协议                     | `server/src/ws/protocol.ts` + `client/src/api/wsProtocol.ts`                           |
| 多端同步                      | `server/src/ws/hub.ts`                                                                 |
| 握手 / 心跳 / 重连 / 离线补偿 | `server/src/ws/server.ts` + `client/src/composables/useWebSocket.ts`                   |
| 乐观发送 + ack 收敛           | `client/src/composables/useChat.ts`                                                    |
| 搜索注入防护                  | `server/src/routes/posts.ts`（`/search` 与 `/search/suggest`）                         |
| 瀑布流算法                    | `client/src/utils/masonry.ts`                                                          |
| 动效 token 与降级             | `client/src/assets/styles/motion.css` + `scripts/motion-check.mjs`                     |
| 容器化                        | `docker-compose.yml` + `server/Dockerfile` + `client/Dockerfile` + `client/nginx.conf` |
| CI 配置                       | `.github/workflows/ci.yml`                                                             |
| 更多踩坑记录                  | `docs/architecture.md`                                                                 |
