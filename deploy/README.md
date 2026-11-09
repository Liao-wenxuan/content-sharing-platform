# 部署：从一台空机器到能访问

这一层以前只存在于口述里 —— 线上跑着 Caddy + pm2，仓库里却只有 Docker Compose，
换个机器复现全靠回忆。`deploy/` 就是把这部分补齐：反代配置、进程定义、
环境变量清单、发布脚本，全部版本化。密钥和真实主机名不在仓库里。

> 只想看效果、不想装东西：<https://csp.bscjs.top>（演示账号见根目录 README）。
> 只想在本机起一套完整环境：`docker compose up --build -d` —— 拓扑与裸机完全一致，
> 差别只有「反代是 nginx 还是 Caddy」。裸机路径适合真上线，Compose 适合本地复现。

## 拓扑

```
浏览器 ──HTTPS──> Caddy (:443)
                  ├── /assets/* / 任意路径 ──> client/dist 静态文件 + SPA fallback
                  ├── /api/*    ──reverse_proxy──> Node :3000 (pm2: csp-api)
                  ├── /uploads/*──reverse_proxy──> Node :3000 (express.static)
                  └── /ws*      ──reverse_proxy──> Node :3000 (WebSocket)
                                                      │
                                                      └── SQLite 单文件（在 repo 外）
```

单一 origin，所以不需要配 CORS，也不需要为 WS 单独开域。Caddy 负责 TLS 与缓存头，
Node 只管业务。数据库和上传文件放在 `repo` 之外，是**发布脚本绝不触碰**的区域。

线上实测的进程定义：`pm2 describe csp-api` → `fork_mode` / `cwd=<repo>/server` /
`script=dist/index.js` / `interpreter=node`。这份值已经写进 `ecosystem.config.cjs`。

## 首次部署（空机器）

前置：Node ≥ 22（CI 用 24）、pm2、Caddy 2.6+、一个指向这台机器的域名。

```bash
# 1. 代码 + 依赖
git clone <your-repo-url> /srv/csp/repo && cd /srv/csp/repo
npm ci && npm --prefix client ci && npm --prefix server ci
npm --prefix client run build && npm --prefix server run build

# 2. 配置（真密钥只放这里，不进版本库）
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env                       # JWT_SECRET 用 openssl rand -hex 32 生成
mkdir -p /srv/csp/data                    # DB_PATH 指向的目录，要可写
set -a; . deploy/.env; set +a

# 3. Caddy：把 deploy/Caddyfile 的站点块合并进 /etc/caddy/Caddyfile
#    （变量由环境注入，也可以直接替换成真实域名和静态根）
export CSP_DOMAIN=csp.example.com
export CSP_WEB_ROOT=/srv/csp/repo/client/dist
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 4. 进程
pm2 start deploy/ecosystem.config.cjs --only csp-api
pm2 save                                  # 开机自启
pm2 logs csp-api --lines 30                # 确认 [env] 摘要打印出来

# 5. 演示数据（可选；种子幂等，会先清掉上一批演示笔记）
node server/seed.mjs

# 6. 验证
curl -fsS https://csp.example.com/api/health
```

`server/src/lib/env.ts` 会在启动期校验 `JWT_SECRET`：生产环境没配就直接 throw，
不会带着弱密钥悄悄跑起来。数据库迁移由后端启动时自己执行，不用单独跑脚本。

## 日常发布

在**本地**执行，脚本会读 `deploy/.env`：

```bash
./deploy/deploy.sh                # 只改了前端：build → 上传 → 原子替换 client/dist
./deploy/deploy.sh --full         # 后端也改了：额外替换 server/dist 并 pm2 restart
./deploy/deploy.sh --rollback     # 把上一次的 client/dist.old 换回来
./deploy/deploy.sh --dry-run      # 只看计划，不构建不上传
```

三条刻意的约束：

1. **构建在本地做。** 早先试过在服务器上 `git pull && npm run build`，
   构建把内存吃满、SSH 被掐断，站点停在一次半成品状态。现在服务器只负责解包和换目录。
2. **纯前端发布不重启 Node。** 重启会断掉所有在线 WebSocket 连接（聊天、未读推送），
   而静态产物换目录根本不需要它参与。
3. **换目录而不是覆盖目录。** 解到 `dist.new` → 校验 `index.html` / `dist/index.js` 存在 →
   `dist` 挪成 `dist.old` → `dist.new` 上位；任何一步失败都把 `dist.old` 换回来。
   用户要么看到完整的旧版、要么看到完整的新版，不会看到半个版本。

想部署后自动探活，在 `deploy/.env` 里加一行：

```bash
DEPLOY_VERIFY_URL=https://csp.example.com
```

## 缓存头为什么这么分

| 路径              | 策略                                     | 理由                                                                      |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `/assets/*`       | `public, max-age=31536000, immutable`    | 文件名带内容哈希，内容变了文件名就变，不存在「旧文件需要失效」的问题      |
| 其它（HTML 入口） | `no-cache`                               | SPA 所有路径都回落同一个 `index.html`，缓存住它等于把用户永久钉在旧入口   |
| `/uploads/*`      | 后端 `express.static` 给 `30d immutable` | 上传后的文件名带随机后缀，同样不会变；Caddy 侧用 `@html` 排除以免叠两份头 |

早期把长缓存头套在全域上，结果发版后用户刷新仍是旧页面 —— 现在 `index.html` 的
`no-cache` 是发布流程能生效的前提。

## 发布流程不碰什么

`deploy.sh` 的 tar 只装 `client/dist`（以及 `--full` 时的 `server/dist`）。下面这些
永远不在替换范围内，回滚也不会动：

- `CSP_DATA_DIR` / `DB_PATH` 指向的 SQLite 文件（含 `-wal` / `-shm`）
- `server/uploads/`（用户上传的图片、视频）
- `deploy/.env`、`server/.env`（密钥）
- Caddy 配置和 pm2 的开机自启列表

改数据库结构时要单独备份；发布脚本不会替你做这件事，也不该做。

## 与 Docker Compose 的关系

`docker-compose.yml` 是**同构**版本：`web`(nginx) 反代 `/api /uploads /ws` 到 `server`，
后端数据是挂卷的单个 SQLite 文件，与裸机一致。所以能在 CI 里跑通的链路，
换成 Caddy + pm2 不会因为拓扑不同而失效。

差异只有三处，都是部署形态而非业务代码：反代软件、TLS 终止位置、
进程管理器（容器靠 `restart: unless-stopped`，裸机靠 pm2）。`docs/interview.md`
里「线上那份和仓库里的是同一个东西吗」这一问，现在可以指着这个目录回答。
