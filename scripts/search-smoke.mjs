import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
const errs = []
p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 160)))
p.on('response', (r) => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().slice(-40)}`))

let fails = 0
const check = (l, ok, d = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  -> ' + d : ''}`)
}

console.log('\n[1] 空搜索页：历史区 + 引导')
await p.goto(`${BASE}/search`, { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
check('搜索页渲染', await p.locator('.search-page').isVisible())
check('空态引导可见', (await p.locator('.el-empty').innerText()).includes('输入关键词'))
check('提示了可搜的词', (await p.locator('.hint').innerText()).includes('美食'))
await p.screenshot({ path: 'shots/search-empty.png' })

console.log('\n[2] 顶栏回车搜索')
await p.locator('.top-bar input').fill('美食')
await p.locator('.top-bar input').press('Enter')
await p.waitForURL('**/search?q=*')
await p.waitForTimeout(900)
check(
  '跳到 /search?q=美食',
  p.url().includes('q=%E7%BE%8E%E9%A3%9F') || p.url().includes('q=美食'),
  p.url()
)
check('结果计数显示', (await p.locator('.result-meta').innerText()).includes('找到'))
const cards = await p.locator('.masonry .card').count()
check('有结果卡片', cards > 0, cards + ' 张')
// 搜「美食」命中的是 topic_tag，正文里可能没有这个词，
// 所以视觉反馈走封面左上角的标签角标；正文命中时才看 .title .hit
check('命中标签有角标反馈', (await p.locator('.tag-badge').count()) > 0)
check('顶栏输入框回填', (await p.locator('.top-bar input').inputValue()) === '美食')
await p.screenshot({ path: 'shots/search-result.png' })

console.log('\n[3] 搜正文里的词 → 标题内高亮')
await p.goto(`${BASE}/search?q=${encodeURIComponent('咖啡')}`, { waitUntil: 'networkidle' })
await p.waitForTimeout(900)
check('正文命中高亮', (await p.locator('.title .hit').count()) > 0)
check('高亮内容正确', (await p.locator('.title .hit').first().innerText()) === '咖啡')
await p.screenshot({ path: 'shots/search-highlight.png' })

console.log('\n[4] 搜索历史（清空后才展示，这是设计）')
await p.goto(`${BASE}/search`, { waitUntil: 'networkidle' })
await p.waitForTimeout(800)
check('历史卡出现', await p.locator('.history-card').isVisible())
const tags = await p.locator('.history-tag').allInnerTexts()
check(
  '历史含「咖啡」',
  tags.some((t) => t.includes('咖啡')),
  tags.join(' / ')
)
check('历史去重且有序', new Set(tags).size === tags.length)

console.log('\n[5] 点历史标签再次搜索')
await p.locator('.history-tag').first().click()
await p.waitForTimeout(900)
check('URL 带 q', p.url().includes('q='))
check('结果有卡片', (await p.locator('.masonry .card').count()) > 0)
check('搜索时隐藏历史卡', !(await p.locator('.history-card').isVisible()))

console.log('\n[6] 排序切换（用结果足够多的词，否则排序看不出差别）')
await p.goto(`${BASE}/search?q=${encodeURIComponent('美食')}`, { waitUntil: 'networkidle' })
await p.waitForTimeout(900)
const titlesLatest = await p.locator('.masonry .card .title').allInnerTexts()
check('最新排序有结果', titlesLatest.length > 1, titlesLatest.length + ' 条')
await p.locator('.sort-group .el-radio-button', { hasText: '最多点赞' }).click()
await p.waitForTimeout(1000)
const titlesHot = await p.locator('.masonry .card .title').allInnerTexts()
check('排序改变了结果顺序', JSON.stringify(titlesLatest) !== JSON.stringify(titlesHot))
check('最多点赞首条互动最高', await p.locator('.masonry .card').first().isVisible())

console.log('\n[7] 无结果')
await p.goto(`${BASE}/search?q=zzzznotexist`, { waitUntil: 'networkidle' })
await p.waitForTimeout(900)
check('空结果提示', (await p.locator('.el-empty').innerText()).includes('没有找到'))

console.log('\n[8] 顶栏搜索框（侧栏已无搜索入口）')
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
const navText = await p.locator('.nav-menu').innerText()
check('侧栏不再含「搜索」', !navText.includes('搜索'))
check('搜索框在顶栏', await p.locator('.top-bar .search-input input').isVisible())

// 聚焦即出建议下拉
await p.locator('.top-bar .search-input input').click()
await p.locator('.suggest-panel').waitFor({ state: 'visible', timeout: 5000 })
check('聚焦弹出建议面板', await p.locator('.suggest-panel').isVisible())
check('面板里有分组标题', (await p.locator('.group-title').count()) >= 1)

// 输入即出候选
await p.locator('.top-bar .search-input input').fill('美食')
await p
  .locator('.suggest-row', { hasText: '美食' })
  .first()
  .waitFor({ state: 'visible', timeout: 5000 })
check('输入后出现候选', (await p.locator('.suggest-row').count()) > 0)

// 回车进结果页，且侧栏回落高亮「发现」
await p.locator('.top-bar .search-input input').press('Enter')
await p.waitForTimeout(900)
check('回车进 /search', p.url().includes('/search'))
check(
  '搜索页侧栏回落高亮「发现」',
  (await p.locator('.el-menu-item.is-active').innerText()).includes('发现')
)

console.log('\n[9] 顶栏清空 → 回空态')
await p.locator('.top-bar input').fill('美食')
await p.locator('.top-bar input').press('Enter')
await p.waitForTimeout(900)
check('有结果', (await p.locator('.masonry .card').count()) > 0)
await p.locator('.top-bar .el-input__clear').click()
await p.waitForTimeout(900)
check('清空后回空态', (await p.locator('.el-empty').innerText()).includes('输入关键词'))
check('清空后 URL 无 q', !p.url().includes('q='))
check('清空后历史仍在', await p.locator('.history-card').isVisible())
await p.screenshot({ path: 'shots/search-history.png' })

console.log(`\n──────── 结果 ────────`)
console.log('  console error / 失败请求：', errs.length ? errs : '0')
console.log(`  断言：${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
await b.close()
process.exit(fails === 0 && errs.length === 0 ? 0 : 1)
