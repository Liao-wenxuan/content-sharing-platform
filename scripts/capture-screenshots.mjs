/**
 * README 配图的总入口
 *
 * 为什么要有它：以前配图分散在四个脚本里，输出到**两个**目录
 * （`docs/screenshots/` 和 `shots/`），而 README 引用的是前者。
 * 于是另外几个脚本拍完还得**手工复制**过去 ——
 * 手工复制的那几张（28 / 29 / 30 / 31 / 32 / 33）后来就再也没更新过。
 *
 * 现在：四个脚本统一输出到 `docs/screenshots/`，这个入口按顺序跑完它们，
 * 再写一份 `manifest.json` 记下「拍的时候界面代码长什么样」。
 *
 * ⚠️ 跑之前需要本地起好 dev 环境（后端 :3000、前端 :5173）。
 *
 * 用法：npm run screenshot
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHOTS_DIR, clientSrcHash } from './lib/shot-common.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const STEPS = [
  ['screenshot-docs.mjs', '主流程 22 张（首页 / 搜索 / 详情 / 市集 / 关系 / 推荐流）'],
  ['image-shot.mjs', '发布页的压缩收益 1 张'],
  ['reveal-shot.mjs', '滚动入场三态 3 张（并逐像素比对降级完成态）'],
  ['settings-shot.mjs', '设置页分组 + 面板 2 张']
]

console.log('== README 配图重拍 ==\n')
for (const [file, what] of STEPS) {
  console.log(`-- ${file}（${what}）`)
  execFileSync('node', [path.join(ROOT, 'scripts', file)], { stdio: 'inherit' })
  console.log('')
}

// ===== 写 manifest =====
//
// 记的是「拍的时候界面代码的哈希」——
// 下次检查时重算一遍，对不上就说这批图过期了。
//
// 为什么用内容哈希而不是 commit sha：
// 拍图和改代码常常在同一个 commit 里（改了 UI 顺手重拍），
// 用 commit 边界判断会误报；内容哈希和提交顺序无关。
const files = readdirSync(SHOTS_DIR)
  .filter((f) => /\.(png|jpe?g)$/.test(f))
  .sort()

const manifest = {
  capturedAt: new Date().toISOString(),
  clientSrcHash: clientSrcHash(ROOT),
  shots: files.map((f) => ({
    file: f,
    bytes: statSync(path.join(SHOTS_DIR, f)).size
  }))
}

writeFileSync(
  path.join(SHOTS_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf8'
)

console.log(`\n共 ${files.length} 张，写入 docs/screenshots/manifest.json`)
console.log('界面代码哈希：' + manifest.clientSrcHash.slice(0, 16) + '…')

// ===== 自动清理脚本造的临时数据和笔记 =====
//
// 以前这里只 print 一句「收尾：node server/cleanup-test-data.mjs --yes」让人手工跑。
// 结果是四个子脚本造的 @test.local 账号和它们发的演示笔记一直留在 data.db 里，
// 每跑一次配图就多 4 条同名笔记。推荐流按时间倒序，于是首页前几条全是
// 「把周末空出来…」——轮播 4 张图里有 3 张标题相同、封面只在两张间来回切，
// 用户看到的就是「轮播动不了」。
//
// 清理放在 manifest 之后：manifest 记的是界面代码哈希，和数据库无关；
// 且配图已经拍完，清理失败不该把整批图判成失败。
console.log('\n-- 清理脚本造的临时账号和笔记')
try {
  execFileSync('node', [path.join(ROOT, 'server', 'cleanup-test-data.mjs'), '--yes'], {
    stdio: 'inherit'
  })
} catch (err) {
  console.warn('⚠ 清理失败（不影响已拍好的配图）：', err.message)
}
