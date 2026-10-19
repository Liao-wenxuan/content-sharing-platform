/**
 * 首屏体积预算 —— 超标直接非零退出。
 *
 * 为什么要在体积上设门槛，而不只是查「写法」：
 * scripts/analyze-bundle.mjs 已经在构建前扫 element-plus 总桶导入了，
 * 那管的是**一种**退化路径。但体积变大有无数种原因：多引一个包、
 * 忘记加懒加载、某个组件从 chunk 里被挪进 entry。
 * 只有一条数字上的线，才能把「上次修好的东西悄悄涨回去」这件事变成一次红灯。
 *
 * 为什么只管 entry：
 * 首屏真正阻塞的是 entry chunk 的 JS 和 CSS。路由懒加载出来的那些 chunk
 * 不影响首屏（首页那块是刻意的静态 import，理由见 router/index.ts 的注释），
 * 而总 JS 体积会随着正常加功能增长，拿它当门槛只会逼着人把红线往后挪。
 *
 * 数值怎么定的：
 * 在当前实测值上留约 10% 的余量。余量太小会天天飘（不同 Node 版本、
 * 依赖小版本都会带来几十字节的抖动），太大就没有约束力。
 * 想收紧就直接改下面这张表 —— 它是一道线，不是一句口号。
 *
 * 前置条件：需要一份**生产构建**（minify 开启、不带 sourcemap）。
 * analyze-bundle.mjs 那次归因构建是关掉 minify 的，体积会大一倍，不能拿来比。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'client', 'dist')
const ASSETS = join(DIST, 'assets')

/** 单位 KiB（1024 字节）。Vite 输出用的是 kB（1000 字节），两者差 2.4%。 */
const KiB = 1024

const BUDGET = [
  // 名称,          实测值,  上限,   含义
  ['entry js gzip', 95.44, 105, '首屏 JS 的传输体积 —— 限速下最贵的那一项'],
  ['entry js raw', 275.14, 300, 'entry chunk 原始体积'],
  ['entry css gzip', 17.6, 21, '首屏 CSS 的传输体积'],
  ['entry css raw', 112.08, 125, '首屏 CSS 原始体积']
]

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ 找不到 client/dist/index.html')
  console.error('  先跑一次生产构建： cd client; npm run build')
  process.exit(1)
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const entryJs = html.match(/src="\/assets\/([^"]+\.js)"/)?.[1]
const entryCss = html.match(/href="\/assets\/([^"]+\.css)"/)?.[1]

if (!entryJs) {
  console.error('✗ index.html 里找不到 entry script 标签 —— 产物可能不是这个项目构建的')
  process.exit(1)
}

function measure(file) {
  const buf = readFileSync(join(ASSETS, file))
  return { raw: buf.length / KiB, gz: gzipSync(buf).length / KiB }
}

const actual = {
  'entry js': measure(entryJs),
  'entry css': entryCss ? measure(entryCss) : null
}

const chunkCount = readdirSync(ASSETS).filter((f) => f.endsWith('.js')).length

console.log(`entry: ${entryJs}${entryCss ? '  +  ' + entryCss : ''}   （共 ${chunkCount} 个 js chunk）\n`)
console.log('项目'.padEnd(16) + '实测 KiB'.padStart(10) + '预算 KiB'.padStart(11) + '用量'.padStart(9) + '  说明')
console.log('-'.repeat(96))

let over = 0
for (const [name, baseline, limit, note] of BUDGET) {
  const which = name.startsWith('entry js') ? actual['entry js'] : actual['entry css']
  if (!which) {
    console.log(`${name.padEnd(16)}  没有 entry css，跳过`)
    continue
  }
  const value = name.endsWith('gzip') ? which.gz : which.raw
  const pct = (value / limit) * 100
  const bad = value > limit
  if (bad) over++
  const bar = '#'.repeat(Math.max(1, Math.round(pct / 5)))
  console.log(
    `${name.padEnd(16)}${value.toFixed(2).padStart(10)}${String(limit).padStart(11)}${(pct.toFixed(0) + '%').padStart(9)}  ${bar}${bad ? ' ✗ 超标' : ''}`
  )
  if (note) console.log(`${' '.repeat(46)}${note}`)
}

console.log('')
if (over) {
  console.log(`✗ ${over} 项超出预算。`)
  console.log('  先量再改：npm run perf:bundle -- --why <包名>  看它是被谁拉进来的。')
  console.log('  确认是想要的改动就把上面的 BUDGET 调高，并在 commit 里写清为什么。')
  process.exit(1)
}
console.log('✓ 全部在预算内')
