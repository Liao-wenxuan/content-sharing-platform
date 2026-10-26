/**
 * 聊天消息流的时间线编排
 *
 * 抽成纯函数是为了能直接测 —— 这几件事都是「看一眼就懂、但边界容易写错」的规则：
 * 什么时候插一条时间线、什么时候把两条消息并成一组、未读分界线画在哪。
 *
 * ⚠️ 规则参考抖音 / 微信的私信，但**不是照搬**：
 * 微信的「我：」前缀在抖音没有，而且对一个 1v1 会话来说，
 * 会话列表里最后一条是谁发的其实靠气泡颜色已经能分辨了 ——
 * 所以这里只在**消息流**里分组，不在列表里加前缀。
 *
 * 三种时间线元素：
 * - `message`  一条消息。`grouped` = 可以和上一条并成一组（同一发言人、间隔够近）
 * - `time`     时间分隔线（两条消息隔太久）
 * - `unread`   未读分界线（进入会话时「以下为新消息」）
 *
 * 泛型而不是写死 `ChatMessage`：这个工具只关心
 * 「id / senderId / content / createdAt」这四个字段，
 * 多出来的（readAt、conversationId…）不该由它定义。
 */

export interface TimelineMessage {
  id: number
  senderId: number
  content: string
  createdAt: string
}

export type TimelineItem<T extends TimelineMessage = TimelineMessage> =
  | { kind: 'message'; key: string; message: T; grouped: boolean }
  | { kind: 'time'; key: string; at: string }
  | { kind: 'unread'; key: string; count: number }

export interface TimelineOptions {
  /**
   * 第一条未读消息的下标。
   *
   * null = 本次进入会话没有未读（所以不画分界线）。
   * 0    = 加载到的第一条就是未读 —— 分界线画在最上面，
   *        下面全部是新的（未读比一屏还多时就是这个情况）。
   */
  unreadStartIndex?: number | null
  /**
   * 超过这个间隔就插一条时间分隔线。
   * 默认 5 分钟 —— 再密就没必要标时间，再疏就该标日期了（那是另一套规则）。
   */
  timeGapMs?: number
  /**
   * 同一个人连续发、间隔小于这个值，就并成一组（不重复画头像）。
   * 和 timeGapMs 同值：超过 5 分钟的同名消息，中间显然插了别的事，
   * 不该并成一组。
   */
  groupGapMs?: number
}

const DEFAULT_TIME_GAP = 5 * 60 * 1000

/** 时间戳 → 毫秒。解析失败返回 NaN（调用方按「间隔未知」处理） */
function ms(at: string): number {
  return new Date(at).getTime()
}

/**
 * 把消息列表编排成时间线。
 *
 * @param messages 按时间正序的消息（旧的在前）—— 和服务端返回的顺序一致
 */
export function buildTimeline<T extends TimelineMessage>(
  messages: T[],
  options: TimelineOptions = {}
): TimelineItem<T>[] {
  const timeGap = options.timeGapMs ?? DEFAULT_TIME_GAP
  const groupGap = options.groupGapMs ?? timeGap
  const unreadAt = options.unreadStartIndex ?? null

  const items: TimelineItem<T>[] = []
  let prev: T | null = null

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    // 未读分界线：画在第一条未读消息**之前**
    if (unreadAt !== null && i === unreadAt) {
      items.push({ kind: 'unread', key: `unread-${m.id}`, count: messages.length - i })
    }

    const now = ms(m.createdAt)
    const prevAt = prev ? ms(prev.createdAt) : NaN

    // 时间分隔线：和上一条隔太久
    const needTime =
      prev !== null && Number.isFinite(now) && Number.isFinite(prevAt) && now - prevAt > timeGap
    if (needTime) {
      items.push({ kind: 'time', key: `time-${m.id}`, at: m.createdAt })
    }

    // 分组：同一个人 + 间隔够近 + 中间没有插过时间线
    const grouped =
      prev !== null &&
      !needTime &&
      prev.senderId === m.senderId &&
      Number.isFinite(now) &&
      Number.isFinite(prevAt) &&
      now - prevAt <= groupGap

    items.push({ kind: 'message', key: `m-${m.id}`, message: m, grouped })
    prev = m
  }

  return items
}

/**
 * 找到「第一条未读消息」在列表里的下标。
 *
 * @param messages  按时间正序的消息
 * @param unreadCount 会话列表里记的未读数
 *
 * 未读消息永远是**最后** unreadCount 条 —— 对方发的消息按时间排在后面。
 * 如果未读数比加载到的条数还多（未读比一屏还多），
 * 下标就是 0：加载到的这些**全是**未读，分界线画在最上面。
 */
export function unreadStartIndexOf(messages: { id: number }[], unreadCount: number): number | null {
  if (unreadCount <= 0) return null
  return Math.max(0, messages.length - unreadCount)
}
