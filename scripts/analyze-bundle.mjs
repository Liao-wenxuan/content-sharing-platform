/**
 * bundle 归因：entry chunk 的 400KB 到底花在哪
 *
 * 为什么要有这个脚本：
 * 「主包太大」是一句没有行动指向的话。Vue 全家桶天然就在里面，
 * 业务代码可能只占 5%，那再优化业务代码也是白费力气。
 * 想知道该动哪里，必须先把字节数按来源文件拆开。
 *
 * 为什么不装 rollup-plugin-visualizer：
 * 那是可视化 UI，截图看个饼图，然后你还是得回来敲命令拿数字。
 * 这里只需要几行输出：最大的几个来源 + 它们各自多少 KB。
 *
 * 怎么算的：
 * 1. 带 SG_SOURCEMAP=1 跑一次生产构建（sourcemap 由 vite.config.ts 认这个开关）
 * 2. 读 entry chunk 的 .map，把 sourcemap 的 VLQ mappings 逐列还原成
 *    「生成的这一列来自哪个源文件」，按源文件累加字节数
 *
 * 这是近似值 —— sourcemap 只记录 segment 边界，segment 之间的列
 * 归属于该 segment 起始的源文件 —— 但对「谁最肥」这个判断足够精确。
 *
 * 注意：构建时关掉了 minify（VITE_MINIFY=0），因为 minify 会重排代码，
 * 让「这段字节属于谁」的归因更接近直觉。我们要的是构成，不是最小化后的体积。
 * 最终体积对照请看 scripts/perf-smoke.mjs，它跑的是带 minify 的真产物。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client')
const DIST = path.join(CLIENT, 'dist')
const ASSETS = path.join(DIST, 'assets')

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const VLQ_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(128).fill(255)
  for (let i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i
  return table
})()

/** 解一个 VLQ segment，返回它编码的数字数组 */
function decodeSegment(segment) {
  const out = []
  let i = 0
  while (i < segment.length) {
    let result = 0
    let shift = 0
    let hasContinuation = true
    while (hasContinuation && i < segment.length) {
      const digit = VLQ_LOOKUP[segment.charCodeAt(i++)] ?? 0
      hasContinuation = (digit & 32) !== 0
      result += (digit & 31) << shift
      shift += 5
    }
    const isNegative = result & 1
    result >>>= 1
    out.push(isNegative ? -result : result)
  }
  return out
}

/** 按「文件归属」分组的粗粒度标签：报告里要能一眼看出是哪一层 */
function bucket(source) {
  const s = source.replace(/\\/g, '/')
  if (s.includes('node_modules/vue/') || s.includes('node_modules/@vue/')) return 'vue'
  if (s.includes('node_modules/vue-router/')) return 'vue-router'
  if (s.includes('node_modules/pinia')) return 'pinia'
  if (s.includes('node_modules/element-plus/') || s.includes('node_modules/@element-plus/'))
    return 'element-plus'
  if (s.includes('node_modules/axios/')) return 'axios'
  if (s.includes('node_modules/dayjs/')) return 'dayjs'
  if (s.includes('node_modules/')) return '其他依赖'
  if (s.includes('/src/assets/styles/')) return '全局样式'
  if (s.includes('/src/api/')) return 'api 层'
  if (s.includes('/src/stores/')) return 'pinia store'
  if (s.includes('/src/composables/')) return 'composable'
  if (s.includes('/src/utils/')) return 'utils'
  if (s.includes('/src/components/')) return '自研组件'
  if (s.includes('/src/views/')) return '页面'
  if (s.includes('/src/')) return '其他 src'
  return '虚拟模块/入口'
}

/**
 * 把 sourcemap 还原成每个源文件的字节贡献
 * @returns Map<source, bytes>
 */
function attributeBySource(code, map) {
  const sources = map.sources
  const bytes = new Array(sources.length).fill(0)
  const codeLines = code.split('\n')
  const mapLines = map.mappings.split(';')

  // sourceIndex 是跨行累计的（不是每行重置），必须单独维护。
  // 这是最容易写错的一处：每行都置 0 的话，第二行起的归因会全错，
  // 而且不会报错 —— 只是数字变得毫无意义。
  let sourceIndex = 0

  for (let lineNo = 0; lineNo < mapLines.length; lineNo++) {
    const rawLine = mapLines[lineNo]
    if (!rawLine) continue
    const codeLineLength = (codeLines[lineNo] ?? '').length + 1
    const segments = rawLine.split(',').filter(Boolean)
    if (!segments.length) continue

    const columns = []
    let generatedColumn = 0
    for (const segment of segments) {
      const fields = decodeSegment(segment)
      generatedColumn += fields[0] ?? 0
      sourceIndex += fields.length > 1 ? fields[1] : 0
      columns.push({ start: generatedColumn, sourceIndex })
    }

    // 每段的归属区间是 [start, 下一个 start)；最后一段吃到行尾
    for (let i = 0; i < columns.length; i++) {
      const end = i + 1 < columns.length ? columns[i + 1].start : codeLineLength
      const width = end - columns[i].start
      if (width <= 0) continue
      const target = columns[i].sourceIndex
      // sourceIndex 为 -1 表示这段没有对应源文件（模块胶水、helpers）
      if (target >= 0 && target < bytes.length) bytes[target] += width
    }
  }

  const result = new Map()
  sources.forEach((source, i) => {
    if (bytes[i] > 0) result.set(source, bytes[i])
  })
  return result
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1)
}

/**
 * 打印某个前缀下最大的若干源文件。
 * 用它回答「element-plus 那 311KB 具体是哪几个组件」这类追问，
 * 否则分组只有一层，再往下就只能靠猜。
 */
function printDetail(attribution, prefix, limit) {
  const matched = [...attribution.entries()]
    .filter(([source]) => source.replace(/\\/g, '/').includes(prefix))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
  if (!matched.length) {
    console.log(`\n（没有 ${prefix} 下的文件）`)
    return
  }
  const total = matched.reduce((a, [, b]) => a + b, 0)
  console.log(`\n${prefix} 下最大的 ${matched.length} 个文件（合计 ${kb(total)}KB）：`)
  for (const [source, bytes] of matched) {
    const short = source.replace(/\\/g, '/').replace(/^.*node_modules\//, '~/')
    console.log(`  ${kb(bytes).padStart(7)}KB  ${short}`)
  }
}

async function main() {
  console.log('带 sourcemap 构建中…（产物会覆盖 client/dist，末尾提示如何恢复）')

  // 直接跑 vite 的 bin，不经 npm：Windows 上 spawnSync('npm.cmd') 的退出码
  // 经常不是构建的真实结果（npm 自己的退出语义和 vite 的不一致），
  // 一旦误判成失败，看到的就是「构建挂了」这种毫无线索的假故障。
  const result = spawnSync(process.execPath, [path.join(CLIENT, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: CLIENT,
    stdio: 'inherit',
    env: { ...process.env, SG_SOURCEMAP: '1', VITE_MINIFY: '0' }
  })
  if (result.status !== 0) {
    throw new Error(
      `构建失败（退出码 ${result.status}${result.signal ? ' / ' + result.signal : ''}），先修构建再谈归因`
    )
  }

  const html = await fs.readFile(path.join(DIST, 'index.html'), 'utf8')
  const entryMatch = html.match(/src="\/assets\/([^"]+\.js)"/)
  if (!entryMatch) throw new Error('index.html 里找不到 entry script 标签')
  const entryName = entryMatch[1]

  const entryPath = path.join(ASSETS, entryName)
  const code = await fs.readFile(entryPath, 'utf8')

  let map
  try {
    map = JSON.parse(await fs.readFile(entryPath + '.map', 'utf8'))
  } catch {
    throw new Error(
      `没有找到 ${entryName}.map。\n` +
        '说明 SG_SOURCEMAP=1 没生效 —— 检查 client/vite.config.ts 的 build.sourcemap。'
    )
  }

  const attribution = attributeBySource(code, map)

  const buckets = new Map()
  for (const [source, bytes] of attribution) {
    const key = bucket(source)
    buckets.set(key, (buckets.get(key) ?? 0) + bytes)
  }
  const attributed = [...attribution.values()].reduce((a, b) => a + b, 0)

  console.log(`\nentry: ${entryName}`)
  console.log(`未压缩 ${kb(code.length)}KB（可归因 ${kb(attributed)}KB / ${((attributed / code.length) * 100).toFixed(0)}%）`)

  console.log('\n按来源分组：')
  const rows = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  const max = rows[0]?.[1] ?? 1
  for (const [name, bytes] of rows) {
    const bar = '#'.repeat(Math.max(1, Math.round((bytes / max) * 30)))
    console.log(`  ${name.padEnd(14)} ${kb(bytes).padStart(7)}KB  ${bar}`)
  }

  console.log('\n最大的 8 个源文件：')
  const topFiles = [...attribution.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  for (const [source, bytes] of topFiles) {
    const short = source.replace(/\\/g, '/').replace(/^.*node_modules\//, '~/')
    console.log(`  ${kb(bytes).padStart(7)}KB  ${short}`)
  }

  // 想看某个包内部到底是谁最肥：node scripts/analyze-bundle.mjs element-plus
  const detailPrefix = process.argv[2]
  if (detailPrefix) printDetail(attribution, detailPrefix, 12)

  console.log('\n提示：本次构建未 minify 且带 sourcemap，用来跑 dev 会很慢。')
  console.log('恢复生产构建： cd client; npm run build')
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
