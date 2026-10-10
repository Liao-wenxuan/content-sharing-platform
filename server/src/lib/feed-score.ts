/**
 * 推荐打分
 *
 * 这个文件里**没有任何一行 SQL，也没有任何一个 db 引用**，全是纯函数。
 * 不是为了好看，是因为推荐分是最该被单独钉死的东西：
 * 一旦它和取数、鉴权、路由搅在一起，调参数就得连着跑起整个服务，
 * 「热度系数该给多少」这种问题就没法快速试了。
 *
 * ---
 *
 * ## 一句话说清它做什么
 *
 * 给一篇笔记算一个分，让「你可能想看的」排在前面。
 *
 *   score = 兴趣匹配 + 作者匹配 + 新鲜度 + 热度 + 社交加成 − 自推惩罚
 *
 * 每个加数都会被拆成独立的 `part`，最后 `reason` 取最大的那一个当理由。
 * 这不是锦上添花：**不可解释的推荐用户就没法纠正**，
 * 用户纠不了，负反馈就收不上来，整个系统就是个黑盒。
 *
 * ---
 *
 * ## 几个系数为什么是这个值
 */

/** 新鲜度半衰期：48 小时前的笔记，权重砍到一半 */
export const RECENCY_HALF_LIFE_HOURS = 48

/**
 * 热度压缩上限。
 *
 * 先说不用 log 会怎样：一篇 1000 赞的笔记线性拿 1000 分，
 * 而所有兴趣项加起来撑死几十 —— 首屏会被同一篇霸满，
 * 用户看到的不是「推荐」是「热榜」。取 log 之后 1000 赞 ≈ 6.9，
 * 10 赞 ≈ 2.3，差距还在但不悬殊。
 */
const POPULARITY_SCALE = 3

/** 兴趣类加数的上限：一条笔记无论多合口味，也最多加这么多 */
const AFFINITY_CAP = 12

/**
 * 社交加成：我关注的人的笔记。
 *
 * ⚠️ 定成扁平的小值（而不是「比兴趣满级还高」）是有理由的：
 * **订阅内容已经有关注流单独承载了**。如果发现流再给关注一个很高的加成，
 * 用户打开首页看到的就是一屏自己关注的人 —— 那不是推荐，是关注流的重复，
 * 而且是用户没主动选就被塞给他们的那一份。
 *
 * 换成 8 的时候，实际效果是：只要关注了 5 个人，发现流首屏 12 条里
 * 有 11 条带着「你关注了这位作者」这一个理由 ——
 * 推荐理由失去了信息量，整页看起来也像坏了。
 *
 * 现在的定位是「关注让你在同等条件下略微靠前」，而不是「关注独占首屏」。
 */
const SOCIAL_BONUS = 5

/** 自推惩罚：自己的笔记降权，但不下线（发布后还得看得见） */
const SELF_PENALTY = 6

/**
 * 被屏蔽笔记的分数。
 *
 * 定成 -1000 而不是 0：0 可能和「冷启动的空白笔记」同分，
 * 那就还是可能排到首屏。取一个业务上不可能达到的低分，
 * 就算是「它还在候选集里（能回答为什么不见了），但它一定排在最后」。
 */
export const MUTED_SCORE = -1000

/**
 * 行为信号权重表 —— 画像用（见 feed-profile.ts）。
 *
 * 收藏 3 > 评论 2 > 关注 1.5 > 点赞 1 > 浏览 0.2。
 * 关注排在点赞前面：关注是一个**明确的、一次性的主动决定**，
 * 点赞可能只是手滑，浏览更是被动得多。
 */
export const SIGNAL_WEIGHT = {
  favorite: 3,
  comment: 2,
  follow: 1.5,
  like: 1,
  view: 0.2,
  /** 负反馈：权重表里留着是为了让「信号」这个概念完整，屏蔽本身走硬过滤 */
  notInterested: -10
} as const

/**
 * 热度：加权互动数的对数压缩。
 *
 * 权重 收藏 3 > 评论 2 > 点赞 1。收藏最重：它是用户主动「留下」的行为，
 * 而点赞更接近随手一划。
 *
 * ⚠️ 这里**不能**只用收藏数当热度主项：库里很多内容有 0 收藏，
 * 只看它会让「几乎没人互动的新内容」永远排不上，等于把冷启动堵死。
 * 所以是加权求和再取 log，不是取 max。
 */
export function popularityScore(
  likeCount: number,
  commentCount: number,
  favoriteCount: number
): number {
  const raw = likeCount + commentCount * 2 + favoriteCount * 3
  if (raw <= 0) return 0
  return Math.log1p(raw) * POPULARITY_SCALE
}

/**
 * 新鲜度：按半衰期指数衰减。
 *
 * 用 `0.5 ^ (小时数 / 半衰期)` 而不是 `1 / (1 + 小时数)`：
 * 后者是调和衰减，头几个小时掉得非常猛（0 小时 1.0，1 小时 0.5），
 * 一条刚发的笔记会被一小时内发过的十几条一起埋掉。
 * 指数衰减在前半衰期内几乎持平，正好是「今天的东西今天看」的意思。
 */
export function recencyScore(createdAtMs: number, nowMs: number): number {
  const ageHours = Math.max(0, (nowMs - createdAtMs) / 3_600_000)
  return Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS)
}

/** 一篇待排序的笔记（已从库里取出的扁平字段，不是 Post 对象） */
export interface FeedCandidate {
  id: number
  /** 作者 id —— 打分里的「作者匹配」和「自推惩罚」都用它 */
  authorId: number
  topicTag: string | null
  likeCount: number
  commentCount: number
  favoriteCount: number
  createdAt: number
}

/** 兴趣画像。Map 而不是对象：话题/作者 id 可能形如 `__proto__`，对象会中招 */
export interface FeedProfile {
  /** 话题 → 权重（收藏美食 ×3 两次，权重就高） */
  topicWeights: Map<string, number>
  /** 作者 id → 权重 */
  authorWeights: Map<number, number>
  /** 我关注的人 */
  followedAuthors: Set<number>
  /** 我不喜欢的作者（「不喜欢这个作者」反馈推出来的） */
  mutedAuthors: Set<number>
  /** 我屏蔽过的笔记 */
  mutedPosts: Set<number>
}

/** 空画像：新用户 / 游客 / 没有任何行为的账号 */
export function emptyProfile(): FeedProfile {
  return {
    topicWeights: new Map(),
    authorWeights: new Map(),
    followedAuthors: new Set(),
    mutedAuthors: new Set(),
    mutedPosts: new Set()
  }
}

/**
 * 兴趣匹配：把画像权重归一化到 0~1。
 *
 * 除以最大值而不是求和：求和的话画像里标签越多，每个标签被摊得越薄，
 * 「什么都看点」的用户会发现什么都推不准 —— 但这恰恰不该由画像惩罚。
 * 除以最大值保证「你最爱的那个标签」永远拿满 1 分。
 */
export function affinityScore(rawWeight: number, maxWeight: number): number {
  if (rawWeight <= 0 || maxWeight <= 0) return 0
  return Math.min(1, rawWeight / maxWeight)
}

export interface ScorePart {
  part: string
  value: number
}

export interface ScoredCandidate {
  id: number
  score: number
  reason: string | null
  parts: ScorePart[]
}

/**
 * 给单篇笔记打分。
 *
 * @param viewerId 当前登录用户（游客传 null）。自推惩罚靠它判断
 *   「这篇是不是我发的」—— 放进 profile 会有两个问题：
 *   profile 是「关于用户」的画像，而 viewerId 是「这次请求是谁」；
 *   两者在缓存复用时会打架。分开传最不容易错。
 *
 * ⚠️ 画像的最大权重在这里现算，所以调用方**必须**先把 profile 整体算完再逐篇打分，
 * 不能边遍历边增量更新 —— 否则第一篇用的是旧 max、后面的是新 max，
 * 同一批笔记的分数不在同一把尺子上，排序结果没法复现。
 */
export function scoreCandidate(
  c: FeedCandidate,
  profile: FeedProfile,
  nowMs: number,
  viewerId: number | null
): ScoredCandidate {
  // 兜底：被屏蔽的东西即使混进了候选集，也不可能排上来。
  //
  // 正常路径下这里**根本不会触发** —— buildCandidates 已经在 SQL 里
  // 把屏蔽的笔记和作者排除了。这里保留是因为打分函数不该假设
  // 「调用方一定已经过滤过」：漏过滤一次的表现是「屏蔽内容偶尔冒出来」，
  // 而这种 bug 极难复现（取决于候选集凑巧多大）。
  if (profile.mutedPosts.has(c.id)) {
    return {
      id: c.id,
      score: MUTED_SCORE,
      reason: '你屏蔽过这篇',
      parts: [{ part: 'muted', value: MUTED_SCORE }]
    }
  }
  if (profile.mutedAuthors.has(c.authorId)) {
    return {
      id: c.id,
      score: MUTED_SCORE,
      reason: '你屏蔽过这位作者',
      parts: [{ part: 'muted', value: MUTED_SCORE }]
    }
  }

  const maxTopic = maxOf(profile.topicWeights)
  const maxAuthor = maxOf(profile.authorWeights)

  // ⚠️ topic 和 fresh 的上限**必须相等**，这不是随手取的数字。
  //
  // 兴趣上限一旦低于新鲜度上限，就有个连锁后果：
  // 所有刚发的笔记新鲜度都拉满，于是「刚刚发布」永远是理由，
  // 「你常看美食」这种真正有信息量的理由一次都轮不上 ——
  // 推荐理由就退化成了一句废话，而理由是用来让用户纠正推荐的。
  //
  // 两者相等时，命中满级兴趣的笔记和刚发的笔记同分；
  // 同分按 parts 的声明顺序取（stable sort），topic 在 fresh 前面，
  // 于是更具体的那个理由胜出。
  const topicPart =
    c.topicTag != null && c.topicTag !== ''
      ? affinityScore(profile.topicWeights.get(c.topicTag) ?? 0, maxTopic) * (AFFINITY_CAP * 0.6)
      : 0
  const authorPart =
    affinityScore(profile.authorWeights.get(c.authorId) ?? 0, maxAuthor) * (AFFINITY_CAP * 0.35)
  const freshPart = recencyScore(c.createdAt, nowMs) * (AFFINITY_CAP * 0.6)
  const popPart = popularityScore(c.likeCount, c.commentCount, c.favoriteCount)
  const socialPart = profile.followedAuthors.has(c.authorId) ? SOCIAL_BONUS : 0

  const parts: ScorePart[] = [
    { part: 'topic', value: topicPart },
    { part: 'author', value: authorPart },
    { part: 'fresh', value: freshPart },
    { part: 'popularity', value: popPart },
    { part: 'social', value: socialPart }
  ]

  let score = parts.reduce((s, p) => s + p.value, 0)

  // 自推惩罚：自己的笔记往下压，但不下线 —— 发布完还得在
  // 「我的主页」和首页里看得见自己刚发的东西。
  if (viewerId != null && c.authorId === viewerId) {
    score -= SELF_PENALTY
    parts.push({ part: 'self', value: -SELF_PENALTY })
  }

  return {
    id: c.id,
    score,
    reason: topReason(parts, c, profile),
    parts
  }
}

/** 取最大的一个权重。空 Map 时返回 0，除法那边就不用特判 Infinity */
function maxOf(m: Map<string | number, number>): number {
  let max = 0
  for (const v of m.values()) if (v > max) max = v
  return max
}

/**
 * 推荐理由 = 贡献最大的那一项。
 *
 * 只报**一个**理由而不是全部：报三个理由用户读不完，
 * 报错的理由比不报更糟 —— 用户按「因为你关注了 XX」去点进去发现不对，
 * 下次就不信了。
 */
function topReason(parts: ScorePart[], c: FeedCandidate, profile: FeedProfile): string | null {
  const ranked = [...parts].filter((p) => p.value > 0).sort((a, b) => b.value - a.value)
  const top = ranked[0]
  if (!top) return null

  switch (top.part) {
    case 'social':
      return '你关注了这位作者'
    case 'topic':
      return c.topicTag ? `你常看「${c.topicTag}」` : null
    case 'author':
      return profile.authorWeights.has(c.authorId) ? '你常看这位作者' : null
    case 'fresh':
      return '刚刚发布'
    case 'popularity':
      return '最近很火'
    default:
      return null
  }
}

export const SCORE_PARTS = {
  AFFINITY_CAP,
  SOCIAL_BONUS,
  SELF_PENALTY,
  POPULARITY_SCALE
} as const
