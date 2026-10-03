/**
 * 前端单测的全局准备
 *
 * 目前只做一件事：吞掉 Vue 的生命周期告警。
 *
 * 为什么要吞：`useChat.ts` / `useWebSocket.ts` 是模块级单例，
 * 在模块顶层就调了 onUnmounted（组件之外的场景 Vue 只能警告不能报错）。
 * 这些 composable 的测试本来就不挂组件，于是每次 import 都会刷一条
 * "[Vue warn]: onUnmounted is called when there is no active component instance"。
 *
 * 为什么不改成"把 useChat 挂在组件里再测"：那测的就不是聊天逻辑本身，
 * 而是"组件有没有正确调用聊天逻辑"，测的东西会变味。
 * 告警是预期内的噪音，只过滤这一条，其余 warn 照常抛出。
 */

const realWarn = console.warn

console.warn = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : ''
  if (first.includes('onUnmounted is called when there is no active component instance')) {
    return
  }
  realWarn(...args)
}
