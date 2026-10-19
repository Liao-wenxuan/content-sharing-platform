/**
 * 可访问性审计：静态扫描 + axe-core 运行时扫描
 *
 * 这个脚本分两段，因为它们查的是**互补**的两类问题：
 *
 *   [A] 静态扫描 —— 「点了有反应，键盘够不到」
 *       扫 .vue 模板里带 @click 却不是原生可聚焦元素、也没有键盘处理的标签。
 *       ⚠️ 这一类 axe-core **查不出来**。axe 的
 *       `click-events-have-key-events` 是实验性规则、默认不在扫描集里，
 *       而且它只能看到 DOM 上的 onclick 属性，看不到 Vue 用 addEventListener
 *       挂上去的监听器。所以必须靠读源码。
 *
 *   [B] axe-core —— WCAG 2.1 A/AA 的其余条目
 *       （地标、名称、对比度、aria 属性、表单标签、标题层级……）
 *
 * 两段都有同一道守卫：**页面没渲染出来就报错，而不是报「0 个问题」**。
 * 后端挂了跑这个脚本，页面是空壳，axe 什么都能查出来 —— 读起来像满分，
 * 实际什么都没测。这是 scripts/perf-smoke.mjs 踩过的坑，这里不再踩第二次。
 *
 * 用法：
 *   npm run a11y              游客 + 登录两种状态都扫
 *   npm run a11y -- --static  只跑静态扫描（不需要起服务）
 *   npm run a11y -- --guest   只跑游客态
 *   npm run a11y -- --only 设置   只跑名字里含「设置」的页面（调面板时用）
 *   npm run a11y -- --light       强制浅色模式再扫一遍
 */
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getJwtSecret } from './lib/secret.mjs'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3000'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const STATIC_ONLY = argv.includes('--static')
const GUEST_ONLY = argv.includes('--guest')
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null
// 浅色模式：token 改动必须两个主题都验，否则「深色下全绿」只是半个结论。
// 做法是在页面加载完、主题应用之后摘掉 html.dark —— 主题只在加载时应用一次，
// 摘掉之后不会有东西再把它加回来，比改数据库或伪装接口响应都干净。
const LIGHT = argv.includes('--light')

const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'))
// axe-core 装在根目录（脚本的运行地），从根 package.json 解析
const rootRequire = createRequire(path.join(ROOT, 'package.json'))

// ============================================================
// [A] 静态扫描
// ============================================================

/**
 * 原生可聚焦 / 本身就有交互语义的标签。
 *
 * 分两类而不是一张表，因为处理方式不同：
 * - focusable：浏览器自己就能 Tab 到、Enter/Space 自己会触发 —— 不用我们管
 * - 有语义但不可聚焦（如 label、summary）：交给 [B] 的 axe 去判
 */
const NATIVE_FOCUSABLE = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'option',
  'details',
  'summary'
])

/** 带这些 role 的元素，用户会当成控件，键盘就必须能操作它 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'combobox',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox'
])

/**
 * 判断标签是不是**原生 HTML 元素**。
 *
 * 这条边界很重要，不是为了偷懒：
 *
 * - 原生标签（div / span / li …）渲染成什么，源码里写死了。
 *   在 div 上挂 @click 就是真的不可键盘触达 —— 静态扫得出来，
 *   而 axe **看不出来**（它只看 DOM 事件属性，看不到 Vue 用 addEventListener
 *   挂上去的监听器）。
 *
 * - 自定义组件（el-button / router-link / ElButton …）渲染成什么只有运行时知道。
 *   el-button 内部就是一个真 <button>，天然可 Tab、Enter/Space 可触发，
 *   静态把它判成缺陷是**纯误报**。第一版扫描器就这么把 108 处真组件全报了，
 *   狼来了 108 次之后就没人会再看这个工具的输出了。
 *   这类问题交给 axe —— 它看的是真实渲染出来的 DOM。
 *
 * 判据：原生标签 = 全小写且不含 `-`（kebab-case 一律是组件）。
 */
function isNativeTag(name) {
  return !/[A-Z-]/.test(name)
}

/**
 * 递归收集 .vue 文件。
 * 跳过 node_modules 与产物目录 —— 那里面的 .vue 不是我们的源码。
 */
function collectVue(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
      collectVue(full, out)
    } else if (entry.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 抹掉 HTML 注释，但**保留行数**（把内容换成等量的空格 + 原换行）。
 *
 * 不抹的话，模板注释里出现的 `<li @click>` 这类说明文字会被当成真的代码 ——
 * 第一版把三处刚修好的地方又报了出来，报的全是解释它们为什么这么改的注释。
 * 一个会把注释当代码的扫描器，报错时没人敢信。
 */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * 从模板里切出每一个开始标签的原文。
 *
 * 手写而不是用正则：标签可以跨行，属性值里还能有 `>`（比如 `:to="a > b"`），
 * 正则一遇到 `>` 就提前收尾。逐字符扫描并跟踪引号状态才稳。
 */
function extractTags(template) {
  const tags = []
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '<') continue
    // 只认「标签开始」：< 后紧跟字母。排除 </、<>、<!--
    const next = template[i + 1]
    if (!next || !/[a-zA-Z]/.test(next)) continue

    let quote = null
    let j = i + 1
    for (; j < template.length; j++) {
      const ch = template[j]
      if (quote) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '>') break
    }
    tags.push({ text: template.slice(i, j + 1), offset: i })
    i = j
  }
  return tags
}

/** 取标签名（去掉 < 和后面的空白） */
function tagName(text) {
  const m = /^<\s*([a-zA-Z][\w.-]*)/.exec(text)
  return m ? m[1] : ''
}

/** 取属性名集合（小写化，事件去掉修饰符） */
function attrNames(text) {
  const body = text.replace(/^<\s*[\w.-]+/, '').replace(/\/?>$/, '')
  const names = new Set()
  // @click.stop / v-on:click.prevent / @keydown.enter 都取冒号/点号前的名字
  const re = /(?:^|\s)(@|v-on:|:)((?:[\w-]+:)?)([\w-]+)/g
  let m
  while ((m = re.exec(body))) names.add((m[2] + m[3]).toLowerCase())
  return names
}

/** 行号：模板在 .vue 文件里的绝对行号（+1 因为 offset 是 0 基） */
function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) if (source[i] === '\n') line++
  return line
}

function staticScan() {
  const files = collectVue(path.join(ROOT, 'client', 'src'))
  const findings = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const tpl = /<template>([\s\S]*)<\/template>/.exec(source)
    if (!tpl) continue
    // template 段在原文件里的起始偏移，用来把 offset 换算成真实行号
    const tplStart = tpl.index + '<template>'.length

    for (const tag of extractTags(stripComments(tpl[1]))) {
      const name = tagName(tag.text)
      if (!name) continue
      // 只审原生标签。自定义组件渲染成什么是运行时的事，交给 [B] 的 axe。
      if (!isNativeTag(name)) continue
      const attrs = attrNames(tag.text)
      const hasClick = attrs.has('click')
      if (!hasClick) continue

      const hasKeyboard = attrs.has('keydown') || attrs.has('keyup') || attrs.has('keypress')
      const roleMatch = /\brole\s*=\s*"([^"]*)"/.exec(tag.text)
      const role = roleMatch ? roleMatch[1].trim().toLowerCase() : null
      const tabbable = /\btabindex\s*=\s*"([^"]*)"/.exec(tag.text)
      const tabindex = tabbable ? Number(tabbable[1]) : null

      if (NATIVE_FOCUSABLE.has(name)) continue

      // 已经是真控件了 —— 交给 axe 去查它的名称、角色、状态是否说清楚
      if (role && INTERACTIVE_ROLES.has(role) && (tabindex !== null || tabindex === 0)) {
        if (!hasKeyboard && !tabbable) {
          findings.push({
            kind: 'role-without-keyboard',
            file: path.relative(ROOT, file),
            line: lineOf(source, tplStart + tag.offset),
            detail: `<${name} role="${role}"> 没有键盘处理，也没有 tabindex`
          })
        }
        continue
      }

      // 真正的缺陷：非语义标签 + 点击处理 + 无键盘可达
      findings.push({
        kind: 'click-only',
        file: path.relative(ROOT, file),
        line: lineOf(source, tplStart + tag.offset),
        detail:
          `<${name}> 有 @click 但不是原生可聚焦元素` +
          (role ? `（role="${role}"）` : '（无 role）') +
          (tabindex === null ? '，无 tabindex' : `，tabindex=${tabindex}`) +
          (hasKeyboard ? '' : '，无键盘处理')
      })
    }

    /*
     * <li role="button">：列表项被改成了按钮。
     *
     * 这条单独列出来是因为它没有 @click 也躲不过去 ——
     * 设置页那批菜单行就是这种写法，静态扫描当时是干净的，
     * 问题由 axe 报出来：「<ul> 里出现了不允许的子节点 [role=button]」。
     *
     * role 会覆盖掉 <li> 隐含的 listitem，所以它既不是列表项，
     * 也不是一个真正的按钮（没有原生焦点顺序、没有 Enter/Space）。
     */
    for (const tag of extractTags(stripComments(tpl[1]))) {
      const name = tagName(tag.text)
      if (name !== 'li') continue
      const roleMatch = /\brole\s*=\s*"([^"]*)"/.exec(tag.text)
      const role = roleMatch ? roleMatch[1].trim().toLowerCase() : null
      if (!role || !INTERACTIVE_ROLES.has(role)) continue
      findings.push({
        kind: 'list-item-as-control',
        file: path.relative(ROOT, file),
        line: lineOf(source, tplStart + tag.offset),
        detail:
          `<li role="${role}"> 覆盖了 listitem 语义，` +
          `但 <li> 不是原生控件 —— 应改成 <li> 里放 <button>`
      })
    }
  }
  return findings
}

// ============================================================
// [B] axe-core 运行时扫描
// ============================================================

const axeSource = readFileSync(rootRequire.resolve('axe-core/axe.min.js'), 'utf8')

function ensureUser() {
  const Database = serverRequire('better-sqlite3')
  const db = new Database(process.env.DB_PATH || path.join(ROOT, 'server', 'data.db'))
  let row = db
    .prepare('SELECT id, nickname FROM users WHERE email = ?')
    .get('a11y_audit@test.local')
  if (!row) {
    const bcrypt = serverRequire('bcryptjs')
    const info = db
      .prepare('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)')
      .run('a11y_audit@test.local', bcrypt.hashSync('A11y12345', 10), '审计号')
    row = { id: Number(info.lastInsertRowid), nickname: '审计号' }
  }
  db.close()
  const jwt = serverRequire('jsonwebtoken')
  const secret = getJwtSecret(ROOT)
  return { id: row.id, nickname: row.nickname, token: jwt.sign({ userId: row.id }, secret) }
}

const user = ensureUser()

/**
 * 从库里取一个真实存在的笔记 / 用户，保证审的是有内容的页面。
 *
 * ⚠️ 这里**不能**用 `ORDER BY id LIMIT 1`。第一版就是那么写的，
 * 而它让「0 违规」这个结论变成有条件的：
 *
 * 取到的那篇笔记如果既没有配图也没有话题标签，详情页上
 * 「主图」和「话题标签」这两个元素就**根本不渲染**，
 * axe 自然扫不到它们，报告上是 0 个问题。
 *
 * 于是两个真实缺陷整整躲了好几轮：
 *   <el-image> 主图没写 alt        → image-alt（critical）
 *   <el-tag type="danger"> 话题标签对比度 4.25:1 → 低于 AA 的 4.5
 *
 * 是在把 e2e 搬进 CI、换了个库之后才暴露的 ——
 * 新库里 id 最小的笔记恰好带话题标签，元素渲染出来了，一测就红。
 *
 * 判据：**断言依赖被选中的数据时，选择器必须保证待审元素真的会出现。**
 * 和 topic-smoke 挑话题是同一个毛病，那边也是「挑数据时没保证前提」。
 *
 * 现在按「最能暴露问题」优先选：先要带图且带话题标签的，
 * 逐级降级，最后才退回任意一篇；并且把选中的是哪篇打印出来，
 * 让「0 违规」这个结论可追溯。
 */
function sampleIds() {
  const Database = serverRequire('better-sqlite3')
  const db = new Database(process.env.DB_PATH || path.join(ROOT, 'server', 'data.db'), {
    readonly: true
  })

  const hasImages = 'image_urls IS NOT NULL AND json_array_length(image_urls) > 0'
  const hasTopic = "topic_tag IS NOT NULL AND topic_tag <> ''"

  const post =
    db
      .prepare(`SELECT id FROM posts WHERE ${hasImages} AND ${hasTopic} ORDER BY id LIMIT 1`)
      .get() ??
    db.prepare(`SELECT id FROM posts WHERE ${hasImages} ORDER BY id LIMIT 1`).get() ??
    db.prepare(`SELECT id FROM posts WHERE ${hasTopic} ORDER BY id LIMIT 1`).get() ??
    db.prepare('SELECT id FROM posts ORDER BY id LIMIT 1').get()

  const author = db
    .prepare('SELECT user_id AS id FROM posts WHERE user_id IS NOT NULL ORDER BY id LIMIT 1')
    .get()

  const detail = post
    ? db.prepare('SELECT id, topic_tag, image_urls FROM posts WHERE id = ?').get(post.id)
    : null

  db.close()

  if (detail) {
    const imgs = JSON.parse(detail.image_urls || '[]').length
    console.log(
      `审计对象：笔记 #${detail.id}（${imgs} 张配图${detail.topic_tag ? '，话题 #' + detail.topic_tag : '，无话题'}）`
    )
    if (!imgs || !detail.topic_tag) {
      console.log(
        '  ⚠ 这篇笔记缺少配图或话题标签，对应的元素不会渲染 —— ' +
          '扫不到它们不等于它们没问题。先跑 npm run seed。'
      )
    }
  }

  return { post: post?.id, author: author?.id }
}

const samples = sampleIds()

/** 要审的页面。游客能看的和要登录的分开放，避免因跳转被拦而测到登录页 */
const GUEST_PAGES = [
  { name: '首页', path: '/' },
  { name: '登录页', path: '/login' },
  { name: '搜索结果', path: '/search?q=%E7%BE%8E%E9%A3%9F' },
  { name: '笔记详情', path: `/post/${samples.post}` },
  { name: '个人主页', path: `/profile/${samples.author}` },
  { name: '话题页', path: '/topic/%E7%BE%8E%E9%A3%9F' },
  { name: '市集', path: '/market' },
  { name: '兴趣画像', path: '/interest' },
  { name: 'AI 对话', path: '/ai?q=%E7%A9%BF%E6%90%AD' },
  { name: '404', path: '/this-route-does-not-exist' }
]

const AUTH_PAGES = [
  { name: '设置', path: '/settings', openDrawers: true },
  { name: '消息', path: '/messages' },
  { name: '收藏夹', path: '/favorites' },
  { name: '浏览记录', path: '/history' },
  { name: '发布页', path: '/publish' },
  { name: '购物车', path: '/market/cart' },
  { name: '订单', path: '/market/orders' },
  { name: '钱包', path: '/market/wallet' }
]

let fails = 0

/**
 * 采样前把页面**冻结到终态**。三件事，**深浅两个主题都要做**。
 *
 * ① 去掉 html.dark（仅浅色）。index.html 里预置了这个 class，避免首屏浅色闪烁，
 *    所以它一直在。
 *
 * ② 禁掉 transition / animation（**两个主题都要**）。Element 给控件加了 `transition: var(--el-transition-all)`
 *    （300ms 颜色过渡）。摘掉 dark 之后所有颜色同时开始过渡，
 *    此时立刻读 computed style 拿到的是**中间色** ——
 *    axe 会把「正在变暗的白字」当成最终颜色，量出 1.1:1 这种不存在的对比度。
 *    这个 bug 一度让浅色模式显示「101 处违规」，我为此写了 `!important`、
 *    提特异度、翻 Element 源码改变量，三轮全是在跟一个测量假象打架。
 *
 * ③ 给所有 .sg-reveal 补上 .is-revealed（**两个主题都要**）。
 *    这条是后来补的，而且它才是首页误报的真正原因。
 *    入场用 `--reveal-delay` 做阶梯（最多 6 × 60ms），IntersectionObserver
 *    逐张把卡片从 opacity:0 推到 1。页面加载慢时采样会撞在阶梯中间，
 *    同一个 `.time` 类同时呈现三种灰度（#7b7b7c / #6c6c6d / #5c5c5d），
 *    axe 把半透明前景当成最终颜色，报出 7 处不存在的「对比度不足」。
 *
 *    光禁 transition 不够：那只让**已经**加上 is-revealed 的卡片瞬间到位，
 *    还没被 observer 命中的卡片仍然停在 opacity:0。必须显式补 class。
 *
 * 为什么以前没暴露：这个版本把 ①② 绑在 `if (!on) return` 后面，
 * 深色模式直接跳过，于是深色审计一次动效都没禁过。平时跑得够快、
 * 动画已经结束，所以看不出来。
 * 实测触发条件是「刚改完 vite.config、dev server 正在重新优化依赖」，
 * 而 CI 的 dev server 永远是冷的 —— 那不是偶发，是 CI 的常态。
 *
 * ⚠️ 每次 page.goto() 之后都要重做一遍：导航会重置页面，
 *    dark class 回来、注入的样式也没了。设置页的面板审计每开一个抽屉
 *    就重新导航一次，之前漏在这里，导致 11 个面板其实都跑在深色模式下。
 */
async function freezeForMeasurement(page, light) {
  await page.evaluate((isLight) => {
    if (isLight) document.documentElement.classList.remove('dark')
    const s = document.createElement('style')
    s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'
    document.head.appendChild(s)
    // ③ 入场动画直接推到终态 —— 见上面关于 --reveal-delay 阶梯的说明
    for (const el of document.querySelectorAll('.sg-reveal')) {
      el.classList.add('is-revealed')
    }
  }, light)
}

async function probeBackend() {
  try {
    const res = await fetch(`${API}/api/health`)
    if (!res.ok) throw new Error(`status ${res.status}`)
  } catch (e) {
    console.error(`\n后端没起来（${API}/api/health: ${e.message}）`)
    console.error('axe 会把每个页面都扫成「0 个问题」—— 那是假绿，不是满分。')
    console.error('请先启动 server 再跑。')
    process.exit(1)
  }
}

async function auditPage(ctx, loggedIn) {
  /*
   * ⚠️ init script 必须挂在 **context** 上，不能挂在 page 上。
   *
   * 第一版挂在循环外面创建的那个 `page` 上，结果循环里 `ctx.newPage()`
   * 开出来的页一个都没拿到它 —— 所谓「登录态」全程都是游客，
   * /settings、/钱包 这些要登录的页全被守卫弹回 /login，
   * 于是 17 个页面报出的是同一个登录页的对比度问题。
   *
   * 这个 bug 差点被当成结论记下来：134 处「对比度不足」里有相当一部分
   * 根本不是同一个页面。
   */
  await ctx.addInitScript(
    ([t, u]) => {
      if (t) localStorage.setItem('auth', JSON.stringify({ user: u, token: t }))
      else localStorage.removeItem('auth')
    },
    [loggedIn ? user.token : null, { id: user.id, nickname: user.nickname, avatar: null }]
  )
  const res = await ctx.request.get(`${API}/api/feed`).catch(() => null)
  if (!res || !res.ok()) {
    console.error(
      `\n接口不通（${API}/api/feed -> ${res ? res.status() : '连接失败'}），页面会是空壳。`
    )
    console.error('axe 会把每个页面都扫成「0 个问题」—— 那是假绿，不是满分。')
    console.error('请先启动 server 再跑。')
    process.exit(1)
  }

  const results = []
  let pages = loggedIn ? [...GUEST_PAGES, ...AUTH_PAGES] : GUEST_PAGES
  if (ONLY) pages = pages.filter((p) => p.name.includes(ONLY))

  for (const target of pages) {
    const p = await ctx.newPage()
    try {
      await p.goto(`${BASE}${target.path}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      // 等主区域真的出现内容，而不是只等 DOM ready
      await p.locator('main, .standalone').first().waitFor({ state: 'visible', timeout: 15000 })
      await p.waitForTimeout(700)

      // AI 对话页的答案是**流式**吐出来的，统一那 700ms 不足以等它吐完 ——
      // 扫到半成品会得到一份「动画中的对比度」的成绩单。
      // 所以等页面自己报出「准备好了」（data-ai-ready），而不是猜该等多久。
      if (target.path.startsWith('/ai')) {
        await p
          .locator('[data-ai-ready="true"]')
          .waitFor({ state: 'attached', timeout: 20000 })
          .catch(() => {})
      }

      // 详见 freezeForMeasurement：禁动效 + 推入场动画到终态，每次导航后重做。
      await freezeForMeasurement(p, LIGHT)

      /*
       * 守卫二：确认没被重定向。
       *
       * 只查节点数不够 —— 登录页也有几百个节点，量足够，
       * 扫出来却是一片 PASS。而「扫的不是我要审的那个页面」是最难自查的错：
       * 它不会报错，只会安静地给出一份别的页面的成绩单。
       *
       * 只比 pathname：带 query 的页（/search?q=…）跳转到去掉 query 的
       * 同一路径不算重定向，那是同一个页面。
       */
      const landed = new URL(p.url()).pathname
      const wanted = new URL(BASE + target.path).pathname
      if (landed !== wanted) {
        console.log(
          `  ${'SKIP'.padEnd(4)} ${target.name.padEnd(10)} 被重定向到 ${landed}，测的不是这个页面`
        )
        continue
      }

      // 守卫一：空壳页面会安静地报「0 违规」
      const nodeCount = await p.evaluate(() => document.querySelectorAll('*').length)
      if (nodeCount < 50) {
        console.log(
          `  ${'SKIP'.padEnd(4)} ${target.name.padEnd(10)}  页面只有 ${nodeCount} 个节点，跳过`
        )
        continue
      }

      await p.addScriptTag({ content: axeSource })
      const out = await p.evaluate(async () => {
        const r = await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
        })
        return r.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          count: v.nodes.length,
          // ⚠️ html 和 data 必须**逐节点配对**。
          // 第一版把「节点数 N 的 data」去配「只取前 2 条的 sample」，
          // 于是下标 2 以后全是 undefined —— 报告里对比度那几组样本全是空白，
          // 看着像没抓到元素，其实是自己配错了。
          nodes: v.nodes.map((n) => ({
            html: n.html.slice(0, 120),
            // axe 自己说的理由。只报「第 N 处不达标」的话，
            // 修的人得反推它到底看的是什么，容易改成另一个错的东西。
            msg: (n.any?.[0]?.message ?? n.all?.[0]?.message ?? '').slice(0, 160),
            data: n.any?.[0]?.data ?? {}
          }))
        }))
      })

      results.push({ page: target.name, path: target.path, nodeCount, violations: out })

      /*
       * 设置页的各个面板是 el-drawer，**不点开就不渲染**。
       *
       * 第一版只审 /settings 本身，于是 8 个 el-switch 里只报了 1 个 ——
       * 另外 7 个在没打开的面板里，一个都没被扫到。
       * 「审过了」和「审的是这个功能」不是一回事：
       * 覆盖率上的一处空白，报告上是干干净净的 0 违规。
       */
      if (target.openDrawers) {
        // 用 data-item 而不是文案定位：文案里有换行、有描述文字、
        // 截断成 12 个字符之后 hasText 匹配就开始飘 —— 之前 6 个面板
        // 只审成了 1 个，而且不报错，看上去像「只有一个面板有问题」。
        const keys = await p.$$eval('.item-row.clickable', (els) =>
          els.map((e) => e.getAttribute('data-item')).filter(Boolean)
        )
        for (const key of keys) {
          const row = p.locator(`[data-item="${key}"]`)
          // 每个面板都从一次干净的导航开始：抽屉的遮罩会盖住整页，
          // 上一个没关干净的话，下一次点击会被自己的 overlay 拦下来
          await p.goto(`${BASE}${target.path}`, { waitUntil: 'domcontentloaded' })
          await p.locator('.item-row.clickable').first().waitFor({ timeout: 15000 })
          await p.waitForTimeout(500)
          // 重新导航会重置页面：dark class、注入的禁动效样式、补上的 class 全没了
          await freezeForMeasurement(p, LIGHT)

          // ⚠️ 别把点击错误吞掉。第一版写了 `.catch(() => {})`，
          // 结果「点不动」和「点了没反应」在报告里长得一模一样 ——
          // 12 个面板显示成「没弹出抽屉」，看上去像它们不是面板。
          const clicked = await row
            .click({ timeout: 8000 })
            .then(() => true)
            .catch((e) => {
              console.log(`  ${'FAIL'.padEnd(4)} 设置·${key}  点不动：${String(e).split('\n')[0]}`)
              return false
            })
          if (!clicked) continue
          /*
           * ⚠️ 必须用 `:visible`，不能等 `.el-drawer`。
           *
           * 页面上同时挂着 11 个抽屉（关着的时候也在 DOM 里，只是不可见），
           * 而 waitForSelector 只盯 DOM 顺序里的第一个 —— 也就是永远不会
           * 打开的那个，于是每个面板都「没弹出抽屉」。
           * 报告里它长得和「点了没反应」完全一样。
           */
          const opened = await p
            .locator('.el-drawer:visible')
            .first()
            .waitFor({ timeout: 4000 })
            .then(() => true)
            .catch(() => false)
          if (!opened) {
            // 点「路由」类菜单会跳走，那不是面板；跳走了就回到设置页
            console.log(`  ${'SKIP'.padEnd(4)} 设置·${key}  没弹出抽屉（可能是跳转类菜单）`)
            continue
          }

          await p.waitForTimeout(500)
          await p.addScriptTag({ content: axeSource })
          const panelOut = await p.evaluate(async () => {
            const r = await window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
            })
            return r.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              count: v.nodes.length,
              nodes: v.nodes.map((n) => ({
                html: n.html.slice(0, 120),
                msg: (n.any?.[0]?.message ?? n.all?.[0]?.message ?? '').slice(0, 160),
                data: n.any?.[0]?.data ?? {}
              }))
            }))
          })
          const panelNodes = await p.evaluate(() => document.querySelectorAll('*').length)
          results.push({
            page: `设置·${key}`,
            path: target.path,
            nodeCount: panelNodes,
            violations: panelOut
          })
        }
      }
    } finally {
      await p.close()
    }
  }
  return results
}

async function main() {
  console.log('===== [A] 静态扫描：点击热区的键盘可达性 =====')
  const statics = staticScan()
  if (statics.length === 0) {
    console.log('  0 个问题：没有「有 @click 但键盘够不到」的元素')
  } else {
    for (const f of statics) {
      fails++
      console.log(`  ${f.kind.padEnd(20)} ${f.file}:${f.line}  ${f.detail}`)
    }
    console.log(`\n  共 ${statics.length} 处`)
  }

  if (STATIC_ONLY) {
    console.log('\n===== 结果 =====')
    console.log(fails === 0 ? '  通过' : `  失败：${fails} 处`)
    process.exit(fails === 0 ? 0 : 1)
  }

  await probeBackend()
  console.log('\n===== [B] axe-core：WCAG 2.1 A/AA =====')

  const browser = await chromium.launch()
  const states = GUEST_ONLY ? [false] : [false, true]
  const all = []

  for (const loggedIn of states) {
    console.log(`\n--- ${loggedIn ? '登录态' : '游客态'} ---`)
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    const res = await auditPage(ctx, loggedIn)
    await ctx.close()

    for (const r of res) {
      const total = r.violations.reduce((s, v) => s + v.count, 0)
      all.push({ ...r, loggedIn })
      if (total === 0) {
        console.log(`  PASS  ${r.page.padEnd(10)} 0 个问题`)
      } else {
        fails += total
        console.log(`  FAIL  ${r.page.padEnd(10)} ${total} 个问题`)
        for (const v of r.violations) {
          console.log(`          [${v.impact}] ${v.id} ×${v.count} — ${v.help}`)
          for (const n of v.nodes.slice(0, 2)) {
            console.log(`            ${n.html}`)
            if (n.msg) console.log(`              -> ${n.msg}`)
          }
        }
      }
    }
  }
  await browser.close()

  // 汇总：同一个规则在几个页面重复出现，说明是组件级问题而不是某页特有
  console.log('\n===== 汇总（按规则） =====')
  const byRule = new Map()
  for (const r of all) {
    for (const v of r.violations) {
      const cur = byRule.get(v.id) ?? { count: 0, pages: new Set(), impact: v.impact, help: v.help }
      cur.count += v.count
      cur.pages.add(r.page)
      byRule.set(v.id, cur)
    }
  }
  if (byRule.size === 0) {
    console.log('  无违规')
  } else {
    for (const [id, v] of [...byRule.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(
        `  ${id.padEnd(26)} ${String(v.count).padStart(4)} 处  页面: ${[...v.pages].join(', ')}`
      )
    }
  }

  /*
   * 对比度单独按「前景 / 背景 / 要求」归组。
   *
   * 117 处散在 15 个页面上，逐个改样式是错的 —— 它们几乎肯定由少数几个
   * 变量造成。归组之后才能看出「是 token 的问题」还是「是某个组件的问题」。
   */
  const contrast = new Map()
  for (const r of all) {
    for (const v of r.violations) {
      if (v.id !== 'color-contrast') continue
      v.nodes.forEach((n) => {
        const d = n.data
        if (!d || d.contrastRatio === undefined) return
        const key = `${d.fgColor}|${d.bgColor}|${d.expectedContrastRatio}`
        const cur = contrast.get(key) ?? {
          ratio: d.contrastRatio,
          n: 0,
          pages: new Set(),
          html: []
        }
        cur.n++
        cur.pages.add(r.page)
        if (cur.html.length < 3) cur.html.push(n.html)
        contrast.set(key, cur)
      })
    }
  }
  if (contrast.size) {
    console.log('\n===== 对比度归组（前景 / 背景 / 实测 / 要求） =====')
    for (const [key, v] of [...contrast.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(
        `  ${String(v.n).padStart(3)} 处  ${key.replace(/\|/g, '  ')}  实测 ${v.ratio}  页面: ${[...v.pages].join(', ')}`
      )
      for (const h of v.html) console.log(`        ${String(h).slice(0, 100)}`)
    }
  }

  console.log('\n===== 结果 =====')
  const totalNodes = all.reduce((s, r) => s + r.nodeCount, 0)
  console.log(`  审了 ${all.length} 个页面状态，累计 ${totalNodes} 个 DOM 节点`)
  console.log(fails === 0 ? '  通过' : `  失败：${fails} 处`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
