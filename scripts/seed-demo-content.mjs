#!/usr/bin/env node
/**
 * 给演示站种入高质量原创笔记（45 条）。
 *
 * 为什么不爬小红书、为什么自己写：见 scripts/lib/demo-posts.mjs 顶部说明。
 * 简而言之：反爬要绕技术保护措施（合规风险），搬运内容有版权（求职减分），
 * 而演示站真正缺的是「点进去有东西读」的正文，不是热闹的标题。
 *
 * 设计要点：
 *   1. 幂等：先拉每个账号已发的全部帖子，按正文首行（标题）去重；
 *      重复运行只会补发缺失的，不会灌水。
 *   2. 限流：写接口 20 次/分钟（按 IP），默认每条间隔 3.2 秒；
 *      撞到 429 时按 Retry-After 等待后重试，不硬闯。
 *   3. 图文对应：图片来自 server/uploads/demo/ 的 Unsplash 公开图，
 *      主题映射见联络表，发布前校验文件存在。
 *   4. 视频帖走 mediaType=video，指向已有的 demo.mp4。
 *
 * 用法：
 *   node scripts/seed-demo-content.mjs --dry-run     # 预览，不发布
 *   node scripts/seed-demo-content.mjs               # 线上（默认三个 demo 账号）
 *   BASE=http://localhost:3000 node scripts/seed-demo-content.mjs
 *   BASE=http://localhost:3000 DEMO_EMAILS='docshot@test.local' DEMO_PASSWORD='DocShot12345' \
 *     node scripts/seed-demo-content.mjs             # 本地单账号验证
 *   node scripts/seed-demo-content.mjs --check       # 只看状态，不发布
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { POSTS } from './lib/demo-posts.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const UPLOADS = join(ROOT, 'server', 'uploads', 'demo')

const BASE = (process.env.BASE || 'https://csp.bscjs.top').replace(/\/$/, '')
const PASSWORD = process.env.DEMO_PASSWORD || 'csp-demo-2026'
const EMAILS = (process.env.DEMO_EMAILS || 'demo1@csp.local,demo2@csp.local,demo3@csp.local')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const CHECK_ONLY = process.argv.includes('--check')
const DRY_RUN = process.argv.includes('--dry-run')
const INTERVAL_MS = Number(process.env.SEED_INTERVAL_MS || 3200)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = {}
  }
  return { status: res.status, data, retryAfter: Number(res.headers.get('retry-after') || 0) }
}

/** 登录，429 时按 Retry-After 等待重试（authLimiter 5 次/分钟，连续跑 check + 发布会撞） */
async function login(email) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { status, data, retryAfter } = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD }
    })
    if (status === 200 && data.accessToken) {
      return { email, token: data.accessToken, userId: data.userInfo.id }
    }
    if (status === 429) {
      const wait = Math.max(retryAfter * 1000, 5000)
      console.log(
        `    ⏳ ${email} 登录限流，${Math.round(wait / 1000)}s 后重试（第 ${attempt + 1} 次）`
      )
      await sleep(wait)
      continue
    }
    throw new Error(`登录失败 ${email}: ${status} ${data.message || ''}`)
  }
  throw new Error(`登录失败 ${email}: 重试 5 次仍被限流`)
}

/** 拉这个账号发过的全部帖子，用正文首行做标题指纹 */
async function existingTitles(token, userId) {
  const { status, data } = await api(`/api/users/${userId}/posts`, { token })
  if (status !== 200) throw new Error(`拉取用户帖子失败 ${userId}: ${status}`)
  const set = new Set()
  for (const p of data.list || []) {
    const first = String(p.content || '')
      .split('\n')[0]
      .trim()
    if (first) set.add(first)
  }
  return set
}

function buildContent(post) {
  return `${post.title}\n\n${post.body}`
}

/** 校验图片存在，并拼成接口要的 URL / 缩略图 URL */
function mediaFor(post) {
  if (post.video) {
    const videoUrl = '/uploads/demo/video/demo.mp4'
    const poster = '/uploads/demo/video/demo-poster.svg'
    if (!existsSync(join(ROOT, 'server', videoUrl))) {
      throw new Error(`视频文件不存在: ${videoUrl}`)
    }
    if (!existsSync(join(ROOT, 'server', poster))) {
      throw new Error(`视频封面不存在: ${poster}`)
    }
    return { mediaType: 'video', videoUrl, videoPoster: poster }
  }

  const urls = []
  const thumbs = []
  for (const name of post.images) {
    if (!existsSync(join(UPLOADS, name))) throw new Error(`图片不存在: ${name}`)
    const thumb = name.replace(/\.jpg$/, '_thumb.webp')
    const thumbPath = join(UPLOADS, thumb)
    urls.push(`/uploads/demo/${name}`)
    thumbs.push(existsSync(thumbPath) ? `/uploads/demo/${thumb}` : `/uploads/demo/${name}`)
  }
  return { imageUrls: urls, imageThumbs: thumbs }
}

/** 发帖，429 时按 Retry-After 等待重试 */
async function createPost(token, payload) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { status, data, retryAfter } = await api('/api/posts', {
      method: 'POST',
      token,
      body: payload
    })
    if (status === 201) return { ok: true, id: data.id }
    if (status === 429) {
      const wait = Math.max(retryAfter * 1000, 5000)
      console.log(`    ⏳ 限流，${Math.round(wait / 1000)}s 后重试（第 ${attempt + 1} 次）`)
      await sleep(wait)
      continue
    }
    return { ok: false, status, message: data.message || JSON.stringify(data).slice(0, 120) }
  }
  return { ok: false, status: 429, message: '重试 5 次仍被限流' }
}

function summary(label) {
  const by = {}
  for (const p of POSTS) by[p.tag] = (by[p.tag] || 0) + 1
  console.log(`\n${label}`)
  console.log(`  目标: ${BASE}`)
  console.log(`  内容库: ${POSTS.length} 条 / ${Object.keys(by).length} 个频道`)
  console.log(
    `  频道分布: ${Object.entries(by)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}`
  )
}

async function main() {
  summary('演示内容种子脚本')
  console.log(`  账号: ${EMAILS.join(', ')}`)
  console.log(`  模式: ${CHECK_ONLY ? '仅检查' : DRY_RUN ? '预演（不发布）' : '正式发布'}`)

  if (DRY_RUN) {
    for (const [i, p] of POSTS.entries()) {
      const media = mediaFor(p)
      console.log(
        `  ${String(i + 1).padStart(2)}. [${p.tag}] ${p.title} ` +
          `(${buildContent(p).length}字, ${media.imageUrls?.length || 0}图${media.videoUrl ? ' +视频' : ''}, 账号${p.account})`
      )
    }
    return
  }

  // 登录所有账号
  const accounts = []
  for (const email of EMAILS) {
    accounts.push(await login(email))
    console.log(`  ✓ 登录 ${email}`)
    await sleep(400) // authLimiter 5/min，别连续猛打
  }

  // 查重
  const titleSets = new Map()
  for (const acc of accounts) {
    titleSets.set(acc.email, await existingTitles(acc.token, acc.userId))
    console.log(`  ✓ ${acc.email} 已发 ${titleSets.get(acc.email).size} 条`)
  }

  // 分配任务：post.account 指定账号索引，超出账号数时轮转
  const pending = []
  const skipped = []
  for (const p of POSTS) {
    const acc = accounts[p.account % accounts.length]
    if (titleSets.get(acc.email).has(p.title)) {
      skipped.push(p.title)
      continue
    }
    pending.push({ post: p, acc })
  }

  console.log(`\n待发布 ${pending.length} 条，已存在跳过 ${skipped.length} 条`)
  if (skipped.length)
    console.log(`  跳过: ${skipped.slice(0, 5).join(' / ')}${skipped.length > 5 ? ' ...' : ''}`)
  if (CHECK_ONLY || pending.length === 0) return

  let ok = 0
  let fail = 0
  for (const [i, { post, acc }] of pending.entries()) {
    const media = mediaFor(post)
    const payload = {
      content: buildContent(post),
      topicTag: post.tag,
      visibility: 'public',
      ...media
    }
    const r = await createPost(acc.token, payload)
    if (r.ok) {
      ok++
      console.log(`  ✓ [${i + 1}/${pending.length}] ${post.tag} · ${post.title} → #${r.id}`)
    } else {
      fail++
      console.log(`  ✗ [${i + 1}/${pending.length}] ${post.title} 失败: ${r.status} ${r.message}`)
    }
    if (i < pending.length - 1) await sleep(INTERVAL_MS)
  }

  console.log(`\n完成：成功 ${ok} / 失败 ${fail} / 跳过 ${skipped.length}`)
}

main().catch((e) => {
  console.error('脚本失败:', e.message)
  process.exit(1)
})
