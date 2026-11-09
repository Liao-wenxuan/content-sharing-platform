#!/usr/bin/env bash
# 在服务器上执行，由 deploy.sh 通过 scp 上传后调用。
# 单独成文件而不是塞进 ssh heredoc：引号在 ssh 里会被两层 shell 吃掉一次，
# 之前就因为这个把清理脚本跑坏过。
#
# 参数： $1=repo 根目录  $2=frontend|full|rollback  $3=client tar  $4=server tar(full)
set -euo pipefail

REPO="$1"
MODE="$2"
CLIENT_TAR="${3:-}"
SERVER_TAR="${4:-}"

# 守卫：目录不对就立刻停，绝不在陌生路径下做 mv/rm。
test -f "$REPO/client/package.json" || { echo "REPO 路径不对：$REPO"; exit 1; }
test -f "$REPO/server/package.json" || { echo "REPO 路径不对：$REPO"; exit 1; }

# 原子替换一个产物目录：解到 .new → 校验 → 旧目录挪成 .old → .new 上位。
# 失败时把 .old 换回来，网站不会停在「半个新版」的状态。
# .old 故意保留，rollback 就是把它换回去。
replace_dir() {
  local base="$1" name="$2" checkfile="$3" tar="$4"
  cd "$base" || exit 1
  test -f "$tar" || { echo "找不到上传包：$tar"; exit 1; }

  rm -rf "$name.new"
  mkdir -p "$name.new"
  if ! tar -xzf "$tar" -C "$name.new"; then
    echo "解包失败：$name"; rm -rf "$name.new"; exit 1
  fi
  if [[ ! -f "$name.new/$checkfile" ]]; then
    echo "产物校验失败：$name.new/$checkfile 不存在"; rm -rf "$name.new"; exit 1
  fi

  rm -rf "$name.old"
  if ! mv "$name" "$name.old"; then
    echo "备份旧 $name 失败"; rm -rf "$name.new"; exit 1
  fi
  if mv "$name.new" "$name"; then
    echo "SWITCH_OK  $base/$name  →  $(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$name/$checkfile" 2>/dev/null | head -1 || echo ok)"
  else
    mv "$name.old" "$name" || true
    echo "SWITCH_FAILED，已回滚 $name"; exit 1
  fi
}

rollback_dir() {
  local base="$1" name="$2"
  cd "$base" || exit 1
  if [[ ! -d "$name.old" ]]; then
    echo "没有可回滚的 $name.old（上次部署没成功替换？）"; exit 1
  fi
  mv "$name" "$name.failed"
  mv "$name.old" "$name"
  rm -rf "$name.failed"
  echo "ROLLBACK_OK  $base/$name"
}

case "$MODE" in
  frontend|full)
    replace_dir "$REPO/client" dist index.html "$CLIENT_TAR"
    if [[ "$MODE" == full ]]; then
      replace_dir "$REPO/server" dist dist/index.js "$SERVER_TAR"
      # 后端换了才需要重启；纯前端发布不惊动 Node 进程，
      # 也就不会断掉在线的 WebSocket 连接。
      pm2 restart csp-api --update-env
      echo "PM2_RESTARTED"
    fi
    ;;
  rollback)
    rollback_dir "$REPO/client" dist
    ;;
  *)
    echo "未知模式：$MODE"; exit 1
    ;;
esac
