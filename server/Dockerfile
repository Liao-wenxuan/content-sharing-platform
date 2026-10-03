# syntax=docker/dockerfile:1

# ===== 构建阶段 =====
FROM node:24-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 是原生模块。没有匹配到 prebuild 时 npm 会退回源码编译，
# 少了这四样会直接报 node-gyp 失败。工具链只装在这个阶段，
# 运行时阶段不复制，镜像不会因此胖一圈。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 先只拷 package.json 让这一层能被缓存：
# 只要依赖没变，改业务代码重建时就不用重装依赖
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 装完就把 devDeps 删掉，只留运行时真正需要的
RUN npm prune --omit=dev


# ===== 运行时阶段 =====
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# DB_PATH 指到 /data：SQLite 是个「文件」，而 Docker 的 named volume 只能挂目录，
# 所以数据路径交给部署方指到卷上（docker-compose.yml 里挂 /data）
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/data.db

# curl 留给 HEALTHCHECK 用
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 演示数据种子：两个都是生产依赖，容器里可以直接 node seed.mjs
COPY seed.mjs ./

# 挂载点先建好：bind mount 到不存在的路径时，Docker 只会建空目录
RUN mkdir -p /app/uploads /data

EXPOSE 3000

# 让 nginx 那边能等健康检查通过再放流量，
# 否则 compose 里 depends_on: service_healthy 永远等不到
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

# 直接 node 而不是 npm start：npm 会多起一层进程转发 SIGTERM，
# 结果容器的优雅退出钩子（关 WS 连接）收不到信号，只能等超时被强杀
CMD ["node", "dist/index.js"]
