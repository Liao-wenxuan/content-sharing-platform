#!/usr/bin/env bash
# 发布到裸机（Caddy + pm2 + Node + SQLite）。
#
#   ./deploy/deploy.sh                 # 只发前端：本地 build → 上传 → 原子替换 dist
#   ./deploy/deploy.sh --full         # 前端 + 后端，并重启 pm2
#   ./deploy/deploy.sh --rollback     # 把上一次的 client/dist.old 换回来
#   ./deploy/deploy.sh --dry-run      # 只打印计划，不构建不上传
#
# 设计边界（别改）：
# - 只碰 client/dist 和 server/dist。数据库、uploads、.env 一律不进 tar、不删不覆盖。
# - 后端没改就绝不重启 Node —— 重启会断掉所有在线 WebSocket 连接。
# - 构建在本地做，服务器只负责解包和换目录。早期在服务器上跑 npm build
#   把内存吃满、SSH 直接被掐掉过，从那以后就不在服务器上编译了。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="frontend"
DRY=0
for arg in "$@"; do
  case "$arg" in
    --full) MODE="full" ;;
    --rollback) MODE="rollback" ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg"; exit 1 ;;
  esac
done

if [[ -f deploy/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . deploy/.env
  set +a
fi

: "${DEPLOY_HOST:?请在 deploy/.env 里配置 DEPLOY_HOST（例如 deploy@your-host）}"
: "${DEPLOY_DIR:?请在 deploy/.env 里配置 DEPLOY_DIR（服务器上的仓库根目录）}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
# 可选：额外 ssh/scp 参数。比如 Windows 上 ~/.ssh/config 首行带 BOM 时，
# 用 DEPLOY_SSH_EXTRA_OPTS="-F /dev/null -i /c/Users/you/.ssh/id_ed25519" 绕开。
EXTRA_OPTS=()
read -r -a EXTRA_OPTS <<< "${DEPLOY_SSH_EXTRA_OPTS:-}" || true
if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then
  EXTRA_OPTS+=("-i" "$DEPLOY_SSH_KEY")
fi
SSH_CMD=(ssh "${SSH_OPTS[@]}" "${EXTRA_OPTS[@]}" "$DEPLOY_HOST")
SCP_CMD=(scp "${SSH_OPTS[@]}" "${EXTRA_OPTS[@]}")

echo "[deploy] 模式=$MODE  目标=$DEPLOY_HOST:$DEPLOY_DIR"

if [[ "$DRY" == 1 ]]; then
  echo "[dry-run] 会构建：client$([[ "$MODE" == full ]] && echo ' + server')"
  echo "[dry-run] 会执行：${SSH_CMD[*]} bash /tmp/sg-remote-install.sh '$DEPLOY_DIR' '$MODE' ..."
  echo "[dry-run] 不会动：数据库 / uploads / .env"
  exit 0
fi

if [[ "$MODE" != rollback ]]; then
  echo "[1/4] 本地构建"
  npm --prefix client run build
  if [[ "$MODE" == full ]]; then
    npm --prefix server run build
  fi

  echo "[2/4] 打包"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  tar -czf "$TMP_DIR/client-dist.tgz" -C client/dist .
  if [[ "$MODE" == full ]]; then
    tar -czf "$TMP_DIR/server-dist.tgz" -C server/dist .
  fi

  echo "[3/4] 上传"
  "${SCP_CMD[@]}" deploy/remote-install.sh \
    "$DEPLOY_HOST:/tmp/sg-remote-install.sh" >/dev/null
  "${SCP_CMD[@]}" "$TMP_DIR/client-dist.tgz" "$DEPLOY_HOST:/tmp/client-dist.tgz" >/dev/null
  if [[ "$MODE" == full ]]; then
    "${SCP_CMD[@]}" "$TMP_DIR/server-dist.tgz" "$DEPLOY_HOST:/tmp/server-dist.tgz" >/dev/null
  fi
else
  "${SCP_CMD[@]}" deploy/remote-install.sh \
    "$DEPLOY_HOST:/tmp/sg-remote-install.sh" >/dev/null
fi

echo "[4/4] 服务器原子替换"
"${SSH_CMD[@]}" bash /tmp/sg-remote-install.sh \
  "$DEPLOY_DIR" "$MODE" /tmp/client-dist.tgz /tmp/server-dist.tgz
"${SSH_CMD[@]}" 'rm -f /tmp/sg-remote-install.sh /tmp/client-dist.tgz /tmp/server-dist.tgz' || true

# 可选：部署后探活。设了 DEPLOY_VERIFY_URL 才跑，避免本地测试时被占位域名卡住。
if [[ -n "${DEPLOY_VERIFY_URL:-}" && "$MODE" != rollback ]]; then
  echo "[verify] $DEPLOY_VERIFY_URL"
  curl -fsS -o /dev/null -w "  home=%{http_code}\n" "$DEPLOY_VERIFY_URL"
  curl -fsS -o /dev/null -w "  api=%{http_code}\n" "${DEPLOY_VERIFY_URL%/}/api/health"
fi

echo "[deploy] 完成"
