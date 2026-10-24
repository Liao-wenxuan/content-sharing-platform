/**
 * README 配图的回归防线
 *
 * 背景（都是实测出来的，不是设想的）：
 * 仓库里 33 张配图，**每一张**都落后于界面代码 —— 少的落后 39 次改动，
 * 多的落后 57 次。其中「我的商品」页是 2026-10-22 才加的功能，
 * **一张图都没有**；而 32 / 33 那两张设置页的图，仓库里**没有任何脚本产出它们**
 * （一次性 Playwright 会话手动存的），所以它们必然腐烂。
 *
 * 配图是 README 的第一屏 —— 招聘方打开仓库先看到的就是它。
 * 「界面改了但图没重拍」这种腐烂，靠人记是记不住的：
 * 单测守住逻辑、e2e 守住路径，但没人守「图和界面对不对得上」。
 *
 * 这个检查守三件事：
 *
 * 1. **过期**：manifest 里记着拍摄时的界面代码哈希，对不上就说明这批图过期了。
 * 2. **缺图**：README 引用的每一张图都得存在（少一张就是裂图）。
 * 3. **孤儿**：docs/screenshots/ 里每张图都得被 README 提到
 *    （正文里提到也算）—— 否则就是「拍了没人看的图」，它们会静静地腐烂。
 *
 * 接在 `npm run lint` 里，和工作流 schema 校验一个性质：
 * **改完先在本地验，再推**。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientSrcHash, SHOTS_DIR } from './lib/shot-common.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const README = path.join(ROOT, 'README.md')
const MANIFEST = path.join(SHOTS_DIR, 'manifest.json')

const problems = []
const notes = []

// ===== 1. 过期检测 =====
if (!existsSync(MANIFEST)) {
  problems.push(
    'docs/screenshots/manifest.json 不存在 —— 配图不是脚本产出的（或者被手删了）。\n' +
      '  跑一次 `npm run screenshot` 重建。'
  )
} else {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const current = clientSrcHash(ROOT)
  if (manifest.clientSrcHash !== current) {
    problems.push(
      'README 配图已过期：界面代码在配图拍完之后改过。\n' +
        `  拍摄于 ${manifest.capturedAt}\n` +
        `  拍摄时哈希 ${String(manifest.clientSrcHash).slice(0, 16)}… / 现在 ${current.slice(0, 16)}…\n` +
        '  跑 `npm run screenshot` 重拍（要先把后端 :3000 和前端 :5173 起起来）。'
    )
  } else {
    notes.push(`配图是最新的（拍摄于 ${manifest.capturedAt}）`)
  }

  // manifest 和磁盘必须对得上：删过图、或者手工加过图，manifest 都会失真
  const onDiskNow = existsSync(SHOTS_DIR)
    ? readdirSync(SHOTS_DIR).filter((f) => /\.(png|jpe?g)$/.test(f)).sort()
    : []
  const inManifest = (manifest.shots ?? []).map((s) => s.file).sort()
  const onlyOnDisk = onDiskNow.filter((f) => !inManifest.includes(f))
  const onlyInManifest = inManifest.filter((f) => !onDiskNow.includes(f))
  if (onlyOnDisk.length || onlyInManifest.length) {
    problems.push(
      'manifest 和磁盘上的图对不上：\n' +
        (onlyOnDisk.length ? `  只在磁盘上：${onlyOnDisk.join(', ')}\n` : '') +
        (onlyInManifest.length ? `  只在 manifest 里：${onlyInManifest.join(', ')}\n` : '') +
        '  跑 `npm run screenshot` 让它们重新对上。'
    )
  }
}

// ===== 2 + 3. 引用完整性和孤儿 =====
if (existsSync(README)) {
  const md = readFileSync(README, 'utf8')

  // 两套名字，用途不同：
  //
  // imageRefs —— 以**图片方式**引用的（markdown 图片语法，或带路径的）。
  //              这些必须在磁盘上存在，否则就是裂图。
  // mentions  —— 正文里提到的所有「看起来像文件名」的东西。
  //              用途是判断磁盘上的图是不是孤儿。
  //
  // 分成两套是因为正文里会出现**示例文件名**（比如压缩那张图旁边写着
  // 「左边 phone.jpg 是 7.4MB 压到 1.5MB」）——
  // 那是说明文字，不是图片引用，拿它去查磁盘必然误报。
  const imageRefs = new Set()
  const mentions = new Set()

  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    const name = path.basename(m[1])
    // 只有图片才算引用 —— 同一目录下还有 manifest.json，它不是图
    if (/\.(png|jpe?g)$/.test(name)) imageRefs.add(name)
  }
  for (const m of md.matchAll(/docs\/screenshots\/([\w.-]+\.(?:png|jpe?g))/g)) {
    imageRefs.add(m[1])
  }
  for (const m of md.matchAll(/[\w-]+\.(png|jpe?g)/g)) mentions.add(m[0])

  const onDisk = existsSync(SHOTS_DIR)
    ? readdirSync(SHOTS_DIR).filter((f) => /\.(png|jpe?g)$/.test(f))
    : []

  for (const f of onDisk) {
    if (!mentions.has(f)) {
      problems.push(
        `docs/screenshots/${f} 没有被 README 提到 —— 拍了没人看的图会静静腐烂。\n` +
          '  要么在 README 里给它找个位置，要么删掉。'
      )
    }
  }

  // README 里以图片方式引用的必须真的在
  for (const f of imageRefs) {
    if (!onDisk.includes(f)) {
      problems.push(`README 引用了 ${f}，但 docs/screenshots/ 里没有这张图（裂图）。`)
    }
  }

  notes.push(`README 引用 ${imageRefs.size} 张 / 磁盘上 ${onDisk.length} 张`)
}

if (problems.length) {
  console.error('README 配图检查未通过：\n')
  for (const p of problems) console.error('  ✗ ' + p)
  console.error('')
  process.exit(1)
}

console.log('✓ README 配图检查通过')
for (const n of notes) console.log('  ' + n)
