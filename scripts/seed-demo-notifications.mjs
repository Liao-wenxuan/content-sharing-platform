#!/usr/bin/env node
/**
 * 给演示账号补「消息中心」的内容。
 *
 * 为什么需要：消息中心的通知是别人跟「我」互动才产生的。演示站上
 * 体验账号 demo1 既没发过笔记，也没人关注它，于是三个分类全是 0，
 * 铃铛点开也是一片空 —— 看上去就像功能坏了。
 *
 * 这里**不直接往 notifications 表塞记录**（那会让「点开通知跳到原文」
 * 变成指向别人笔记的假数据）。全部走真实业务接口：
 * 体验账号发一条笔记 → 另外两个演示账号点赞 / 收藏 / 评论 / 关注，
 * 通知由服务端的 createNotification 正常产生，postId 指向真实笔记。
 *
 * 幂等：先查三个分类的通知数，都齐了就什么都不做；
 * 点赞 / 收藏 / 关注后端本身就是 INSERT OR IGNORE，评论按内容查重。
 *
 * 用法：
 *   node scripts/seed-demo-notifications.mjs                 # 线上
 *   BASE=http://127.0.0.1:3000 node scripts/seed-demo-notifications.mjs
 *   node scripts/seed-demo-notifications.mjs --check         # 只看状态
 */
const BASE = (process.env.BASE || 'https://csp.bscjs.top').replace(/\/$/, '')
const PASSWORD = process.env.DEMO_PASSWORD || 'csp-demo-2026'
const CHECK_ONLY = process.argv.includes('--check')

const HOST_EMAIL = 'demo1@csp.local'
const ACTORS = ['demo2@csp.local', 'demo3@csp.local']
const POST_CONTENT = '第一次在这里记一笔：消息中心上线了，点赞、收藏、评论和关注都会在那里提醒我。'

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
  return { status: res.status, data }
}

async function login(email) {
  const { status, data } = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD }
  })
  if (status !== 200 || !data.accessToken) {
    throw new Error(`登录失败 ${email}: ${status} ${data.message || ''}`)
  }
  return { token: data.accessToken, user: data.userInfo }
}

async function categoryTotals(token) {
  const out = {}
  for (const cat of ['likes', 'follows', 'mentions']) {
    const { data } = await api(`/api/notifications?category=${cat}&pageSize=1`, { token })
    out[cat] = data.pagination?.total ?? -1
    await sleep(250)
  }
  return out
}

async function findOrCreatePost(token, userId) {
  const { data } = await api(`/api/users/${userId}/posts`, { token })
  const existing = (data.list || []).find((p) => p.content?.includes('消息中心上线了'))
  if (existing) return { id: existing.id, created: false }

  const res = await api('/api/posts', {
    method: 'POST',
    token,
    body: { content: POST_CONTENT, imageUrls: [], imageThumbs: [], topicTag: '日常' }
  })
  if (res.status >= 400) {
    throw new Error(`发演示笔记失败: ${res.status} ${res.data.message || ''}`)
  }
  return { id: res.data.id ?? res.data.post?.id, created: true }
}

async function run() {
  const host = await login(HOST_EMAIL)
  const before = await categoryTotals(host.token)
  console.log(`体验账号 ${host.user.nickname} (id=${host.user.id}) 现有通知：`, before)

  if (CHECK_ONLY) return
  if (Object.values(before).every((n) => n > 0)) {
    console.log('三个分类都已有通知，无需重复生成。')
    return
  }

  const post = await findOrCreatePost(host.token, host.user.id)
  if (!post.id) throw new Error('拿不到演示笔记 id')
  console.log(`演示笔记 id=${post.id}${post.created ? '（新建）' : '（复用）'}`)
  await sleep(500)

  for (const [i, email] of ACTORS.entries()) {
    const actor = await login(email)
    await sleep(400)

    const like = await api(`/api/posts/${post.id}/like`, { method: 'POST', token: actor.token })
    console.log(`  ${email} 点赞: ${like.status}`)
    await sleep(400)

    if (i === 0) {
      const fav = await api(`/api/posts/${post.id}/favorite`, {
        method: 'POST',
        token: actor.token
      })
      console.log(`  ${email} 收藏: ${fav.status}`)
      await sleep(400)

      // 评论会重复创建，先查一遍有没有同内容的
      const comments = await api(`/api/posts/${post.id}/comments`, { token: actor.token })
      const list = comments.data.list || comments.data.comments || []
      const already = list.some((c) => c.content === '写得真好，等更新！')
      if (!already) {
        const c = await api(`/api/posts/${post.id}/comments`, {
          method: 'POST',
          token: actor.token,
          body: { content: '写得真好，等更新！' }
        })
        console.log(`  ${email} 评论: ${c.status}`)
      } else {
        console.log(`  ${email} 评论: 已有，跳过`)
      }
      await sleep(400)
    }

    const follow = await api(`/api/users/${host.user.id}/follow`, {
      method: 'POST',
      token: actor.token
    })
    console.log(`  ${email} 关注体验账号: ${follow.status}`)
    await sleep(600)
  }

  const after = await categoryTotals(host.token)
  console.log('生成后通知：', after)
  const ok = Object.values(after).every((n) => n > 0)
  console.log(ok ? '✅ 三个分类都有真实通知了' : '⚠️ 仍有分类为空，检查上面的 HTTP 状态')
  if (!ok) process.exitCode = 1
}

run().catch((e) => {
  console.error('✗', e.message)
  process.exitCode = 1
})
