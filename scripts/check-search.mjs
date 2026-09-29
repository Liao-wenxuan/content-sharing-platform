const API = 'http://localhost:3000/api'

const hit = async (q, sort = 'latest') => {
  const r = await fetch(`${API}/posts/search?q=${encodeURIComponent(q)}&pageSize=5&sort=${sort}`)
  const j = await r.json()
  return `q="${q}" [${sort}] HTTP ${r.status} total=${j.pagination?.total ?? '-'} ${
    j.list?.length ? '首条=[' + j.list[0].topicTag + '] ' + j.list[0].content.slice(0, 18) : ''
  }`
}

console.log('--- 基本搜索 ---')
for (const q of ['美食', '职场', '柚子', '咖啡', '不存在的词xyz']) console.log(await hit(q))

console.log('\n--- 排序 ---')
for (const s of ['latest', 'hot', 'comment']) console.log(await hit('美食', s))

console.log('\n--- 通配符注入（应被转义，不应全表命中）---')
for (const q of ['%', '_', '100%', "' OR 1=1--"]) {
  const r = await fetch(`${API}/posts/search?q=${encodeURIComponent(q)}&pageSize=3`)
  const j = await r.json()
  console.log(`q="${q}" → HTTP ${r.status} total=${j.pagination?.total ?? j.message}`)
}

console.log('\n--- 边界 ---')
const empty = await fetch(`${API}/posts/search?q=`)
console.log('空 q →', empty.status, (await empty.json()).message)
const long = await fetch(`${API}/posts/search?q=${'a'.repeat(60)}`)
console.log('超长 q →', long.status, (await long.json()).message)
