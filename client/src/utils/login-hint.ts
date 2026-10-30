import { useRouter } from 'vue-router'
import { useToastStore } from '@/stores/toast'

/**
 * 「登录后才能 X」的统一出口
 *
 * **只提示不给下一步，交互就断在那里**：用户看到一句话，
 * 不知道该去哪登录，也不知道登录完还能不能回到刚才那一步。
 * 于是他关掉提示、原地不动 —— 这个动作等于没发生过。
 *
 * 所以提示和跳转必须一起做，而且要带 redirect：
 * 登录完回到刚才那页，不用重新找路。
 *
 * 为什么单独抽出来：同一个模式散在三个地方，
 * 首页做对了（提示 + 跳 + redirect），另外三处只提示 ——
 * 这种「同一件事两种做法」必然漂移，最后是差的那几处最容易被当成惯例。
 */
export function useLoginHint() {
  const router = useRouter()
  const toast = useToastStore()

  /**
   * 提示「登录后才能 X」，并把人送去登录页。
   *
   * @param action   动作名（关注 / 收藏 / 发消息…）
   * @param redirect 登录后回哪一页；不给就回当前页
   */
  function promptLogin(action: string, redirect?: string) {
    toast.show(`登录后才能${action}`, 'info')

    // 没有 router 上下文时（组件外调用 composable 的单测）只提示不跳。
    // 生产里这些都是 setup 里的调用，不会走到这个分支。
    if (!router) return
    const from = router.currentRoute?.value?.fullPath
    router.push({
      path: '/login',
      query: { redirect: redirect ?? from }
    })
  }

  return { promptLogin }
}
