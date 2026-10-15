/**
 * 首屏性能基线
 *
 * 为什么要有这个脚本：
 * 「entry chunk 有 400KB」和「用户首屏要下 400KB」是两件事。
 * 路由是懒加载的，首屏真正下载的应该是 entry + 首页那几个 chunk，
 * 而不是整个 dist。measure「一个文件多大」很容易，
 * 难的是证明「浏览器在首屏那一刻到底请求了什么」。
 *
 * 为什么必须跑生产构建：
 * dev server 下每个源文件都是一个独立模块，还会带上 HMR client 和源码映射，
 * 在 dev 上量出来的数字对真实用户毫无意义（通常大一个数量级）。
 *
 * 为什么限速：
 * 不限速时几十 MB 的 localhost 往返会把所有等待都压成个位数毫秒，
 * LCP 变成「测量噪声」。限到 Slow 4G 之后，字节量差异才会真实反映成时间差异 ——
 * 这正是「少下 10KB」在弱网下有没有意义的唯一判据。
 *
 * 输出三组数：
 *   1. 首屏关键指标（FCP / LCP / CLS / TTFB）
 *   2. 首屏实际下载的 chunk 清单（按字节排序）
 *   3. 首屏 JS 字节 vs 全站 JS 字节 —— 后者证明懒加载真的在起作用
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client')
const PREVIEW_PORT = 4173
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`

// Slow 4G：Chrome DevTools 的经典档位。
// 选它而不是 3G，是因为 3G 下图片下载会淹没 JS 的差异，
// 而我们要回答的恰恰是「代码体积对首屏的影响」。
const THROTTLE = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1)
}

/** 等 preview 端口真的在监听，而不是盲等固定秒数 */
async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.ok || res.status === 404) return true
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`preview server 30s 内没起来：${url}`)
}

async function measure() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  // ⚠️ 必须在开跑之前验后端是通的。
  //
  // 曾经踩过：后端进程挂了，首页渲染成空态，脚本照样跑完，
  // 输出一堆漂亮的数字：LCP 1876ms、图片 0.0KB。
  // 那组数字读起来像「优化到极致」，实际上一张图都没加载 ——
  // **测错对象比测不出来危险得多**，因为它会让人把性能问题「优化」没了。
  try {
    const health = await fetch('http://localhost:3000/api/health', { signal: AbortSignal.timeout(5000) })
    if (!health.ok) throw new Error(`status ${health.status}`)
  } catch (e) {
    throw new Error(
      `后端没起来（http://localhost:3000/api/health → ${e.message}）。\n` +
        '  perf 跑的是生产构建 + 真实后端，两者缺一测出来的数字都是假的。\n' +
        '  先在另一个窗口跑： cd server; npx tsx watch src/index.ts'
    )
  }

  const client = await context.newCDPSession(page)
  await client.send('Network.enable')
  await client.send('Network.emulateNetworkConditions', THROTTLE)

  // LCP 必须在页面脚本之前就开始观察，否则会漏掉首屏最早的那批候选。
  //
  // 为什么不直接用 performance.getEntriesByType('largest-contentful-paint')：
  // 那条路在 Chromium 上会返回空数组 —— 页面明明渲染了（#app 有内容），
  // 却一个 LCP 条目都读不到，于是脚本误报「首屏白屏」。
  // PerformanceObserver + buffered:true 是 web-vitals 自己的做法，
  // 它会把 observer 注册之前就已经发生的条目一并回放。
  await page.addInitScript(() => {
    window.__lcp = 0
    window.__cls = 0
    window.__clsEntries = 0
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1]
        window.__lcp = last.startTime
        // LCP 元素是谁，比 LCP 是多少更有诊断价值：
        // 元素是 <img> 说明还在等图片，是文本块说明图片没成为最大元素
        window.__lcpElement = last.element
          ? `${last.element.tagName}${last.element.className ? '.' + String(last.element.className).split(' ')[0] : ''}`
          : 'unknown'
        window.__lcpUrl = last.url || null
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    } catch (error) {
      window.__lcpError = String(error)
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue
          window.__cls += entry.value
          window.__clsEntries += 1
        }
      }).observe({ type: 'layout-shift', buffered: true })
    } catch (error) {
      window.__clsError = String(error)
    }
  })

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' })

  // 等 LCP 稳定：浏览器会在最后一个候选元素出现后 finalize LCP。
  // 这里不能等 networkidle —— 站内常驻 WebSocket，网络永不空闲，
  // 那会让脚本零输出卡死（这条已经踩过一次）。
  //
  // waitForFunction 的第二个形参是「传给函数的 arg」，不是 options。
  // 把 { timeout } 写在那里不会报错，只会被当成 arg 传给页面函数，
  // 于是超时静默退回默认 30s —— 症状是「明明给了 60s 却报 30s 超时」。
  const hasLcp = await page
    .waitForFunction(() => window.__lcp > 0, null, { timeout: 60000 })
    .then(() => true)
    .catch(() => false)

  if (!hasLcp) {
    // 没有 LCP 几乎只有两种原因：接口全失败导致空页，或者页面控制台报错白屏。
    // 这两种都不该让脚本默默给出「优化后 0ms」。
    const dom = await page.evaluate(() => ({
      html: document.querySelector('#app')?.innerHTML.length ?? -1,
      lcpError: window.__lcpError ?? null,
      images: document.images.length,
      bodyText: document.body.innerText.slice(0, 120)
    }))
    throw new Error(
      '等不到 LCP 元素。\n' +
        `  #app 内容长度: ${dom.html}\n` +
        `  页面 <img> 数量: ${dom.images}\n` +
        `  首屏文本: ${dom.bodyText.replace(/\s+/g, ' ')}\n` +
        `  observer 错误: ${dom.lcpError ?? '无'}\n` +
        '  先确认 3000 端口的 Express 在跑（preview 不代理 /api），再重试。'
    )
  }

  // LCP 出现后还需要一点时间让最后一个候选落地
  await page.waitForTimeout(1500)

  // 首屏真的得有图，否则下面所有数字都没意义
  const viewportImageCount = await page.evaluate(
    () =>
      [...document.images].filter((img) => {
        const rect = img.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < window.innerHeight
      }).length
  )
  if (viewportImageCount === 0) {
    throw new Error(
      '视口内一张图都没有 —— 后端多半没起或首页是空态。\n' +
        '  这种情况下「图片 0KB」不是优化成果，是压根没加载。'
    )
  }

  // ⚠️ 只等 LCP 是不够的，而且会得出严重误导的结论。
  //
  // 站内所有 <img> 都是 loading="lazy"，而 LCP 会在文本块先渲染出来时就定稿，
  // 于是「LCP 时刻之前」一个图片请求都没有 —— 首屏图片看起来是 0KB。
  // 可真实用户是盯着图片流看的，那才是主要感知成本。
  //
  // 所以第二步要等「进入视口的图片真的画完了」：
  // 文本 LCP 是「骨架可见」，图片加载完才是「内容可用」，
  // 两者之间的时间差才是这块页面真正的加载成本。
  const imagesSettled = await page
    .waitForFunction(
      () => {
        const inViewport = [...document.images].filter((img) => {
          const rect = img.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        })
        if (!inViewport.length) return false
        return inViewport.every((img) => img.complete && img.naturalWidth > 0)
      },
      null,
      { timeout: 45000 }
    )
    .then(() => true)
    .catch(() => false)

  if (!imagesSettled) {
    const pending = await page.evaluate(
      () =>
        [...document.images].filter((img) => !img.complete).map((img) => img.currentSrc || img.src).slice(0, 3)
    )
    console.log(`\n⚠️ 视口内图片 45s 内没加载完（可能有 ${pending.length} 张卡住）：`)
    for (const src of pending) console.log(`   ${src}`)
    console.log('   继续输出已拿到的数字，但「首屏可用」这一项不完整。')
  }

  // 图片落地会刷新 LCP 候选，这里再采一次最终值
  await page.waitForTimeout(500)

  // 「视口内图片就绪」的时刻：从 resource timing 里取最后一张视口图的 responseEnd。
  // 不去猜固定等待时长 —— 限速下等久了会高估，等少了会漏掉还在飞的请求。
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]))

    const all = performance.getEntriesByType('resource')
    const viewportImages = [...document.images]
      .filter((img) => {
        const rect = img.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < window.innerHeight && img.currentSrc
      })
      .map((img) => img.currentSrc)

    const lastViewportImageEnd = all
      .filter((r) => viewportImages.includes(r.name))
      .reduce((max, r) => Math.max(max, r.responseEnd), 0)

    const resources = all.map((r) => ({
      name: r.name,
      kind: r.initiatorType,
      // transferSize 含协议头；encodedBodySize 是压缩后的真实字节
      bytes: r.transferSize || r.encodedBodySize || 0,
      encoded: r.encodedBodySize || 0,
      start: r.startTime,
      end: r.responseEnd
    }))

    return {
      fcp: paints['first-contentful-paint'] ?? 0,
      lcp: window.__lcp ?? 0,
      lcpElement: window.__lcpElement ?? 'unknown',
      lcpUrl: window.__lcpUrl ?? null,
      cls: window.__cls ?? 0,
      clsEntries: window.__clsEntries ?? 0,
      ttfb: nav?.responseStart ?? 0,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? 0,
      domInteractive: nav?.domInteractive ?? 0,
      viewportImageCount: viewportImages.length,
      // 有多少图真的设成了 eager/fetchpriority=high。
      // 「我以为改了」和「它真的生效了」是两回事 ——
      // 属性写错、computed 没重算、SSR 初始态没带上，都会让它静默退回 lazy。
      loadingBreakdown: (() => {
        const counts = {}
        for (const img of document.querySelectorAll('img.sg-img')) {
          const key = `${img.getAttribute('loading') || '(none)'}/${img.getAttribute('fetchpriority') || '(none)'}`
          counts[key] = (counts[key] ?? 0) + 1
        }
        return counts
      })(),
      // 没有视口图时退回「文本就绪」，否则 cutoff 会是 0，把所有资源都算进首屏
      imagesReadyAt: lastViewportImageEnd || window.__lcp || 0,
      resources
    }
  })

  await browser.close()
  return metrics
}

function report(metrics, distBytes) {
  const { resources } = metrics
  // 「首屏」用「视口内图片加载完」的时刻来切，而不是 LCP：
  // LCP 只证明内容开始可见，图片落地才是这块页面真正可用的时刻。
  const cutoff = metrics.imagesReadyAt
  const beforeLcp = resources.filter((r) => r.end <= cutoff)
  const sum = (list, kind) => list.filter((r) => (kind ? r.kind === kind : true)).reduce((a, b) => a + b.bytes, 0)

  const firstScreenJs = sum(beforeLcp, 'script')
  const firstScreenCss = sum(beforeLcp, 'stylesheet')
  const firstScreenImg = sum(beforeLcp, 'img')
  const firstScreenAll = sum(beforeLcp)

  console.log('\n=== 首屏关键指标（Slow 4G：1.6Mbps / 150ms RTT）===')
  console.log(`  TTFB            ${metrics.ttfb.toFixed(0).padStart(6)} ms`)
  console.log(`  FCP             ${metrics.fcp.toFixed(0).padStart(6)} ms`)
  console.log(`  LCP             ${metrics.lcp.toFixed(0).padStart(6)} ms   ${metrics.lcpElement}`)
  if (metrics.lcpUrl) console.log(`  └ LCP 图片      ${metrics.lcpUrl.split('/').pop()}`)
  console.log(`  CLS             ${metrics.cls.toFixed(4).padStart(6)}      ${metrics.cls < 0.1 ? '✓ 达标 (<0.1)' : '✗ 超标'}  (${metrics.clsEntries} 次位移)`)
  console.log(`  视口图片就绪    ${metrics.imagesReadyAt.toFixed(0).padStart(6)} ms   (视口内 ${metrics.viewportImageCount} 张)`)
  const eager = Object.entries(metrics.loadingBreakdown ?? {})
    .filter(([k]) => k.startsWith('eager'))
    .reduce((sum, [, v]) => sum + v, 0)
  const lazy = Object.entries(metrics.loadingBreakdown ?? {})
    .filter(([k]) => k.startsWith('lazy'))
    .reduce((sum, [, v]) => sum + v, 0)
  console.log(`  加载策略        eager ${eager} / lazy ${lazy}`)
  console.log(
    `  └ 文本可见后还要再等 ${(metrics.imagesReadyAt - metrics.lcp).toFixed(0).padStart(5)} ms 才看到图`
  )
  console.log(`  DOMContentLoaded ${metrics.domContentLoaded.toFixed(0).padStart(4)} ms`)

  console.log('\n=== 首屏下载构成（到「视口图片就绪」为止）===')
  console.log(`  JS      ${kb(firstScreenJs).padStart(8)} KB   ${beforeLcp.filter((r) => r.kind === 'script').length} 个请求`)
  console.log(`  CSS     ${kb(firstScreenCss).padStart(8)} KB   ${beforeLcp.filter((r) => r.kind === 'stylesheet').length} 个请求`)
  console.log(`  图片    ${kb(firstScreenImg).padStart(8)} KB   ${beforeLcp.filter((r) => r.kind === 'img').length} 个请求`)
  console.log(`  合计    ${kb(firstScreenAll).padStart(8)} KB   ${beforeLcp.length} 个请求`)

  // LCP 图片什么时候**下完**的？和 LCP 记录的时刻差多少。
  //
  // 这个差值是本脚本最有诊断价值的一行：
  // - 差值 ≈ 0 → LCP 就是传输耗时，该去减字节
  // - 差值很大 → 图早下完了，LCP 卡在**渲染**（动画 / 布局 / 主线程），
  //   这时候再去优化字节是白费力气
  const lcpResource = resources.find((r) => r.name === metrics.lcpUrl)
  if (lcpResource) {
    const gap = metrics.lcp - lcpResource.end
    console.log(`\n  LCP 图片传输完成于 ${lcpResource.end.toFixed(0)} ms，而 LCP 记在 ${metrics.lcp.toFixed(0)} ms`)
    console.log(
      gap < 120
        ? `  └ 两者几乎同时 → LCP 由传输决定，继续减字节`
        : `  └ 中间空转了 ${gap.toFixed(0)} ms → **瓶颈在渲染/调度，不在传输**`
    )
  }

  const totalJs = distBytes.js
  console.log(`\n  全站 JS  ${kb(totalJs).padStart(8)} KB`)
  console.log(`  首屏 JS   ${kb(firstScreenJs).padStart(8)} KB   占比 ${((firstScreenJs / totalJs) * 100).toFixed(0)}%`)
  console.log(
    `  → 懒加载省下 ${kb(totalJs - firstScreenJs).padStart(8)} KB（${((1 - firstScreenJs / totalJs) * 100).toFixed(0)}% 的 JS 根本没进首屏）`
  )

  console.log('\n=== 首屏请求明细（按字节降序）===')
  for (const r of beforeLcp.sort((a, b) => b.bytes - a.bytes).slice(0, 14)) {
    const file = r.name.split('/').pop()
    console.log(`  ${kb(r.bytes).padStart(8)} KB  ${r.kind.padEnd(10)} ${file}`)
  }

  // SPA 特有的一段串行：图片 URL 只有接口返回才知道，
  // 所以「接口什么时候回来」直接决定「图片什么时候能开始下」。
  // 不看这一段，很容易把接口耗时误判成图片传输慢。
  const api = resources
    .filter((r) => r.kind === 'fetch' || r.kind === 'xmlhttprequest')
    .sort((a, b) => a.start - b.start)
  if (api.length) {
    console.log('\n=== 接口请求（限速下，含 RTT）===')
    for (const r of api.slice(0, 6)) {
      const file = r.name.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      console.log(
        `  ${file.padEnd(28)} 发起 ${r.start.toFixed(0).padStart(5)}ms → 完成 ${r.end.toFixed(0).padStart(5)}ms  (${(r.end - r.start).toFixed(0)}ms)`
      )
    }
    const firstApiEnd = api[0].end
    const firstImgStart = Math.min(...beforeLcp.filter((r) => r.kind === 'img').map((r) => r.start))
    if (Number.isFinite(firstImgStart)) {
      console.log(
        `  → 首个接口 ${firstApiEnd.toFixed(0)}ms 完成，首张图 ${firstImgStart.toFixed(0)}ms 才发起，中间 ${(firstImgStart - firstApiEnd).toFixed(0)}ms`
      )
    }
  }
}

async function distTotals() {
  const assets = path.join(CLIENT, 'dist', 'assets')
  const files = await fs.readdir(assets)
  let js = 0
  let css = 0
  for (const file of files) {
    if (file.endsWith('.map')) continue
    const { size } = await fs.stat(path.join(assets, file))
    if (file.endsWith('.js')) js += size
    else if (file.endsWith('.css')) css += size
  }
  return { js, css }
}

async function main() {
  console.log('生产构建中…')
  const build = spawnSync(process.execPath, [path.join(CLIENT, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: CLIENT,
    // 平时静默：vite 会把 60 行产物清单刷出来，把真正的性能数字埋在下面。
    // 只有失败时才把构建日志倒出来 —— 失败时你需要的正是那 60 行。
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, SG_SOURCEMAP: '0', VITE_MINIFY: '1' }
  })
  if (build.status !== 0) {
    console.error(build.stdout ?? '')
    console.error(build.stderr ?? '')
    throw new Error(`构建失败（退出码 ${build.status}）`)
  }

  const preview = spawn(
    process.execPath,
    [path.join(CLIENT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: CLIENT, stdio: 'ignore' }
  )

  try {
    await waitForServer(PREVIEW_URL)
    const metrics = await measure()
    report(metrics, await distTotals())
    console.log('\n提示：preview 只服务静态产物，/api 与 /uploads 仍由 3000 端口的 Express 提供。')
  } finally {
    preview.kill()
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
