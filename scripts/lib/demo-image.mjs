/**
 * 挑一张**确实存在**的 demo 图，返回它能访问的 URL。
 *
 * 背景：`comment-smoke` 和 `view-history-smoke` 都往库里插一篇带配图的笔记，
 * 原来硬编码了 `/uploads/demo/d1-14954744.jpg` —— 那是某一次
 * `npm run seed:photos` 从 Unsplash 下载时恰好生成的文件名。
 *
 * 本地永远是对的（那批图就在我机器上），换一台机器就不一定：
 * 新 clone / CI runner 上 `uploads/demo/` 要么不存在、要么是 seed 生成的
 * `d1-placeholder.svg`，于是这两套件一跑就是
 *
 *     FAIL 零 console error / 零失败请求 -> HTTP 404 /uploads/demo/d1-14954744.jpg
 *
 * 而 suite 的 `console error / 失败请求` 守卫本身是对的 ——
 * 它只是把「图片 URL 写错了」这件事报成了「页面有 404」。
 *
 * 教训和另外三处一样：**硬编码一个只在本机存在的文件名**。
 * 这里不猜文件名，直接在运行时从目录里挑一张真的存在的 ——
 * 挑不到就明确报错，让人去跑 seed，而不是事后在 404 里猜。
 */
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

export function pickDemoImage(root) {
  const dir = path.join(root, 'server', 'uploads', 'demo')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|svg)$/i.test(f)).sort()
  if (!files.length) return null
  return `/uploads/demo/${files[0]}`
}

/** 拿不到就退出并说清楚，而不是让后续断言报一个语焉不详的 404 */
export function requireDemoImage(root, scriptName) {
  const url = pickDemoImage(root)
  if (url) return url
  console.error(
    `server/uploads/demo/ 里没有可用的配图，${scriptName} 无法构造「带图的笔记」。\n` +
      '  跑一次 seed（缺目录时它会生成占位图）：npm run seed\n' +
      '  想用真照片：npm run seed:photos'
  )
  process.exit(1)
}
