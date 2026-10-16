/**
 * CSS 语法检查 —— 用 esbuild 当裁判，因为构建时就是它在做同一件事。
 *
 * 为什么不用 postcss：
 * postcss 的默认解析器只校验**结构**（括号配对、分号），不校验选择器语义。
 * `.not(:disabled)` 这种写法在它眼里完全合法 —— 一个叫 `not` 的类，
 * 后面跟一个伪类，语法没毛病。但浏览器会丢弃整条规则，
 * 于是「按压反馈从来没生效」这种 bug 可以安静地躺在仓库里几个月。
 *
 * 为什么用 esbuild 的 build() 而不是 transform()：
 * 只有 build() + stdin + minify 这条路径会报选择器层面的问题。
 * transform() 对同一段 CSS 静默通过（实测：0 warning）。
 * 构建里那条 `[esbuild css minify]` 警告正是这条路径发出的，
 * 所以检查器和构建用同一个裁判，不会出现「检查说没问题、构建说有问题」。
 *
 * 覆盖范围：
 * - client/src 下所有独立 .css 文件（theme.css / motion.css / element-theme.css）
 * - 所有 .vue 的 <style> 块
 *
 * 上一版只查 .vue 的 <style> 块，且依赖的 postcss 根本没装 ——
 * 脚本从来没成功跑过，这就是 :where(...).not(...) 能活下来的原因。
 */
import { build, version } from 'esbuild'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const ROOTS = ['client/src']
const ROOT = process.cwd()

/** 一段 CSS 交给 esbuild，返回它报的所有问题 */
async function inspect(contents, sourcefile) {
  const result = await build({
    stdin: { contents, loader: 'css', sourcefile },
    minify: true,
    write: false,
    logLevel: 'silent'
  })
  return [...(result.errors ?? []), ...(result.warnings ?? [])]
}

const targets = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else if (extname(full) === '.css') targets.push({ file: full, css: readFileSync(full, 'utf8') })
    else if (extname(full) === '.vue') {
      const src = readFileSync(full, 'utf8')
      for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        // 前面补空行，让 esbuild 报的行号和 SFC 里的真实行号对齐
        const startLine = src.slice(0, m.index).split('\n').length
        targets.push({
          file: full,
          css: '\n'.repeat(startLine) + m[1],
          note: `<style> @ line ${startLine + 1}`
        })
      }
    }
  }
}

for (const root of ROOTS) walk(root)

let failed = 0
for (const t of targets) {
  const problems = await inspect(t.css, t.file)
  if (!problems.length) continue
  const rel = relative(ROOT, t.file).replace(/\\/g, '/')
  console.log(`\n✗ ${rel}${t.note ? '  ' + t.note : ''}`)
  for (const p of problems) {
    console.log(`    ${p.location?.line ?? '?'}: ${p.text}`)
  }
  console.log('    （这类问题 eslint / vue-tsc / postcss 都发现不了，浏览器会静默丢弃整条规则）')
  failed++
}

console.log(
  `\n===== checked ${targets.length} CSS source(s) with esbuild ${version}, ${failed} with problems =====`
)
process.exit(failed > 0 ? 1 : 0)
