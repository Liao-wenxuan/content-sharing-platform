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
        window.__lcp = entries[entries.length - 1].startTime
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
      bodyText: document.body.innerText.slice(0, 120)
    }))
    throw new Error(
      '等不到 LCP 元素。\n' +
        `  #app 内容长度: ${dom.html}\n` +
        `  首屏文本: ${dom.bodyText.replace(/\s+/g, ' ')}\n` +
        `  observer 错误: ${dom.lcpError ?? '无'}\n` +
        '  先确认 3000 端口的 Express 在跑（preview 不代理 /api），再重试。'
    )
  }

  // LCP 出现后还需要一点时间让最后一个候选落地
  await page.waitForTimeout(1500)

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
      cls: window.__cls ?? 0,
      clsEntries: window.__clsEntries ?? 0,
      ttfb: nav?.responseStart ?? 0,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? 0,
      domInteractive: nav?.domInteractive ?? 0,
      viewportImageCount: viewportImages.length,
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
  console.log(`  LCP             ${metrics.lcp.toFixed(0).padStart(6)} ms`)
  console.log(`  CLS             ${metrics.cls.toFixed(4).padStart(6)}      ${metrics.cls < 0.1 ? '✓ 达标 (<0.1)' : '✗ 超标'}  (${metrics.clsEntries} 次位移)`)
  console.log(`  视口图片就绪    ${metrics.imagesReadyAt.toFixed(0).padStart(6)} ms   (视口内 ${metrics.viewportImageCount} 张)`)
  console.log(
    `  └ 文本可见后还要再等 ${(metrics.imagesReadyAt - metrics.lcp).toFixed(0).padStart(5)} ms 才看到图`
  )
  console.log(`  DOMContentLoaded ${metrics.domContentLoaded.toFixed(0).padStart(4)} ms`)

  console.log('\n=== 首屏下载构成（到「视口图片就绪」为止）===')
  console.log(`  JS      ${kb(firstScreenJs).padStart(8)} KB   ${beforeLcp.filter((r) => r.kind === 'script').length} 个请求`)
  console.log(`  CSS     ${kb(firstScreenCss).padStart(8)} KB   ${beforeLcp.filter((r) => r.kind === 'stylesheet').length} 个请求`)
  console.log(`  图片    ${kb(firstScreenImg).padStart(8)} KB   ${beforeLcp.filter((r) => r.kind === 'img').length} 个请求`)
  console.log(`  合计    ${kb(firstScreenAll).padStart(8)} KB   ${beforeLcp.length} 个请求`)

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
