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
import fsSync from 'node:fs'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client')
const DIST = path.join(CLIENT, 'dist')
const ASSETS = path.join(DIST, 'assets')
const GRAPH_OUT = path.join(ROOT, 'node_modules/.cache/sg-module-graph.json')

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

/**
 * 总桶守卫：src 里不允许再出现 `from 'element-plus'`。
 *
 * 背景：`element-plus/es/index.mjs` re-export 了全部 98 个组件。
 * 模板里的组件由 vite.config.ts 的深路径 resolver 解决，但 ElMessage 这类
 * 在 script 里调用的组件 resolver 扫不到，只能手写 —— 手写时很容易图省事
 * 写成 `import { ElMessage } from 'element-plus'`，于是整个库进首屏。
 *
 * 为什么值得单独查：体积归因只会告诉你「element-plus 有 XXX KB 在首屏」，
 * 不会告诉你是哪一行把它拉进来的。这条检查直接把行号摆出来。
 *
 * 注释里的 'element-plus' 不算 —— 文档正是在解释为什么不能这么写。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function findBarrelImports() {
  const hits = []
  const walk = (dir) => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|ts)$/.test(entry.name)) {
        const src = stripComments(fsSync.readFileSync(full, 'utf8'))
        src.split('\n').forEach((line, i) => {
          if (/from\s+['"]element-plus['"]/.test(line)) {
            hits.push(`${path.relative(ROOT, full).replace(/\\/g, '/')}:${i + 1}  ${line.trim()}`)
          }
        })
      }
    }
  }
  walk(path.join(CLIENT, 'src'))
  return hits
}

async function main() {
  // 先查总桶再构建：这类问题不需要等 6 秒的构建就能确认
  const barrels = findBarrelImports()
  if (barrels.length) {
    console.log('✗ 检测到 element-plus 总桶导入（会把全部 98 个组件拉进依赖图）：')
    for (const h of barrels) console.log(`    ${h}`)
    console.log('\n  改成深路径：client/src/utils/element.ts 已经集中了 ElMessage /')
    console.log('  ElMessageBox / UploadFile 的深路径导出，从那里 import 即可。')
    process.exit(1)
  }
  console.log('✓ 没有 element-plus 总桶导入')

  const why = process.argv.includes('--why') ? process.argv[process.argv.indexOf('--why') + 1] : null

  console.log('带 sourcemap 构建中…（产物会覆盖 client/dist，末尾提示如何恢复）')

  // 直接跑 vite 的 bin，不经 npm：Windows 上 spawnSync('npm.cmd') 的退出码
  // 经常不是构建的真实结果（npm 自己的退出语义和 vite 的不一致），
  // 一旦误判成失败，看到的就是「构建挂了」这种毫无线索的假故障。
  const result = spawnSync(process.execPath, [path.join(CLIENT, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: CLIENT,
    stdio: 'inherit',
    env: {
      ...process.env,
      SG_SOURCEMAP: '1',
      VITE_MINIFY: '0',
      ...(why ? { SG_DUMP_GRAPH: '1', SG_GRAPH_OUT: GRAPH_OUT } : {})
    }
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
  const detailPrefix = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (detailPrefix) printDetail(attribution, detailPrefix, 12)

  if (why) printWhy(why)

  console.log('\n提示：本次构建未 minify 且带 sourcemap，用来跑 dev 会很慢。')
  console.log('恢复生产构建： cd client; npm run build')
}

/**
 * 「这个包为什么会进首屏」——体积归因只回答「有多少」，不回答「谁拉的」。
 *
 * 做法：构建时顺带导出 Rollup 的模块导入图，从入口 main.ts 做 BFS，
 * 打印到目标包的最短依赖链。两条相邻的路径差别巨大：
 *   app 自己的文件  →  我们能改
 *   第三方内部依赖  →  改不了，只能接受
 * 只看数字的话很容易把时间花在改不动的地方上。
 */
function printWhy(target) {
  const norm = (p) => p.replace(/\\/g, '/')
  const short = (p) =>
    p
      .replace(/^.*content-sharing-platform[\\/]client[\\/]/, '')
      .replace(/^.*node_modules[\\/]/, '~/')

  const edges = JSON.parse(fsSync.readFileSync(GRAPH_OUT, 'utf8'))
  const adj = new Map()
  for (const [a, b] of edges) {
    const A = norm(a)
    if (!adj.has(A)) adj.set(A, [])
    adj.get(A).push(norm(b))
  }

  const entry = [...adj.keys()].find((k) => k.endsWith('client/src/main.ts'))
  if (!entry) throw new Error('模块图里找不到入口 main.ts')

  const prev = new Map([[entry, null]])
  let frontier = [entry]
  for (let d = 0; d < 16 && frontier.length; d++) {
    const next = []
    for (const cur of frontier) {
      for (const n of adj.get(cur) || []) {
        if (prev.has(n)) continue
        prev.set(n, cur)
        next.push(n)
      }
    }
    frontier = next
  }

  const hit = [...prev.keys()].find((k) => k.includes(target))
  console.log(`\n=== 为什么 ${target} 会在首屏依赖图里 ===`)
  if (!hit) {
    console.log('  不在首屏依赖图中 —— 已经摇掉了')
    return
  }
  const chain = []
  for (let p = hit; p; p = prev.get(p)) chain.unshift(short(p))
  chain.forEach((n, i) => console.log('  ' + '  '.repeat(i) + (i === chain.length - 1 ? '-> ' : '   ') + n))

  const editable = chain.filter((n) => !n.startsWith('~/'))
  console.log(
    editable.length
      ? `\n  其中 ${editable.length} 段是我们自己的代码，改得动；其余是第三方内部依赖。`
      : '\n  整条链都在第三方内部 —— 改不动，只能接受。'
  )
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
