/**
 * 顺序跑全部 e2e 套件，每套的输出单独存文件，最后汇总。
 *
 * 为什么要有这个脚本，而不是在 CI 里写一串 `npm run test:x`：
 *
 * ① **一套挂了不能挡住后面的**。串行 `&&` 链在第一个失败时就停了，
 *    于是你只知道「有东西坏了」，要跑第二遍才知道是哪几个。
 *    这里跑完全部套件再汇总，失败信息一次拿全。
 *
 * ② **每套的完整输出要留档**。CI 里失败现场最容易丢 ——
 *    日志在滚屏里滚过去就没了。这里按套件存到 .e2e-logs/，
 *    失败时作为 artifact 上传。
 *
 * ③ **耗时是决策依据**。全部套件的总耗时决定了以后该不该拆分 job。
 *
 * 另外两个只有真正跑过 CI 才会发现的约束（都写在下面注释里了）：
 *   - 套件会用 serverRequire **直接打开 SQLite 文件**，所以 DB_PATH
 *     必须让服务端和脚本指向同一个库，否则两边看到的用户 id 不一样，
 *     表现为「用户不存在」的 404。
 *   - 套件**依赖 seed 出来的数据**（搜索建议下拉要读热门话题），
 *     空库下 .suggest-panel 根本不渲染，第一套就超时。
 *
 * ⚠️ **e2e 的时间不是花在这些套件上的。**
 * 2026-10-26 实测（CI 日志）：job 从 09:43:34 开始，
 * 但**第一套真正开跑是 10:00:50** —— 前面 17 分钟全在
 * checkout / npm ci / build / seed 上。
 * 而 15 套加起来（最慢的 chat 套 9s）本身只要 5 分钟。
 *
 * 所以想缩短 CI 时间的话，去看 **setup 那 17 分钟**（依赖装了几次、
 * build 跑了几遍），不是去砍套件 —— 砍套件省不了多少，
 * 还会让「每套都留档」这个设计失效。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG_DIR = join(ROOT, '.e2e-logs')

const SUITES = [
  ['desktop', 'test:e2e'],
  ['search', 'test:search'],
  ['chat', 'test:chat'],
  ['follow', 'test:follow'],
  ['favorite', 'test:favorite'],
  ['notify', 'test:notify'],
  ['topic', 'test:topic'],
  ['comment', 'test:comment'],
  ['view-history', 'test:history'],
  ['market', 'test:market'],
  ['feed', 'test:feed'],
  ['image', 'test:image'],
  ['reveal', 'test:reveal'],
  ['settings', 'test:settings'],
  ['ai', 'test:ai']
]

if (existsSync(LOG_DIR)) rmSync(LOG_DIR, { recursive: true, force: true })
mkdirSync(LOG_DIR, { recursive: true })

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('npm', ['run', name], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env: process.env
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) =>
      resolve({ code, secs: Math.round((Date.now() - started) / 1000), out })
    )
  })
}

const results = []
let total = 0

for (const [label, npmName] of SUITES) {
  process.stdout.write(`▶ ${label.padEnd(13)} ${npmName.padEnd(16)} `)
  const r = await run(npmName)
  total += r.secs
  writeFileSync(join(LOG_DIR, `${label}.log`), r.out, 'utf8')
  results.push({ label, npmName, ...r })
  console.log(`${r.secs}s  ${r.code === 0 ? 'PASS' : 'FAIL'}`)
}

const failed = results.filter((r) => r.code !== 0)
const passed = results.length - failed.length

console.log('\n════════════════════════════════════════')
console.log(`  ${passed}/${results.length} 套通过，总耗时 ${total}s`)
console.log('════════════════════════════════════════')

if (failed.length) {
  for (const f of failed) {
    console.log(`\n─── ${f.label} (${f.npmName}) 失败，输出末尾 25 行 ───`)
    console.log(f.out.split('\n').slice(-25).join('\n'))
  }
  console.log(`\n完整日志：.e2e-logs/`)
  process.exit(1)
}

console.log('日志目录：.e2e-logs/（全部保留，方便出问题时回看）')
