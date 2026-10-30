import type { Ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from '@/utils/element'
import { conversationsApi } from '@/api/conversations'
import { useAuthStore } from '@/stores/auth'
import { useLoginHint } from '@/utils/login-hint'

/**
 * 「给某人发消息」这个动作的完整流程
 *
 * **谁跟谁能聊，这条规则只在服务端有一份**（canStartChat）。
 * 所以这里不自己判断「没关注就不该能聊」——
 * 客户端自己判断的话，「已经聊过就豁免」这条就会被漏掉：
 * 明明能聊，却还被要求「先关注」才肯放行。
 *
 * 所以做法是**先问服务端**：试着建一次会话。
 * - 建得起来（已经聊过）→ 直接开聊，不该多问用户一句
 * - 被拒（还没聊过、也没关注）→ 这时才问用户要不要关注
 *
 * 确认过之后，关注 + 开聊一口气完成，不把人扔回列表里让他自己再找一次。
 * 关注是社交动作，不能静悄悄地替用户做，所以要先确认一句。
 */
export function useChatEntry(options: {
  peerId: Ref<number | null>
  nickname: Ref<string | null>
  /** 关注动作；返回 false 表示没关注成（失败或用户取消） */
  follow: () => Promise<boolean>
}) {
  const router = useRouter()
  const auth = useAuthStore()
  const { promptLogin } = useLoginHint()

  /**
   * 试着建会话并跳过去。
   *
   * 返回三态而不是布尔值 —— 「被门槛拒绝」和「别的原因失败」要走的路完全不同：
   * 前者该去问用户「要不要关注」，后者该直接报错。
   * 用一个布尔值承载两种语义，就会把 500 错误也带进确认框里。
   */
  type OpenResult = 'opened' | 'gated' | 'failed'

  async function tryOpen(peerId: number): Promise<OpenResult> {
    try {
      await conversationsApi.create(peerId)
      router.push({ path: '/messages', query: { peer: String(peerId) } })
      return 'opened'
    } catch (err: any) {
      if (err?.response?.status === 403) return 'gated'
      ElMessage.error(err?.response?.data?.message || '无法发起会话')
      return 'failed'
    }
  }

  /**
   * 发起一次私聊。
   *
   * 三条路径：
   * - 没登录     → 提示并送去登录页
   * - 服务端放行 → 直接开聊（已经聊过的人走这条）
   * - 被门槛拦下 → 确认一下，确认后关注并开聊
   */
  async function start(): Promise<boolean> {
    const peerId = options.peerId.value
    if (!peerId) return false

    if (!auth.isLoggedIn) {
      promptLogin('发消息')
      return false
    }

    const first = await tryOpen(peerId)
    if (first === 'opened') return true
    // 别的原因失败（比如 500）：直接报错，别问「要不要关注」—— 跟关注没关系
    if (first === 'failed') return false

    // 到这儿说明被门槛拦下了：还没聊过，而且发起方没关注对方
    const nickname = options.nickname.value ?? '对方'
    try {
      await ElMessageBox.confirm(
        `发消息前需要先关注「${nickname}」，关注之后就能开聊了。`,
        '需要先关注对方',
        {
          confirmButtonText: '关注并发送',
          cancelButtonText: '再想想',
          type: 'info'
        }
      )
    } catch {
      // 用户点了「再想想」：什么都不做，别硬推
      return false
    }

    const followed = await options.follow()
    if (!followed) return false

    return (await tryOpen(peerId)) === 'opened'
  }

  return { start }
}
