/**
 * 提交信息长度预检
 *
 * commitlint 会拦，但拦的时候已经进到 husky 钩子了：
 * 报错还带一个交互式 input 提示，在这个非交互 shell 里表现为
 * 「命令挂住然后以 4294967295 退出」，看不出到底哪条规则没过。
 *
 * 所以提交前先自己量一遍 header（≤72）和 body 行（≤100）。
 * 用法：node scripts/check-commit-msg.mjs <文件路径>
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/check-commit-msg.mjs <msg-file>')
  process.exit(2)
}

const text = readFileSync(file, 'utf8')
const bom = readFileSync(file)[0] === 0xff && readFileSync(file)[1] === 0xfe
if (bom) {
  console.error('❌ 文件是 UTF-16LE（BOM = 255,254）。commitlint 会把它读成乱码。')
  process.exit(1)
}

const lines = text.split(/\r?\n/)
const header = lines[0] ?? ''
const problems = []

if (header.length > 72) problems.push(`header ${header.length} 字符 > 72`)
if (!header.trim()) problems.push('header 为空')

lines.slice(1).forEach((line, i) => {
  if (line.length > 100) problems.push(`body 第 ${i + 2} 行 ${line.length} 字符 > 100`)
})

if (problems.length) {
  console.error('❌ ' + problems.join('\n❌ '))
  process.exit(1)
}
console.log(`✅ header ${header.length} 字符，通过`)
