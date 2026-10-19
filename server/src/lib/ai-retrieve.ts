/**
 * AI 问答的**检索层**：把一句自然语言问题变成站内的笔记 / 话题 / 用户。
 *
 * 为什么要自己检索而不是直接问模型：
 * 这个项目是**离线可跑**的（clone 下来 npm install 就能起），
 * 而且站内笔记就是它唯一的知识来源。视频里那种「答案 + 笔记引用 +
 * 日期 + 互动数」的形态，本身就是检索式问答 —— 每条答案都能点回原帖核对。
 * 所以这里做的是：**先从库里捞出证据，再组织答案**。
 * 有 LLM key 时它负责把证据写成自然语言，没有 key 时它就是组织者。
 *
 * 关键词怎么切：中文没有空格，又不引分词库（不想为了一个搜索框加 10MB 依赖）。
 * 这里用「整段 + 二元组（2-gram）」的组合：
 *   - 整段命中是强信号（比如用户直接复制了一个话题名）
 *   - 2-gram 命中是弱信号，但能覆盖「如何匹配兴趣」这种没有空格的句子
 * 二元组会产生噪音（「如何」会命中一堆），所以弱信号权重压得很低，
 * 真正的排序主力是「命中了几个不同的关键词」和「互动量」。
 */
import db from './db'

/** 常见疑问词 / 无信息词，切词时先剔掉 */
const STOPWORDS = new Set([
  '如何',
  '怎么',
  '怎样',
  '什么',
  '哪些',
  '哪里',
  '为什么',
  '为何',
  '可以',
  '能否',
  '是不是',
  '有没有',
  '我想',
  '我想知道',
  '想知道',
  '推荐',
  '给我',
  '一下',
  '请问',
  '的话',
  '这个',
  '那个',
  '以及',
  '并且',
  '还是',
  '应该',
  '需要',
  '怎么办',
  '好不好',
  '吗',
  '呢',
  '啊',
  '吧'
])

/** CJK 统一表意文字（基本区 + 扩展 A）。用来判断二元组该不该切 */
const CJK_CHAR = /[\u3400-\u9fff]/

/**
 * 二元组只在**两个汉字之间**切。
 *
 * 为什么不能用「任意相邻两字符」：
 * 数字和拉丁字母不是词。一个 13 位的毫秒时间戳 `1792376026411` 会被切成
 * 12 个数字二元组（`17`、`79`、`92`……），而这些串在任何带时间戳的文本里
 * 都可能出现 —— 召回门槛只要 3 个弱命中，于是「站内绝对没有」的问题
 * 会随机命中一条毫不相关的笔记。
 *
 * 这不是假想：CI 里 e2e 几乎每套都会把 `Date.now()` 写进笔记正文，
 * 带着时间戳的笔记一多，问「量子纠缠拓扑不变量」就能撞出 1 条，
 * 答案于是自信地说「站内找到 1 条相关笔记」并附上引用。
 *
 * 纯数字 / 纯字母的短词（「2024」「iPhone15」）不受影响：
 * 它们走「≤8 字整体保留」那条路，本来就是强词。
 */
function isCjk(ch: string): boolean {
  return CJK_CHAR.test(ch)
}

export interface AiPostSource {
  type: 'post'
  id: number
  content: string
  topicTag: string | null
  authorNickname: string
  authorAvatar: string | null
  createdAt: string
  likeCount: number
  commentCount: number
  score: number
}

export interface AiTopicSource {
  type: 'topic'
  id: number
  name: string
  postCount: number
  likeCount: number
  score: number
}

export interface AiUserSource {
  type: 'user'
  id: number
  nickname: string
  avatar: string | null
  postCount: number
  likeCount: number
  score: number
}

export type AiSource = AiPostSource | AiTopicSource | AiUserSource

export interface RetrieveResult {
  posts: AiPostSource[]
  topics: AiTopicSource[]
  users: AiUserSource[]
  /** 实际用于检索的关键词，前端会显示「我是按这几个词找的」 */
  keywords: string[]
  /** 整段原句（强信号） */
  phrase: string
}

/**
 * 反复剥掉片段**前后**的停用词。
 *
 * 为什么要剥而不是整段丢：
 *   - 整段丢的话「如何搭配」会被丢掉 —— 但用户真正想问的是「搭配」
 *   - 只查停用词表的话「我想知道穿搭」会留下「我想知道」这种噪音
 * 剥完再判空，两种情况都照顾到了：
 *   「如何搭配」→「搭配」，「推荐穿搭」→「穿搭」，「我想知道」→ 空（丢弃）
 *
 * 长度必须严格大于停用词本身，否则「推荐」会被剥成空 ——
 * 而「推荐」单独出现时是个有意义的查询词。
 */
function stripStopwords(segment: string): string {
  let s = segment
  let changed = true
  while (changed) {
    changed = false
    for (const w of STOPWORDS) {
      if (s.length > w.length && s.startsWith(w)) {
        s = s.slice(w.length)
        changed = true
        break
      }
      if (s.length > w.length && s.endsWith(w)) {
        s = s.slice(0, s.length - w.length)
        changed = true
        break
      }
    }
  }
  return s
}

/**
 * 从问题里切出检索词。
 *
 * 规则：
 *   1. 标点、空白全部换成分隔符
 *   2. 剥掉前后停用词（「如何搭配」→「搭配」）
 *   3. 长度 ≤ 8 的片段整体作为一个词（话题名、专有名词多在这一档），
 *      同时也切二元组提高召回（「咖啡拉花」整体匹配不到时还能靠「咖啡」命中）
 *   4. 更长的片段只切二元组，且**只在两个汉字之间切**（数字/拉丁不算词，见 isCjk）
 *   5. 单字不要（中文单字噪音太大）
 *
 * 纯函数，不碰 DB —— 这样能单独测，也能在前端复用同一套口径。
 */
export function extractKeywords(query: string): string[] {
  const cleaned = query.replace(
    /[，。？！、；：""''''（）()《》【】[\]{}<>/\\|~`@#$%^&*+=?!,.;:\s]+/g,
    ' '
  )
  const segments = cleaned.split(/\s+/).filter(Boolean)
  const out = new Set<string>()

  for (const raw of segments) {
    const seg = stripStopwords(raw)
    if (seg.length < 2) continue
    /*
     * 8 字以内的片段**整体保留**，更长的只取二元组。
     *
     * 为什么不能一刀切「4 字以内才整体保留」：
     * 「雾岛回声标记」是 5 字，正好掉进「只切二元组」那一档 ——
     * 于是强关键词（3 字以上）变成 0，只剩 '雾岛'、'标记' 两个弱命中，
     * 达不到门槛，自己造的笔记反而查不到自己。
     *
     * 而 8 字以上的（整句话）整体保留没有意义：它几乎不可能被完整命中，
     * 当它是弱信号就行，二元组负责兜底。
     */
    if (seg.length <= 8) out.add(seg)
    for (let i = 0; i < seg.length - 1; i++) {
      // 只在两个汉字之间切，见 isCjk 上面的说明
      if (!isCjk(seg[i]) || !isCjk(seg[i + 1])) continue
      const gram = seg.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) out.add(gram)
    }
  }

  return [...out]
}

/** LIKE 通配符转义：搜 "100%" 时不转义会变成 "%" 通配，把整表捞出来 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/** 二元组是弱信号，权重低；长词是强信号，权重高 */
function termWeight(term: string): number {
  if (term.length >= 4) return 6
  if (term.length === 3) return 4
  return 1
}

interface RawRow {
  id: number
  user_id: number
  content: string
  topic_tag: string | null
  created_at: string
  nickname: string
  avatar: string | null
  like_count: number
  comment_count: number
}

/**
 * 检索站内内容。
 *
 * @param query  用户的问题
 * @param limit  最多返回多少条笔记
 */
export function retrieve(query: string, limit = 6): RetrieveResult {
  const phrase = query.trim()
  const keywords = extractKeywords(phrase)

  const empty: RetrieveResult = { posts: [], topics: [], users: [], keywords, phrase }
  if (!phrase || keywords.length === 0) return empty

  // 关键词太多会让 SQL 变得很长而且噪音上升，只取前 12 个
  const terms = keywords.slice(0, 12)
  const patterns = terms.map(likePattern)

  // 拼 OR 条件：正文 / 话题标签 / 作者昵称 任一命中
  const ors = terms
    .map(
      () =>
        `(p.content LIKE ? ESCAPE '\\' OR p.topic_tag LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\')`
    )
    .join(' OR ')
  const params = patterns.flatMap((p) => [p, p, p])

  let rows: RawRow[] = []
  try {
    rows = db
      .prepare(
        `
        SELECT
          p.id, p.user_id, p.content, p.topic_tag, p.created_at,
          u.nickname, u.avatar,
          (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
          (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE ${ors}
        LIMIT 400
      `
      )
      .all(...params) as RawRow[]
  } catch (err) {
    console.error('[AI Retrieve Error]', err)
    return empty
  }

  // 打分：命中了几个**不同的**关键词 > 命中了多少次（避免一篇笔记刷同一条重复词）
  const scored = rows
    .map((r) => {
      const hay = `${r.content}\n${r.topic_tag ?? ''}\n${r.nickname}`
      let score = 0
      let strongHits = 0
      let weakHits = 0
      const hitTerms = new Set<string>()
      for (const t of terms) {
        if (!hay.includes(t)) continue
        hitTerms.add(t)
        if (t.length >= 3) strongHits++
        else weakHits++
        score += termWeight(t)
      }
      // 整段命中是强信号：用户很可能直接复制了一个话题名或标题
      const phraseHit = hay.includes(phrase)
      if (phraseHit) score += 20
      // 互动量只做微调，避免「关键词命中但没人看」的内容压过「都命中但很热」的内容
      score += Math.log2(1 + r.like_count + r.comment_count * 2)
      return { r, score, hits: hitTerms.size, strongHits, weakHits, phraseHit }
    })
    /*
     * 召回门槛 —— 这一条是「站内没有」能成立的前提。
     *
     * 二元组匹配很宽：问「量子纠缠拓扑不变量」会被切成十几个二元组，
     * 其中随便一个撞上库里的内容，这条笔记就进了候选。
     * 那样的话**站内几乎永远「有」答案** —— 答案看起来带着出处，
     * 其实是在硬凑，这比明说「没有」糟糕得多。
     *
     * 所以要有一个门槛：
     *   - 命中 ≥1 个强关键词（3 字以上，话题名/专有名词多在这一档）
     *   - 或命中 ≥3 个不同的弱关键词（二元组）
     *   - 或整段命中
     */
    .filter((x) => x.phraseHit || x.strongHits >= 1 || x.weakHits >= 3)
    // 先按命中关键词数排，再按分数排 —— 覆盖度比热度重要
    .sort((a, b) => b.hits - a.hits || b.score - a.score)

  const posts: AiPostSource[] = scored.slice(0, limit).map(({ r, score }) => ({
    type: 'post',
    id: r.id,
    content: r.content,
    topicTag: r.topic_tag,
    authorNickname: r.nickname,
    authorAvatar: r.avatar,
    createdAt: r.created_at,
    likeCount: r.like_count,
    commentCount: r.comment_count,
    score: Math.round(score * 100) / 100
  }))

  // 话题 / 用户：从命中的笔记里聚合
  const topicMap = new Map<string, { count: number; likes: number; score: number }>()
  const userMap = new Map<
    number,
    { nickname: string; avatar: string | null; count: number; likes: number; score: number }
  >()

  for (const { r, score } of scored) {
    if (r.topic_tag) {
      const t = topicMap.get(r.topic_tag) ?? { count: 0, likes: 0, score: 0 }
      t.count += 1
      t.likes += r.like_count
      t.score += score
      topicMap.set(r.topic_tag, t)
    }
    const u = userMap.get(r.user_id) ?? {
      nickname: r.nickname,
      avatar: r.avatar,
      count: 0,
      likes: 0,
      score: 0
    }
    u.count += 1
    u.likes += r.like_count
    u.score += score
    userMap.set(r.user_id, u)
  }

  const topics: AiTopicSource[] = [...topicMap.entries()]
    .map(([name, t]) => ({
      type: 'topic' as const,
      id: 0,
      name,
      postCount: t.count,
      likeCount: t.likes,
      score: Math.round(t.score * 100) / 100
    }))
    .sort((a, b) => b.postCount - a.postCount || b.score - a.score)
    .slice(0, 4)

  const users: AiUserSource[] = [...userMap.entries()]
    .map(([id, u]) => ({
      type: 'user' as const,
      id,
      nickname: u.nickname,
      avatar: u.avatar,
      postCount: u.count,
      likeCount: u.likes,
      score: Math.round(u.score * 100) / 100
    }))
    .sort((a, b) => b.postCount - a.postCount || b.score - a.score)
    .slice(0, 4)

  return { posts, topics, users, keywords: terms, phrase }
}
