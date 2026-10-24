/**
 * 两张图的逐像素比对
 *
 * 抽出来是因为有两个地方要它：
 *   - `scripts/reveal-shot.mjs`（重拍 README 配图时断言降级路径）
 *   - `scripts/reveal-smoke.mjs`（e2e，让 CI 也守住这条）
 *
 * 放在 e2e 里才是真的守住：只放在重拍脚本里的话，
 * 那个断言只会在「有人重拍截图」时才跑 ——
 * 而重拍是低频事件，回归可能溜过去几个月。
 */

/**
 * 比两张图，返回差异统计。
 *
 * @param {import('playwright').Page} page 一个还开着的页面（用来当 canvas 宿主）
 * @param {Buffer} bufA
 * @param {Buffer} bufB
 */
export async function pixelDiff(page, bufA, bufB) {
  return page.evaluate(
    async ([da, db]) => {
      const load = (d) =>
        new Promise((res, rej) => {
          const img = new Image()
          img.onload = () => res(img)
          img.onerror = () => rej(new Error('decode failed'))
          img.src = 'data:image/png;base64,' + d
        })
      const [ia, ib] = await Promise.all([load(da), load(db)])
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { sizeMismatch: true, w1: ia.width, h1: ia.height, w2: ib.width, h2: ib.height }
      }
      const c1 = document.createElement('canvas')
      const c2 = document.createElement('canvas')
      c1.width = c2.width = ia.width
      c1.height = c2.height = ia.height
      c1.getContext('2d').drawImage(ia, 0, 0)
      c2.getContext('2d').drawImage(ib, 0, 0)
      const p1 = c1.getContext('2d').getImageData(0, 0, c1.width, c1.height).data
      const p2 = c2.getContext('2d').getImageData(0, 0, c2.width, c2.height).data
      let diffPixels = 0
      let maxDelta = 0
      for (let i = 0; i < p1.length; i += 4) {
        const d =
          Math.abs(p1[i] - p2[i]) + Math.abs(p1[i + 1] - p2[i + 1]) + Math.abs(p1[i + 2] - p2[i + 2])
        if (d !== 0) {
          diffPixels++
          if (d > maxDelta) maxDelta = d
        }
      }
      return { diffPixels, totalPixels: p1.length / 4, maxDelta }
    },
    [bufA.toString('base64'), bufB.toString('base64')]
  )
}

/**
 * 判据：差异不得大幅超过「同一个状态连拍两次」的渲染噪声。
 *
 * 为什么不直接比字节数：字节数受 PNG 编码器、压缩参数、元数据影响 ——
 * 它变了不代表画面变了。
 *
 * 为什么不用「最大通道差」当判据：那是**单个像素**的统计量，
 * 一个恰好落在字形边缘的抗锯齿像素就能把它顶到 97/255
 * （实测同参数连拍的基线本身就在 3~97 之间跳）。
 * 像素**数量**才是稳的指标。
 *
 * @param {{diffPixels:number,totalPixels:number,maxDelta:number}} noise 同参数连拍两次的差异
 * @param {{diffPixels:number,totalPixels:number,maxDelta:number}} diff  真正要比的那两张
 */
export function judgeDiff(noise, diff) {
  if (diff.sizeMismatch || noise.sizeMismatch) {
    return { ok: false, reason: '两张图尺寸不一样，没法比', maxPixels: 0 }
  }
  // 门槛 = 噪声的 10 倍，带一个下限（免得噪声偶然为 0 时门槛过紧）
  const maxPixels = Math.max(noise.diffPixels * 10, 500)
  const maxRatio = 0.1 // 百分比
  const ratio = diff.totalPixels ? (diff.diffPixels / diff.totalPixels) * 100 : 0
  const ok = diff.diffPixels <= maxPixels && ratio < maxRatio
  return {
    ok,
    maxPixels,
    maxRatio,
    ratio,
    reason: ok
      ? ''
      : `差 ${diff.diffPixels} 像素（${ratio.toFixed(4)}%）/ 门槛 ${maxPixels} 像素（${maxRatio}%）`
  }
}
