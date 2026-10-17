/**
 * 把「控制台异常」分成**真问题**和**已知的第三方噪音**两堆。
 *
 * 噪音是 Element Plus 在卸载期的两个内部竞态，dev server 下偶发：
 *
 *   TypeError: Cannot read properties of null (reading 'ce')   at renderSlot
 *   TypeError: Cannot read properties of undefined (reading 'indexOf')
 *       at Object.removeChild [as unregisterPane]
 *
 * 栈全在 node_modules/.vite/deps/ 里，不在本项目任何一行代码上 ——
 * ChatView / DesktopView 用到的只有 avatar / tag / icon / badge /
 * button / input / switch / descriptions，一个 popper 系组件都没有。
 *
 * 成因是 vite dev 的依赖预构建：重新打包依赖会让组件拿到不同的一份
 * 模块实例，卸载时 popper 的 content 引用已经没了。生产构建不会有
 * 这个问题（模块只有一份）。
 *
 * ⚠️ 为什么不直接丢弃：
 * 这个守卫最早写成 `.catch(() => {})` 时栽过一次 ——
 * 「点不动」和「点了没反应」在报告里长得一模一样，因为两者都被统一
 * 成了沉默。丢弃噪音如果连同原文一起丢，就是把同一个错误再犯一次。
 *
 * 所以：原文照打，只是单独归一堆、不参与判定。
 */
const EP_TEARDOWN = /renderSlot|unregisterPane/

export function splitEpNoise(errors) {
  const noise = errors.filter((e) => EP_TEARDOWN.test(e))
  const real = errors.filter((e) => !EP_TEARDOWN.test(e))
  return { real, noise }
}

/** 统一的打印 + 判定口径。返回「有没有真问题」 */
export function reportErrors(errors, { limit = 8, noiseLimit = 4 } = {}) {
  const { real, noise } = splitEpNoise(errors)

  if (real.length === 0) {
    console.log('  console error / 失败请求：0')
  } else {
    console.log(`  有 ${real.length} 条异常：`)
    real.slice(0, limit).forEach((e) => console.log('   - ' + e))
  }
  if (noise.length) {
    console.log(`  另有 ${noise.length} 条 Element Plus 卸载期噪音（不计入失败）：`)
    noise.slice(0, noiseLimit).forEach((e) => console.log('   ~ ' + e))
  }
  return real.length === 0
}
