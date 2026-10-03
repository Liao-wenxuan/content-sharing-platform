# syntax=docker/dockerfile:1

# ===== 构建阶段 =====
FROM node:24-bookworm-slim AS build

WORKDIR /app

# 只拷 package.json 先装依赖，让这一层能被缓存
COPY package*.json ./
RUN npm ci

COPY . .

# VITE_API_BASE 是「构建时」注入的：vite 会把 import.meta.env.VITE_*
# 静态替换掉，运行时再设环境变量是没用的（那时 bundle 早就生成了）。
#
# 容器里前后端同源（都挂在 nginx 的 8080 端口上），所以用相对路径 /api，
# 由 nginx 反代到 server 容器。开发时是 http://localhost:3000/api，两边互不影响。
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=${VITE_API_BASE}

RUN npm run build


# ===== 运行时阶段 =====
FROM nginx:1.27-alpine AS runtime

# 反代配置：/api 和 /uploads 打到后端，/ws 做 WebSocket 升级，其余走静态 + SPA fallback
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
