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

### Q：关注关系怎么存的？为什么不用自增 id + UNIQUE？

**我做的**（`server/src/lib/schema.ts`）：

```sql
CREATE TABLE follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id),
  FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
)
```

**为什么用复合主键而不是「自增 id + UNIQUE」**：主键本身就带唯一性，
`INSERT OR IGNORE` 直接拿到幂等语义，还少一列少一个索引。
主键的最左前缀 `(follower_id)` 正好服务「我关注了谁」，
另建 `(followee_id)` 索引服务「谁关注了我」—— 两个查询方向各走各的索引。

**追问**：表上有 `CHECK (follower_id <> followee_id)` 看着能挡住自关注，
为什么路由层还要再判一次？
→ 因为 **`INSERT OR IGNORE` 会把违反 CHECK 的行也当成「忽略」静默跳过**。
只靠数据库约束的话，用户点「关注自己」会拿到一个 200 成功响应但什么都没发生，
前端按钮也不会变 —— 这是最难查的那类 bug（没有报错、没有 500、就是没反应）。
所以路由层先显式判掉并返回 400，`server/tests/follows.test.ts` 有一条专门盯这个。

**为什么不做冗余计数字段**（`followers_count` / `following_count`）：
和 likes 的 `likeCount`、messages 的未读数保持一致 —— 计数一律走 `COUNT(*)` 查索引。
手工维护计数器一旦某条路径漏更新就会**永久漂移**，而且这种不一致极难发现。
真正需要冗余是到「单表上千万行 + 粉丝列表要翻几十页」的量级，
那时再上计数列 + 定时对账也不迟。SQLite 走索引的 `COUNT(*)` 是微秒级。

---

### Q：关注按钮怎么做到点了立刻变，又不出错？

**我做的**（`client/src/composables/useFollow.ts`）乐观更新三步：

```
1. 先按预期翻转按钮状态（等网络往返能明显感觉到卡）
2. 请求回来后用【服务端的权威计数】覆盖本地 +1/-1
3. 失败整体回滚，并给一次明确提示
```

**第 2 步为什么不能省**：本地 `+1` 是猜的。用户点下去到请求返回这段时间里，
对方可能已经取关过一次，或者别人也关注了 ta。不对齐的话，
主页上的数字会和数据库**永久对不上**，而且没有任何报警。

**追问**：为什么不用一个 `POST /toggle` 接口？
→ 调用方得能区分「本来就没关注」和「刚取关」，否则翻转按钮时不知道该设成什么状态。
拆成 `POST /:id/follow` 和 `DELETE /:id/follow` 后语义是确定的，
而且**两个方向天然都幂等**：重复关注不新增、重复取关不报错。

**测试**：`client/tests/use-follow.test.ts` 里有一条专门模拟**竞态** ——
本地乐观算出 13、服务端返回 11，断言最终显示 11；
另有一条断言失败回滚后状态和计数都要回到点之前的样子。

---

### Q：粉丝列表里每一行都要显示「关注 / 已关注」，怎么不变成 N+1 请求？

**我做的**：列表接口直接在 SQL 里批量算好。

```sql
EXISTS(SELECT 1 FROM follows mine
       WHERE mine.follower_id = @me AND mine.followee_id = u.id) AS is_following
```

20 行的列表是 1 个请求而不是 20 个，首屏不会卡。
未登录时 `me` 传 `-1`，`EXISTS` 恒为假，正好等于「不显示关注按钮」。

**顺带一个产品细节**：粉丝列表里**自己那一行没有关注按钮**
（`v-if="u.id !== auth.user?.id"`），因为不能关注自己。
这条是被 e2e 脚本断言出来的 —— 最初的实现给每一行都渲染了按钮。

---

### Q：推荐关注怎么推荐的？

**我做的**：排除自己和已关注的人，按 `follower_count DESC, post_count DESC, id ASC` 排。
**影响力优先于笔记数** —— 100 篇笔记但没人关注的账号，
不如 5 篇笔记但 2000 粉丝的账号值得订阅。笔记数只当同分时的 tie-break。

**追问**：这个排序是不是太简单了？真上量怎么做？
→ 简单版是为了让「推荐卡不再是前端写死的 mock」这件事被看见。
真正上量会换成多路召回（粉丝的好友 / 同话题的作者 / 内容标签相似）再统一排序。
接口层不用动，替换的只是那个 `ORDER BY`。

**「换一批」怎么做**：把已经推过的 id 通过 `exclude` 参数传回后端排除。
`exclude` 会先逐个 `parseInt` 校验，再转成等量的 `?` 占位符 ——
**绝不把字符串直接拼进 SQL**。

---

### Q：收藏夹怎么建模？为什么不是「一篇笔记进多个夹」的中间表？

**我做的**（`server/src/lib/schema.ts`）：

```sql
CREATE TABLE favorite_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_folders_user_name ON favorite_folders(user_id, name);

CREATE TABLE favorites (
  user_id  INTEGER NOT NULL,
  post_id  INTEGER NOT NULL,
  folder_id INTEGER,                 -- 可空 = 未分类
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id),
  FOREIGN KEY (folder_id) REFERENCES favorite_folders(id) ON DELETE SET NULL
);
```

**收藏夹是「分类」不是「容器」**：一条收藏最多归一个夹，归不了就是未分类。
所以主键是 `(user_id, post_id)` 而不是 `id`，也不需要中间表。

**追问**：中间表模型（笔记↔夹 多对多）不是更灵活吗？
→ 更贴近某些产品，但收藏夹的价值在**「分开看」**而不是「交叉检索」。
中间表要额外回答一堆语义问题：往里加是「加」还是「移」？
笔记从 A 夹删掉时要不要级联删中间表行？这些歧义换来的能力在真实使用里
很少被用到，收益不抵复杂度。

**同名的处理**：唯一索引会直接报 `SQLITE_CONSTRAINT`，
但前端需要区分「重名」和「服务器炸了」，所以路由层先查一次，
重名返回 **409**，不重名才 INSERT。

---

### Q：删收藏夹为什么不连带删掉里面的笔记？

外键是 `ON DELETE SET NULL`：删夹之后里面的收藏退回**未分类**，
不是被删掉。

**为什么这么设计**：用户整理收藏夹时最怕的是「整理动作本身弄丢东西」。
如果删夹会连带删内容，就必须在每次删除前弹一个吓人的二次确认；
而退回未分类是无损的，所以 UI 上不做二次确认弹窗，
只在确认框里把后果写清楚：「删除『旅行灵感』不会删掉里面的 12 篇笔记，
它们会退回未分类」。

**这不只是技术选择，是产品选择** —— 少一个吓人的弹窗，
换来的是用户敢整理。

---

### Q：未分类为什么必须显式可见？

这是收藏功能最常见的投诉来源：**用户点完收藏，打开收藏页看到空的，
以为自己收藏失败了。**

因为「落在未分类」是点收藏的**默认行为**，不是一次分类结果。
如果不把它列出来，用户的 mental model 是「我收藏了 → 去收藏页找 → 没有」。

**技术上的坑更隐蔽**：如果前端图省事，拉全部收藏再本地过滤出未分类，
在收藏多的人身上会直接翻车 —— 第一页 20 条全是已归夹的，
本地过滤完一条不剩，看起来还是「空的」。
所以 `folderId=unclassified` 是**服务端真支持的一档筛选**，
`folder_id IS NULL` 直接走索引，分页不会把未分类挤到第二页之后。

---

### Q：收藏按钮怎么做到点了立刻变，又不出错？

和关注是同一套三步（`client/src/composables/useFavorite.ts`）：
**乐观翻转 → 用服务端权威计数覆盖 → 失败整体回滚**。

**收藏比关注多一个状态 `folderId`（归在哪个夹）**，回滚时它也得回去。
这是最容易漏的一处：请求失败后按钮正确地变回「未收藏」，
计数也退回去了，但界面上还显示在「旅行」夹里 —— 数据已经在骗人了。

**测试**：`client/tests/use-favorite.test.ts` 13 条，和 use-follow 的一一对应，
其中一条专门钉死「失败时 folderId 要回到原值」。
`scripts/favorite-smoke.mjs` 32 条浏览器断言走完整链路，
包括「删夹之后笔记退回未分类而不是消失」。

**追问**：为什么详情页不直接做个「收藏到XX夹」的下拉？
→ 一次点击只应该对应一个明确的动作。「归到某个夹」是**整理**动作，
发生在收藏页的批量整理里。按钮上挂选择器会把两个心智模型糊在一起。

---

### Q：通知怎么做才不刷屏？

**先说去重**。同一个人反复点赞同一篇笔记，通知列表里只应该有一条。
所以 `notifications` 上有一个唯一索引：

```sql
CREATE UNIQUE INDEX idx_notifications_dedup
  ON notifications(user_id, actor_id, type, post_id, comment_id);
```

**这里有个坑，是我写的时候真踩到的**：`post_id` / `comment_id` 一开始存的是
`NULL`（表示「不涉及」）。但 **SQLite 和标准 SQL 一样，UNIQUE 索引认为
`NULL` 与 `NULL` 不相等** —— 于是「关注」这种两列都空的行，
唯一索引对它**完全不起作用**，同一个人可以关注你一百次，
生成一百条一模一样的通知。

修法是用 **`0` 当哨兵**而不是 `NULL`，把 `NULL` 挤出索引之外。
代价是 `post_id` 建不了外键（`0` 那一行不存在），所以删笔记之后
通知里的 `post_id` 会变孤儿；查询时用 `LEFT JOIN posts` 兜住，
返回 `postId: null`，前端显示「原笔记已删除」而不是跳 404。

**再说重复互动该不该重发**。我的选择是：重复互动**不新增行**，
而是把老的那条 `created_at` 刷新、浮到最上面，并重新变回未读。
语义是「最近又赞了一次」，而不是刷屏。

**但去重挡不住另一种刷屏**。如果用户反复点赞也发通知，
去重逻辑会把那条老通知的 `read_at` 重新置空 —— 用户明明早就看过了，
却因为自己反复点而红点长亮。所以三个写入点（点赞 / 收藏 / 关注）
**都必须先判「是不是真新增了」再发通知**：
点赞看 `INSERT OR IGNORE` 的 `changes`，收藏看之前有没有收藏过。
去重能挡住「多出一行」，挡不住「已读被重新点亮」，这是两件事。

**最后是不给自己发通知**。这条规则抽成了 `createNotification()` 里的
第一个判断而不是散在各个路由里 —— 散着写早晚会漏一处，
漏了就是「你赞了自己的笔记，通知列表里有一条」。

**测试**：`server/tests/notifications.test.ts` 35 条 + e2e 25 条。
写测试时我自己也踩了一次同样的坑：`beforeEach` 只清了 `notifications`，
没清 `likes` / `favorites` / `follows`，于是「重复点赞」那条用例里
`INSERT OR IGNORE` 根本不生效，测到的不是「重复不重复通知」，
而是「什么都没发生」。这个坑在 e2e 脚本里又踩了一次，
现在两个地方的注释都写明了。

---

### Q：通知的未读数怎么实时更新？为什么不用轮询？

**不用轮询，复用已有的 WS hub。** 加一种服务端帧：

```ts
{ type: 'notification', payload: { unreadCount: number } }
```

**只推数字，不推整条通知**。两个原因：铃铛要的只是数字；
通知列表的分页 / 筛选 / 已读都是 HTTP 的职责，
在 WS 里重做一遍必然和 REST 对不上。

**遇到的第一个问题：路由层怎么拿到 hub**。
写通知的代码在 HTTP 路由里（点赞 / 收藏 / 关注 / 评论），
而 `Hub` 是 WebSocket 层的对象，两个模块互不相识。
Express 的路由签名塞不进 hub，全局变量又让测试没法注入一个假的。
最后加了一层模块级单例（`server/src/ws/instance.ts`），启动时 `setHub` 一次，
路由里 `getHub()` 拿。**拿不到就安静跳过推送** —— 通知照样落库，
推送是增强而不是数据一致性的前提，所以单测里不起 WS 也不影响。

**第二个问题：两路未读怎么合流**。聊天未读来自 `message` 帧（本地 +1），
通知未读来自 `notification` 帧（服务端给的权威值）。
关键是**后者必须覆盖而不是累加**：本地 +1 只是猜测，
别人可能同时在另一台设备上已经读过了。

页面的初值靠 REST 拉一次 —— 不能只靠 WS，
否则从刷新页面到 WS 连上之前，铃铛是空的。

**铃铛最终显示「聊天 + 通知」的合并数字**。两路未读在同一个入口里，
分成「3 · 2」两个数字只会让人以为要点两次。

**测试**：`scripts/notification-smoke.mjs` 开两个浏览器上下文，
断言的是「B 点赞的那一刻，停在原地的 A 的页面上铃铛自己 +1」——
这才是「实时」的可验证形式，断言 DOM 变化不如断言数字变化直接。

### Q：踩过什么「看起来像 bug 其实不是」的坑？

**后端加了新表，e2e 脚本报 `SqliteError: no such table: notifications`。**

第一次遇到时我以为进程持有旧代码，手动建了表。
第二次换成通知表又撞上一模一样的问题，于是这次没有再猜，
直接去查：`initSchema()` 在真实 DB 上跑一遍（能建出来），
再打一个必然碰库的接口，然后查表（也建出来了）。

**根因**：`server/src/lib/db.ts` 的建表是**懒执行**的 ——
`initSchema()` 在第一次真的碰到数据库时才跑。这样设计是有意的：
导入 db 模块没有副作用，单测也能用 `setTestDb` 换成 `:memory:`。
所以后端刚重启、还没处理过任何碰库的请求时，磁盘上就还没有新表。

**但这暴露了一个真实的易用性问题**：e2e 脚本为了绕开登录限流，
都是**直接连库**建测试用户 —— 于是脚本在还没做任何事之前就炸了，
报出来的是最底层那句 `no such table`，完全看不出「其实是后端还没初始化」。
修法是抽了 `scripts/ensure-schema.mjs`：先打一个必然碰库的公开接口
把 schema 触发出来，再确认需要的表真的在，不在就给人话提示。

**教训**：底层报错信息不会替你说出真正的原因。
遇到「明明刚加的东西不存在」时，先去验证**那段代码到底有没有被执行过**，
而不是先怀疑运行环境。

---

### Q：话题为什么没有 topics 表？

**没有**。话题在库里就是 `posts.topic_tag` 这个自由文本，话题页是它的
**现算聚合视图**（`GROUP BY topic_tag` 算出笔记数和参与人数）。

**为什么不用实体表**：

1. `topic_tag` 是发布时自由输入的。要有 `topics` 表就得加「输入即创建」的
   同步逻辑，等于把同一份数据存两遍，还得处理「建了话题但一篇笔记都没有」
   的空壳 —— 而空壳话题页恰恰是最糟的产品形态（用户点进去发现是空的，
   分不清是自己没内容还是功能没做完）。
2. 派生视图是**零维护**的。有人发了「前端开发」，话题页立刻就有内容，
   不需要任何后台操作。

**什么时候才该上实体表？** 当话题需要**自己的元数据**时：
封面图、简介文案、运营位、审核状态、话题主持人。那时候「话题」才从
「标签的分组」变成「一个可运营的对象」，加表之后现有数据可以直接迁，
接口形状不用变。

**追问**：那 `topic_tag` 是自由文本，怎么避免「前端开发」和「前端 开发」
变成两个话题？
→ **接受它**。话题是**精确匹配**的，搜索框里的联想才是模糊的（`LIKE`）。
和真实产品一致：用户搜「前端」会同时看到两个话题，点哪个看哪个 ——
模糊只发生在「找」这一层，不发生在「是」这一层。
真要治理可以加话题别名表，但那是运营需求不是技术需求。

**追问**：相关话题怎么推？
→ 按「同话题作者的其它话题」而不是随机推热门：
`WHERE user_id IN (SELECT user_id FROM posts WHERE topic_tag = ?)`。
「写了同一个话题的人还关注了什么」天然和你此刻的浏览兴趣相关，
而随机推热门等于在话题页里再放一遍首页的推荐位。

---

### Q：怎么区分「404 是错误」和「404 是预期状态」？

话题不存在时后端返 404（用户手敲 URL、或者搜了个没用过的词），
但那是**预期状态** —— 页面本来就要渲染自己的空态。

可 404 走 axios 的 reject 路径，会被响应拦截器当成错误，
在控制台打一条 `[API Error]` 再 reject。于是页面拿到一个「异常」而不是
一个「没有这个话题」，还顺带把「零 console error」的 e2e 断言也弄挂。

**第一版写法是错的**：我想用
`validateStatus: (s) => s === 404 || (s >= 200 && s < 300)`。
但响应拦截器已经 `return response.data` 把 `AxiosResponse` 解开了，
调用方拿到的就是业务数据本身 —— `status` 和 `data` **都读不到**，
于是连正常存在的话题都被判成 `null`，页面一律显示「还没有笔记」。

**修法**：改用 config 标记。请求时带 `silent404`，拦截器在 reject 分支里
先判断它：命中就 `resolve(null)`，既不打日志也不弹错。
这个约定写在 `request.ts` 的 `getOrNull` 注释里。

**通用判据**：「某个 HTTP 状态码算不算错误」不是后端单方面能决定的，
取决于**调用方想怎么表现它**。所以这个判断必须做在调用侧，
不能硬编码进拦截器 —— 否则「用户访问了不存在的资源」这种每天都会发生的
正常情况，会一直被当成故障报出来。

### Q：评论的二级回复为什么只做两层？

**三层以上的楼没人看得下去**，而无限嵌套在前端意味着要写一整套
折叠 / 递归渲染 / 「展开 N 层」的交互。所以我把它限制成两层，
代价是「回复一条回复」会被拉平成对父评论的回复 —— 这个代价我明确接受了。

**两条相关的设计**：

1. **回复和一级评论分开返回**（`list` + `replies` 两个数组），
   不是后端组装成嵌套树。展示只需要作用在一级评论上，
   回复跟着各自的父评论带出来。组装成树的话后端得递归，
   前端还得拆开才能渲染「回复某人」的头部。
2. **通知给「上一级作者」而不是笔记作者**：一级评论通知笔记作者，
   回复通知被回复的那个人。回复楼中楼不该去打扰笔记作者 ——
   他收一条就够了，多一条只是噪音。

**追问**：`parent_id` 为什么没有外键？
→ 因为它是 `ALTER TABLE ADD COLUMN` 加的，而 SQLite **不允许在 ADD COLUMN
时加外键**（外键只能在 `CREATE TABLE` 时声明）。要给一张老表补外键，
只能用「新建带列的表 + 拷贝数据 + 改名」，代价远大于收益 ——
而且「删父评论时要不要级联删回复」本来就应该由应用层显式决定，
而不是被一个约束悄悄决定。

### Q：置顶为什么不需要唯一约束？

规则本身已经把候选集限制到一条了：**只有笔记作者能置顶，而且只能置顶
他自己写的那条评论**。所以一条笔记最多只有一条置顶，
加 `UNIQUE(post_id) WHERE pinned_at IS NOT NULL` 这种部分索引是多余的。

这也解释了为什么 UI 上「置顶」按钮只给笔记作者自己的评论显示：
把规则做进接口之后，前端不给别人入口是**顺带**的事，而不是必须记住的约定。

**顺带**：前端 `sortComments` 的排序规则必须和后端的 `ORDER BY` 一致。
两边不一致的症状很隐蔽 —— 用户点一下置顶，界面里顺序对了，
刷新一下又变了。所以这条规则在 `utils/comments.ts` 和
`routes/comments.ts` 两边都写了注释指给对方。

**追问**：展开状态为什么存「收起集合」而不是「展开集合」？
→ 本地发完回复是 `replies.push(newReply)`，**引用没变**，
`watch(replies)` 根本不触发，于是新回复发出去了却不显示 ——
这个 bug 是浏览器验证时发现的，单测测不到。
存「收起集合」就没这个问题：新回复进来时父评论不在收起集合里，
自然就是展开的。默认展开也更符合预期（有人在回你，不该藏起来）。

### Q：通知设置为什么是三个开关而不是一个？偏好存哪儿？

**三个开关**对应已有的三个分类（赞和收藏 / 新增关注 / 评论和@），
而不是让用户去区分 `like` 和 `favorite` —— 它俩都属于「赞和收藏」，
再拆开对用户没有意义，只会让设置面板变复杂。

**存储选 `users` 表一列 JSON，不建关系表。** 判断依据是：
**这列从来没有被查询过**。它只在「给某个用户写一条通知」那一刻被读一次，
用来决定这条要不要写；而读的时候已经知道 `userId` 了，
顺手把 `users` 那一行取出来就行，不需要额外一次查询 ——
也就没有「为了查询而建表」的理由。

**读取时的默认值必须是「全开」**。`NULL` / 空串 / 坏 JSON / 值不是布尔，
一律退回全开。这条看着像小事，其实是很关键的产品决策：
如果「解析失败就当关掉」，用户会莫名其妙收不到通知，
而且他**查不出为什么** —— 这种 bug 比崩溃难查得多。

**关掉只影响之后的新通知，已经存在的不会被删。**
用户关掉的是「不要再打扰我」，不是「把我的通知删掉」。
所以 UI 上把这句话直接写在开关下面，不让用户猜。

**追问**：为什么「只关一类」要保证不影响其他类？
→ 因为写通知的地方有 5 个（赞 / 收藏 / 关注 / 评论 / 提及），
判断放在 `createNotification()` 里而不是各个调用点，
就是为了保证「所有写通知的地方都走同一个入口」——
这条不变量破了以后，漏一处就会有一个开关不起作用。
e2e 里专门验了这一点：关掉「赞和收藏」后，点赞不 +1 但关注照常 +1。

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

### Q：踩过什么「代码写了但根本没生效」的坑？

**个人主页的「公开 / 私密 / 合集」切换器从来没显示过** ——
但代码里明明写了，模板也没报错，测试也全绿。

**怎么定位的**：写收藏夹筛选时顺手在 tab 右侧加了个下拉，
结果它也不显示。于是不再猜，直接在浏览器里 dump
`.el-tabs__header` 的 `innerHTML`，发现里面**根本没有 extra 那块内容**。

**根因**：Element Plus 2.14.6 的 `el-tabs` **没有 `extra` 插槽**
（只有 `add-icon` 和 `default`）。写进 `<template #extra>` 的东西
不会报错，只是被静默丢弃 —— Vue 对未知插槽就是这么宽容。

**修法**：把控制条移到 tabs 上方自己占一行、右对齐，不依赖任何插槽。

**这个坑的教训**（比 bug 本身更值钱）：
「模板里写了 → 编译通过 → 测试全绿」这三件事**都不能证明它渲染了**。
所以这类「组件有没有把内容吐出来」的断言，只能靠 e2e 在真实 DOM 上验。
`scripts/favorite-smoke.mjs` 里现在有一条
`check('出现收藏夹筛选器', ...)`，就是这次 bug 留下的回归钉子。

**另一个同类的坑**：侧栏高亮原本靠 `navItems.find(item => item.match?.())` ——
「发现」那一项的 match 在**所有**非关注路由上都返回 true，
`find` 第一个就命中，于是 `/favorites`、`/settings`、`/market`
全被高亮成「发现」。**靠「第一个 true」决定结果的写法太容易误伤**，
改成按 path 穷举，每个分支都能一眼看出该高亮谁。

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

面试前确认这 24 条能不看文档说出来：

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
- [ ] 收藏夹为什么不做「一篇笔记进多个夹」的中间表
- [ ] 未分类为什么必须在服务端显式支持，而不能前端本地过滤
- [ ] 删收藏夹为什么退回未分类而不是删内容
- [ ] 通知去重为什么 `post_id` 要用 0 哨兵而不是 NULL
- [ ] 重复互动为什么「浮到顶部 + 重新变未读」而不是新增一条
- [ ] 通知未读数为什么走 WS 而不是轮询，为什么是覆盖而不是 +1
- [ ] 话题为什么不做成实体表，什么时候才该上
- [ ] 为什么话题是精确匹配而搜索联想才模糊
- [ ] 二级回复为什么只做两层，代价是什么
- [ ] 置顶为什么不需要唯一约束
- [ ] 通知设置为什么是三个开关，偏好为什么存 JSON 而不是关系表
- [ ] `vi.resetModules()` + `vi.spyOn` 为什么会静默失效
- [ ] CI 里 Node 版本那个「假绿」的坑

---

## 附：关键文件索引

| 想讲什么                      | 去哪看                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| WS 帧协议                     | `server/src/ws/protocol.ts` + `client/src/api/wsProtocol.ts`                                     |
| 多端同步                      | `server/src/ws/hub.ts`                                                                           |
| 握手 / 心跳 / 重连 / 离线补偿 | `server/src/ws/server.ts` + `client/src/composables/useWebSocket.ts`                             |
| 乐观发送 + ack 收敛           | `client/src/composables/useChat.ts`                                                              |
| 搜索注入防护                  | `server/src/routes/posts.ts`（`/search` 与 `/search/suggest`）                                   |
| 关注关系建模                  | `server/src/lib/schema.ts`（`follows`）+ `server/src/routes/users.ts`                            |
| 关注按钮的乐观更新            | `client/src/composables/useFollow.ts` + `client/tests/use-follow.test.ts`                        |
| 收藏夹建模                    | `server/src/lib/schema.ts`（`favorites` / `favorite_folders`）+ `server/src/routes/favorites.ts` |
| 收藏按钮的乐观更新            | `client/src/composables/useFavorite.ts` + `client/tests/use-favorite.test.ts`                    |
| 通知去重与「不通知自己」      | `server/src/lib/notify.ts`（`createNotification` 是唯一写入口）                                  |
| 通知未读的实时推送            | `server/src/ws/instance.ts`（hub 单例）+ `ws/protocol.ts` 的 notification 帧                     |
| 话题为什么不做成实体表        | `server/src/routes/topics.ts`（GROUP BY topic_tag 的聚合视图）+ `client/src/views/TopicView.vue` |
| 二级回复 / 置顶的取舍         | `server/src/routes/comments.ts` + `client/src/utils/comments.ts`（排序规则必须前后端一致）       |
| 瀑布流算法                    | `client/src/utils/masonry.ts`                                                                    |
| 动效 token 与降级             | `client/src/assets/styles/motion.css` + `scripts/motion-check.mjs`                               |
| 容器化                        | `docker-compose.yml` + `server/Dockerfile` + `client/Dockerfile` + `client/nginx.conf`           |
| CI 配置                       | `.github/workflows/ci.yml`                                                                       |
| 更多踩坑记录                  | `docs/architecture.md`                                                                           |
