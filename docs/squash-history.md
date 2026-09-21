# Commit History 重整（可选执行）

当前 main 的 commits（从最近到最远）：

```
b986789 docs: comprehensive README + architecture.md
4fa9d00 refactor: extract shared limits into constants.ts
2c83818 chore: strip upload debug logs
7efea2e feat(client): restructure profile + add messages/market views
9369fbd refactor(client): replace top nav with fixed bottom nav
007069f chore(client): downgrade upload lifecycle logs
b34a76b fix(client): wrap pending image in reactive()
a24bee8 fix(client): proxy /uploads to backend
39053f1 debug(publish): log every XHR lifecycle event
47e391e debug(publish): use console.error for upload lifecycle
ec5b326 fix(publish): use absolute API base URL
0b91a5d fix(publish): call setRequestHeader after xhr.open()
27822a0 fix(publish): bypass axios — use XMLHttpRequest directly
92b953e fix(upload): remove axios default Content-Type
6c678b9 debug(upload): add FormData + multer debug logs
d4a5d49 fix(upload): raise size limit to 10MB + verbose error logging
f2ce980 fix(publish): let axios set multipart Content-Type with boundary
8ba3002 fix(publish): show upload progress percentage
8a0bbd9 feat(publish): image upload with multer
85edd61 feat(profile): add profile edit modal + post grid
... 更早 commits
```

11 个 upload 相关的 commit 适合合并成 1~2 个。

---

## 方案 A：保守（推荐）

把 upload 的 11 个 commit 合成 **2 个**，其他不动。命令：

```bash
cd D:\my\sg
git fetch origin

# soft reset 到 upload 前（保留 85edd61 及之前的全部历史）
git reset --soft 85edd61

# 现在 working dir 有所有 upload 改动的累计；先 add server 部分作为 commit 1
git add server/src/routes/uploads.ts server/src/lib/db.ts
git commit -m "feat(server): image upload with multer (10MB, 9 files)"

# 剩下 client + 配置文件等作为 commit 2
git status --short   # 确认还有内容
git add -A
git commit -m "feat(client): XHR-based image upload pipeline

- Bypass axios 1.x FormData/Content-Type bug via raw XMLHttpRequest
- setRequestHeader after open(), absolute URL to :3000 backend
- 60s client-side timeout, progress events update img.progress
- Wrap pending image in reactive() so onload status updates trigger UI"

# force-push（--force-with-lease 比 --force 安全，会拒绝 push 时远端有新 commit）
git push --force-with-lease origin main
```

结果：upload 相关从 11 个 → 2 个，main 总 commits 从 ~28 个 → ~19 个。

---

## 方案 B：激进

把 upload (11) + reactive fix (1) + proxy (1) + log cleanup (1) 共 14 个合并成 **1 个**：

```bash
cd D:\my\sg
git reset --soft 85edd61

git add -A
git commit -m "feat(publish): end-to-end image upload with dev proxy + UI fix

server:
- multer diskStorage, 10MB / 9 files limit, image/* filter

client:
- XHR-based upload (bypasses axios 1.x FormData bug)
- absolute URL :3000, setRequestHeader ordering
- wrap pending image in reactive() so async status updates trigger UI
- vite.config proxies /uploads to backend in dev

chore:
- 8 lifecycle logs downgraded from console.error to console.log,
  3 error path strips (UI shows errorMsg already)"

git push --force-with-lease origin main
```

结果：upload pipeline 1 个干净的 commit。

---

## 方案 C：什么都不做

保留当前 history。10+ 个 upload commit 看起来比较"真实开发过程"，简历投 GitHub 时候 reviewer 也能看到 debug 思考路径——但也意味着更多噪音。

---

## ⚠️ 注意事项

- `--force-with-lease` 会拒绝推送如果远端有新 commit（多人协作保护）。单人项目可以直接 `--force`
- 如果你 fork 了项目给别人看，squash 后他们的 fork 也会 history diverge
- 推荐先 `git clone ...-backup` 旧 history 一份到别处，squash 出问题可还原
- 建议在 squash 之前先 push 当前代码到 origin（已经 push 过了），这样即使 squash 出问题还能 `git reset --hard origin/main`

## 推荐

**方案 A**。理由：
- 保留 upload pipeline 的 2 步 server/client 切分（更易 review）
- 不动其他已经清晰的 commit
- 总 commits 减少但叙事完整