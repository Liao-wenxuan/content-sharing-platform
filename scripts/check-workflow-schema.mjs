/**
 * 用 GitHub 官方的 workflow schema 校验 .github/workflows/*.yml。
 *
 * 为什么需要它（而不是「YAML 能解析就行」）：
 * `jobs.<id>.paths-ignore` 这类**键的位置**写错了，YAML 解析器完全能过 ——
 * 但 GitHub 自己的 schema 校验会拒绝，整个工作流被判为 Invalid workflow file，
 * 结果是：run 在同一秒内失败、0 个 job、0 个 check-run，什么日志都没有。
 *
 * 那个坑就是这么踩到的：本地 YAML 解析成功，推上去直接红。
 *
 * 所以：**改工作流文件 → 跑这个校验 → 再推**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import Ajv from 'ajv'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, '.github', 'workflows')

const SCHEMA_URL = 'https://json.schemastore.org/github-workflow.json'

let schema
try {
  const res = await fetch(SCHEMA_URL)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  schema = await res.json()
  console.log(`已取到 GitHub 官方 schema（${SCHEMA_URL}）`)
} catch (err) {
  /*
   * 取不到 schema 就跳过，不让构建挂在网络抖动上。
   *
   * 但要知道这一项跳过之后，本地校验**不等于** GitHub 的校验 ——
   * 那种「键的位置写错」的错只有 schema 才抓得到
   *（YAML 解析器对 `jobs.<id>.paths-ignore` 完全无感）。
   * 推上去仍然是最终裁判，所以这里只警告、不失败。
   */
  console.log('⚠ 取不到 GitHub schema（' + err.message + '）—— 跳过工作流校验')
  console.log('  这一项跳过时不等于 GitHub 也会接受；改完工作流请推上去看一眼。')
  process.exit(0)
}

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true })
const validate = ajv.compile(schema)

let bad = 0
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml') || x.endsWith('.yaml'))) {
  const full = path.join(DIR, f)
  const doc = YAML.parse(fs.readFileSync(full, 'utf8'))
  const ok = validate(doc)
  if (ok) {
    console.log(`✓ ${f}  符合 GitHub schema（jobs: ${Object.keys(doc.jobs || {}).join(', ')}）`)
  } else {
    bad++
    console.log(`✗ ${f}  schema 不通过：`)
    for (const e of validate.errors.slice(0, 8)) {
      console.log(`    ${e.instancePath || '(根)'} ${e.message}  ${JSON.stringify(e.params)}`)
    }
  }
}

process.exit(bad ? 1 : 0)
