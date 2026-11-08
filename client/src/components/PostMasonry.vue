<script setup lang="ts">
/**
 * 帖子瀑布流
 *
 * 首页和搜索页共用，所以从 HomeView 里抽出来。
 *
 * 分列、高度估算、关键词切分都在 utils/masonry.ts 里（纯函数，可单测），
 * 这个组件只做两件事：ResizeObserver 监听宽度 → 按结果渲染 DOM。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Star, VideoPlay, Close, ChatDotRound, Picture } from '@element-plus/icons-vue'
import type { Post } from '@/api/posts'
import { useRelativeTime } from '@/composables/useRelativeTime'
import {
  GAP,
  computeColCount,
  distributeToColumns,
  segmentByKeyword,
  avatarText
} from '@/utils/masonry'
import { useReveal } from '@/composables/useReveal'
import { useUserSettings } from '@/composables/useUserSettings'

const props = defineProps<{
  posts: Post[]
  /** 关键词：命中片段会高亮（搜索页传，首页不传） */
  highlight?: string
  /** postId → 推荐理由。推荐流专用，搜索页不传就不渲染任何东西 */
  reasons?: Record<number, string>
  /** 是否显示「不感兴趣」按钮。只有推荐流该有，搜索结果不该有 */
  dismissable?: boolean
}>()

const emit = defineEmits<{ dismiss: [postId: number] }>()

const { formatTime } = useRelativeTime()

const gridRef = ref<HTMLElement | null>(null)
const gridWidth = ref(1200)
const colCount = ref(5)
const { settings } = useUserSettings()

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (lazySupported()) {
    imageObserver = new IntersectionObserver(
      (entries) => {
        if (!imageObserver) return
        const ids: number[] = []
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const id = Number((entry.target as HTMLElement).dataset.coverId)
          if (Number.isFinite(id)) ids.push(id)
          imageObserver.unobserve(entry.target)
          observedEls.delete(entry.target)
        }
        activateCovers(ids)
      },
      { rootMargin: IMAGE_ROOT_MARGIN }
    )
    scanCovers()
  }
  if (!gridRef.value) return
  resizeObserver = new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width
    gridWidth.value = w
    colCount.value = computeColCount(w)
  })
  resizeObserver.observe(gridRef.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  imageObserver?.disconnect()
  imageObserver = null
  observedEls.clear()
})

/**
 * 卡片错峰入场。
 *
 * 观察的是 `.masonry-col`（每列一个）而不是卡片本身：
 * 瀑布流有 5 列、共 60+ 张卡，观察 60 个元素会让 IntersectionObserver
 * 每帧做 60 次回调。列只有 5 个，代价可以忽略。
 *
 * `props.posts.length > 0` 是必需的 —— 空列表时挂观察器纯属浪费，
 * 而且「有 0 张卡」这件事本身不需要任何入场动画来表达。
 */
useReveal(gridRef, () => visiblePosts.value.length > 0)

/** 有没有需要过滤的偏好。为 false 时上面直接返回原数组，省一次遍历 */
const needsFilter = computed(
  () =>
    settings.value.minorMode || settings.value.blockedTags.some((t) => t && !t.startsWith('lang:'))
)

/**
 * 内容过滤：屏蔽的话题 + 未成年人模式。
 *
 * ⚠️ 过滤发生在**分列之前**，而不是渲染时把卡片 `v-if` 掉。
 * 理由：瀑布流的高度估算依赖卡片数量和比例（`estimateHeight`），
 * 先过滤再分列，估算用的就是真实要渲染的那些卡片；
 * 先分列再隐藏的话，列高会按「其实没渲染的卡片」算，
 * 页面底部会留一大块空白，而且滚动时列会「塌」一下。
 */
const visiblePosts = computed(() => {
  const list = props.posts
  if (!needsFilter.value) return list

  const blocked = new Set(
    settings.value.blockedTags
      .filter((t) => t && !t.startsWith('lang:'))
      .map((t) => t.toLowerCase())
  )
  const minor = settings.value.minorMode

  return list.filter((p) => {
    // 屏蔽话题：大小写不敏感，用户打「美食」不该因为存的是「美食」就漏掉
    if (blocked.size > 0 && p.topicTag && blocked.has(p.topicTag.toLowerCase())) return false
    // 未成年人模式：只挡**带图**的，纯文字照常看。
    // 全挡住的话用户会以为应用坏了
    if (minor && p.imageUrls?.length) return false
    return true
  })
})

const filteredCount = computed(() => props.posts.length - visiblePosts.value.length)

/** 真正生效的屏蔽话题数（排除 lang: 标记） */
const plainBlockedCount = computed(
  () => settings.value.blockedTags.filter((t) => t && !t.startsWith('lang:')).length
)

/** 「为什么？」的展开态。默认收起 —— 大多数人不需要解释 */
const showFilterHint = ref(false)

/** 单列宽度。分列必须用它，别处再算一遍宽度的话，改了 GAP 其中一处不会跟着变 */
const colWidth = computed(() => (gridWidth.value - GAP * (colCount.value - 1)) / colCount.value)

const columns = computed(() => {
  const buckets = distributeToColumns(visiblePosts.value, colCount.value, colWidth.value)
  return buckets
})

/**
 * 封面图片的可见性闸门。
 *
 * 为什么不能只靠 `loading="lazy"`：Chrome 的原生阈值是**动态**的，
 * 会根据有效连接类型放大。Slow 4G 下阈值能到 1250px 甚至 2500px，
 * 于是 30 张卡的瀑布流在首屏就把 22 张封面全拉了下来，
 * 而视口里其实只有 8 张（线上实测 433KB 图片，占首屏流量 69%）。
 * 换句话说，原生 lazy 在弱网下**恰好反着来**：网越慢，预取越激进。
 *
 * 这里自己用一个小 rootMargin 观察 .cover，把「提前量」握在手里：
 * 视口内 + 300px 才发请求，滚动时仍有缓冲，但不会一次吃掉两屏带宽。
 * 前两行直接放行，是为了不等 IO 的首次回调（约一帧）才发起 LCP 图。
 *
 * 没有 IntersectionObserver 的环境（jsdom / 老浏览器）一律全量加载 ——
 * 降级必须是「功能照常」，不能是「图全没了」。
 */
const IMAGE_ROOT_MARGIN = '300px 0px'
const EARLY_ROWS = 2
/** 运行时判断而不是模块级常量：无 IO 的环境一律全量加载，降级不能让图全没了 */
function lazySupported(): boolean {
  return typeof IntersectionObserver !== 'undefined'
}
const activated = ref(new Set<number>())
const observedEls = new Set<Element>()
let imageObserver: IntersectionObserver | null = null

function activateCovers(ids: number[]) {
  const next = new Set(activated.value)
  let changed = false
  for (const id of ids) {
    if (!next.has(id)) {
      next.add(id)
      changed = true
    }
  }
  if (changed) activated.value = next
}

/** 没被 IO 放行的卡片仍渲染 <img>（保持占位与 alt），但不给 src，浏览器不会发请求 */
function shouldLoadCover(postId: number): boolean {
  return !lazySupported() || activated.value.has(postId)
}

function scanCovers() {
  if (!gridRef.value || !imageObserver) return
  for (const el of gridRef.value.querySelectorAll<HTMLElement>('[data-cover-id]')) {
    if (observedEls.has(el)) continue
    observedEls.add(el)
    imageObserver.observe(el)
  }
}

// 列会随窗口宽度、新一页数据、屏蔽偏好重排，重排后新出现的 .cover 要补观察。
// 只 observe 没见过的元素，所以 resize 连发也不会重复挂监听。
watch(
  columns,
  async (cols) => {
    if (!lazySupported()) return
    const early: number[] = []
    for (const col of cols) for (const item of col.slice(0, EARLY_ROWS)) early.push(item.post.id)
    activateCovers(early)
    await nextTick()
    scanCovers()
  },
  { immediate: true }
)

/**
 * 点作者跳到他的主页。
 *
 * 之前这里只有一句「个人主页跳转开发中」的 toast ——
 * 一个能被点到、点下去只会得到一句「快了」的假按钮。
 * 路由 `/user/:id` 早就存在了，缺的只是这一跳。
 *
 * 现在作者行本身就是 `<router-link>`，这个函数连同它那句提示一起删掉了：
 * 有作者就走链接，没作者就渲染成明确不可点的纯文本。
 * 保留一个「只在缺作者时才跑」的处理函数，等于留了一条平时永远走不到的分支。
 */

/**
 * 卡片封面用缩略图。
 *
 * 瀑布流每列只有约 260px，而主图长边 2000 —— 限速实测里首屏 94% 的流量
 * 是图片，而其中绝大部分像素是下到浏览器里又显示不出来的。
 *
 * `imageThumbs` 由服务端 parseThumbs 兜底填齐（缺的用原图补），
 * 所以这里**不需要**再写 `?? imageUrls[0]`：真到了没有缩略图的数据，
 * 兜底也已经在服务端做过了，再在前端补一层只会掩盖问题。
 * 但仍留一个 `||`，因为它是零成本的，而断图不是。
 */
function coverSrc(post: Post): string {
  // 视频笔记的封面是前端抽帧上传的海报；没有海报时落到占位块，
  // 而不是 <video> —— 瀑布流里嵌几十个视频解码器是性能灾难
  if (post.mediaType === 'video') {
    return post.videoPoster || ''
  }
  return post.imageThumbs?.[0] || post.imageUrls[0]
}

/** 话题标签是否命中当前搜索词 */
function tagMatched(post: Post): boolean {
  const kw = props.highlight?.trim().toLowerCase()
  if (!kw || !post.topicTag) return false
  return post.topicTag.toLowerCase().includes(kw)
}

function segments(text: string) {
  return segmentByKeyword(text, props.highlight)
}

/**
 * 图片是否已加载完成。
 *
 * 用 Set 而不是 Map/数组：只需要「在不在」这一个判断，
 * 而且 Set 的 has 是 O(1) —— 瀑布流一次能挂 60 张卡。
 *
 * ⚠️ 这是一个**只增不减**的集合。翻很多页之后它会一直涨，
 * 但它的上界是「用户看过的不同笔记数」，内存占用可以忽略；
 * 真要清就得在 postId 消失时 remove，那反而容易漏。
 */
const loadedImages = ref(new Set<number>())

function markImageLoaded(postId: number) {
  loadedImages.value.add(postId)
}

/**
 * 封面加载失败（文件被删、路径写错、磁盘清过）时退回占位块。
 *
 * 没有它的时候，浏览器会在封面区里直接渲染 alt 文字 ——
 * 「设置检查号的笔记封面」这种一行字浮在灰底上，
 * 整列的视觉基线被它带歪，看起来像卡片加载坏了。
 *
 * 判据是「宁可显示一块规整的占位，也不显示一行裸露的说明文字」：
 * 前者仍然工整，后者让这一张卡和周围所有卡长得不一样。
 */
const brokenCovers = ref(new Set<number>())

function markCoverBroken(postId: number) {
  brokenCovers.value.add(postId)
}
</script>

<template>
  <!--
    过滤提示。
    ⚠️ 不是「隐藏」而是「说明」：屏蔽生效之后卡片会变少，
    而用户不知道少的那几条去哪了 —— 表现就是「我的屏蔽没起作用」。
    一行小字就能解决这个问题，而它的成本几乎为零。
  -->
  <p v-if="filteredCount > 0" class="filter-note">
    按你的屏蔽偏好隐藏了 {{ filteredCount }} 条
    <!--
      以前是 <span @click>：鼠标能点，键盘 Tab 永远到不了。
      它做的不是跳转而是「就地展开一段解释」，所以语义上就是按钮，
      只是长得像链接 —— 保留链接外观，不保留链接标签。
    -->
    <button
      type="button"
      class="filter-link"
      :aria-expanded="showFilterHint"
      @click="showFilterHint = !showFilterHint"
    >
      为什么？
    </button>
  </p>
  <p v-if="filteredCount > 0 && showFilterHint" class="filter-hint">
    <template v-if="settings.minorMode">未成年人模式只显示纯文字笔记。 </template>
    <template v-if="plainBlockedCount > 0">
      已屏蔽话题：{{ plainBlockedCount }} 个（在「设置 → 内容偏好」里可以取消）。
    </template>
  </p>

  <div ref="gridRef" class="masonry">
    <div v-for="(col, ci) in columns" :key="ci" class="masonry-col sg-reveal">
      <!--
        ⚠️ 卡片本身是 <a>，所以它内部**不能**再放任何可聚焦控件。
        交互控件嵌在另一个交互控件里是 WCAG 的 serious 级违规：
        读屏会把两个控件念成一串，Tab 停下来的位置也说不清。

        之前这里是三样东西挤在一个 <a> 里：
        - 「不感兴趣」按钮（真 <button>）
        - 作者行（div + @click）
        - 点赞数（其实只是展示数据）

        现在卡片链接只负责「点进去看」，另外两个动作作为兄弟节点放在
        .card-wrap 里，由 wrap 承担定位和 hover。视觉顺序没变：
        封面 → 标题 → 作者行 → 时间。
      -->
      <div v-for="item in col" :key="item.post.id" class="card-wrap">
        <router-link :to="`/post/${item.post.id}`" class="card">
          <!-- 封面：有图显示图，无图也保留同尺寸占位，保证列高均匀 -->
          <div class="cover" :class="`ratio-${item.ratio}`">
            <img
              v-if="coverSrc(item.post) && !brokenCovers.has(item.post.id)"
              class="sg-img"
              :class="{ 'is-loaded': loadedImages.has(item.post.id) }"
              :src="shouldLoadCover(item.post.id) ? coverSrc(item.post) : undefined"
              :alt="`${item.post.author?.nickname} 的笔记封面`"
              :data-cover-id="item.post.id"
              loading="lazy"
              @load="markImageLoaded(item.post.id)"
              @error="markCoverBroken(item.post.id)"
            />
            <div v-else class="cover-blank">
              <span class="blank-tag"># {{ item.post.topicTag || '日常' }}</span>
            </div>

            <span v-if="item.post.imageUrls && item.post.imageUrls.length > 1" class="count-badge">
              +{{ item.post.imageUrls.length }}
            </span>
            <!-- 视频角标：真正的 mediaType 判断，替代以前「话题 == 视频」的猜测 -->
            <span v-if="item.post.mediaType === 'video'" class="play-badge">
              <el-icon><component :is="VideoPlay" /></el-icon>
            </span>

            <!--
              搜索命中话题标签时，正文里可能根本没有这个词（比如搜「美食」，
              结果是靠 topic_tag 命中的），不给任何视觉反馈用户会以为没搜到。
              所以命中标签时在封面左上角挂一个标签角标。
            -->
            <span v-if="tagMatched(item.post)" class="tag-badge"># {{ item.post.topicTag }}</span>

            <!--
              推荐理由（只有推荐流会传 reasons）。
              放在封面上而不是标题下面，是因为它回答的是「为什么你会看到这条」，
              而用户滑过一张卡片时眼睛先落在图上 —— 贴图的短句才读得到。
            -->
            <span v-if="props.reasons?.[item.post.id]" class="reason-badge">
              {{ props.reasons[item.post.id] }}
            </span>

            <!--
              悬停预览层（学习自 参考/15.文章卡预览效果）。

              参考的原始版本靠「垫纸向下滑 + margin 过渡」把数据胶囊放行到卡片
              外面 —— 在瀑布流里行不通：胶囊会压到下一行卡片上，margin 过渡
              还会抖动整列布局。所以这里做的是「意译」而不是「照抄」：

              1. 垫纸   → .card::before，整卡背后浮起一层 surface（含投影）
              2. 分类徽章 → .topic-peek，hover 才显形（搜索命中时 tag-badge
                          已经占了左上角，所以排除掉避免叠罗汉）
              3. 数据胶囊 → .peek，贴着封面底边错峰浮出（赞 / 评 / 图数），
                          底部渐变保证白字可读

              三个胶囊的出场节奏沿用参考的错峰设计（0 / 45 / 90ms delay），
              但只动 transform 和 opacity —— 封面有 overflow:hidden，
              渐变和胶囊都关在里面，绝不越界碰下一张卡。
            -->
            <span v-if="item.post.topicTag && !tagMatched(item.post)" class="topic-peek">
              # {{ item.post.topicTag }}
            </span>
            <div class="peek-scrim" aria-hidden="true"></div>
            <div class="peek">
              <!--
                ⚠️ 这里**不放点赞数**。作者行末尾已经有一个常驻的星标数字，
                预览层再给一份，同一张卡上就出现两个相同的星标 ——
                用户 2026-11-07 的原话是「收藏标识重复了」。
                预览层只补作者行没说的那两项：评论数、图片数。
              -->
              <span class="pill">
                <el-icon><component :is="ChatDotRound" /></el-icon>
                {{ item.post.commentCount }}
              </span>
              <span v-if="item.post.imageUrls.length" class="pill">
                <el-icon><component :is="Picture" /></el-icon>
                {{ item.post.imageUrls.length }}
              </span>
            </div>
          </div>

          <!-- 标题：两行截断，命中关键词高亮 -->
          <p class="title">
            <span
              v-for="(seg, si) in segments(item.post.content)"
              :key="si"
              :class="{ hit: seg.hit }"
              >{{ seg.text }}</span
            >
          </p>
        </router-link>

        <!--
          不感兴趣。hover 才显形：常驻会变成视觉噪声，
          而且它是个**破坏性**操作，不该和「点进去看」抢同等的视觉权重。
          定位挂在 .card-wrap 上（封面和 wrap 顶边对齐，所以偏移量不变）。

          × 图标被用户理解成了「删除」—— 这不是用户的错，是图标的锅。
          tooltip 把它真正的意思写在悬停的那半秒里。
        -->
        <el-tooltip
          v-if="dismissable"
          content="不感兴趣，少推这类内容"
          placement="top"
          :show-after="300"
        >
          <button
            type="button"
            class="dismiss-btn"
            :aria-label="`不感兴趣：${item.post.content.slice(0, 20)}`"
            @click="emit('dismiss', item.post.id)"
          >
            <el-icon><component :is="Close" /></el-icon>
          </button>
        </el-tooltip>

        <!-- 作者 + 时间 + 点赞：挤在一行里 -->
        <div class="foot">
          <!--
            有作者才给链接。
            之前这里是 `div @click` + 弹一句「这条笔记没有关联作者」，
            那是个键盘和读屏都够不到的假按钮：现在要么是真链接，
            要么是一个明确不可点的纯展示元素。
          -->
          <router-link
            v-if="item.post.author?.id"
            class="author"
            :to="`/profile/${item.post.author.id}`"
          >
            <el-avatar
              :size="18"
              :src="item.post.author?.avatar || undefined"
              class="avatar"
              alt=""
            >
              {{ avatarText(item.post.author?.nickname) }}
            </el-avatar>
            <span class="nickname">{{ item.post.author?.nickname || '未知用户' }}</span>
          </router-link>
          <span v-else class="author author--plain" title="这条笔记没有关联作者">
            <el-avatar :size="18" class="avatar" alt="">
              {{ avatarText(item.post.author?.nickname) }}
            </el-avatar>
            <span class="nickname">{{ item.post.author?.nickname || '未知用户' }}</span>
          </span>

          <span class="dot">·</span>

          <span class="time" :title="item.post.createdAt">{{
            formatTime(item.post.createdAt)
          }}</span>

          <span class="like">
            <el-icon><component :is="Star" /></el-icon>
            {{ item.post.likeCount }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 两个 gap 都走变量，让「界面密度」偏好能真的改它们。
 *
 * ⚠️ 注意 `GAP`（utils/masonry.ts 里算列宽用的那个常量）**不能跟着变** ——
 * 它参与的是「列宽 = (总宽 - 列间距 × (n-1)) / n」这个计算，
 * 改了会让 JS 算出的宽度和 CSS 实际渲染的对不上，卡片右边会留缝。
 * 密度只影响视觉间距，不影响布局计算。
 */
/* 过滤提示：低调但可点。它不是错误提示，是「你的设置生效了」的反馈 */
.filter-note {
  margin: 0 0 10px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/*
 * 长得像链接的按钮。
 *
 * 保留 `underline` 是有意的：它告诉用户「这里能点、点了会展开」，
 * 而周围正文没有下划线，所以这个下划线是唯一的功能提示。
 * 代价是要手动抹掉按钮自带的 padding / 背景 / 字号继承。
 */
.filter-link {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  cursor: pointer;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.filter-link:hover {
  color: var(--accent-dim);
}

.filter-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

.filter-hint {
  margin: -4px 0 10px;
  padding: 8px 10px;
  border-left: 2px solid var(--border-strong);
  background: var(--surface-2);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: var(--fs-xs);
  color: var(--text-2);
  line-height: 1.7;
}

.masonry {
  display: flex;
  align-items: flex-start;
  gap: var(--masonry-col-gap);
}

.masonry-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--masonry-item-gap);
}

/*
 * 卡片外壳。
 *
 * 它存在的唯一原因是「链接里不能再放链接或按钮」：
 * 不感兴趣按钮和作者主页链接都要在 <a class="card"> 外面，
 * 定位和 hover 状态因此挂到这个壳上，而不是挂在卡片链接上。
 *
 * 封面和壳的顶边是齐的，所以 .dismiss-btn 的偏移量沿用原来的数值。
 */
.card-wrap {
  position: relative;
  display: block;
}

.card {
  display: block;
  color: inherit;
  border-radius: var(--radius-md);
  /*
   * position + z-index:0 是给下面的「垫纸」（.card::before, z-index:-1）
   * 圈出一个层叠上下文用的 —— 没有它，-1 会试图钻到页面背景底下，
   * 垫纸直接消失。transform 也会创建上下文，但那只存在于 hover 态，
   * 静止态必须有稳定的兜底。
   */
  position: relative;
  z-index: 0;
  /* 键盘用户也要看到「这里能点进去」的邀请，和 hover 同一套反馈 */
  transition:
    background-color var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-standard) var(--ease-out-expo);
}

.card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}

/*
 * 悬停「垫纸」+ 抬升 —— 参考/15.文章卡预览效果的核心意象。
 *
 * 参考的实现是 margin-top + scale 过渡（会触发 layout），这里改成
 * 纯 transform：垫纸从「藏在卡片正后方」平移到位，卡片整体上浮 4px。
 * 垫纸比内容大一圈（inset 负值），四边各露出约 8-10px ——
 * 列间距 18px / 行间距 26px，都容得下，不会碰到邻居。
 */
.card::before {
  content: '';
  position: absolute;
  inset: -8px -10px -10px;
  z-index: -1;
  border-radius: calc(var(--radius-md) + 4px);
  background: var(--surface-2);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
  opacity: 0;
  transform: translateY(6px) scale(0.985);
  transition:
    opacity var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-standard) var(--ease-out-expo);
}

.card-wrap:hover .card,
.card:focus-visible {
  transform: translateY(-4px);
}

.card-wrap:hover .card::before,
.card:focus-visible::before {
  opacity: 1;
  transform: none;
}

/* 封面：圆角、无边框，卡片本身没有背景和描边 */
.cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: var(--radius-md);
  /*
   * 封面加载时的占位色。
   *
   * 由 settings.coverBlurPlaceholder 控制：关掉时把底色设成透明，
   * 于是图片到达之前是一片空白而不是一块灰。
   * 那看起来像「坏了」，但它至少不会让人误以为图加载失败 ——
   * 两种都各有代价，所以做成可切换而不是替用户选一个。
   */
  background: var(--cover-placeholder, var(--muted));
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* ease（默认贝塞尔）是最平庸的曲线：出刀不快、收尾不净。
     换成 ease-out-expo —— 起步快、落点稳，看得出「被拿起来」而不是「在滑动」。 */
  transition: transform var(--dur-standard) var(--ease-out-expo);
}

.card:hover .cover img,
.card:focus-visible .cover img {
  transform: scale(1.04);
}

/* 6 张一循环制造瀑布流高度差 */
.ratio-0 {
  aspect-ratio: 1 / 1;
}
.ratio-1 {
  aspect-ratio: 3 / 4;
}
.ratio-2 {
  aspect-ratio: 4 / 5;
}
.ratio-3 {
  aspect-ratio: 3 / 5;
}
.ratio-4 {
  aspect-ratio: 2 / 3;
}
.ratio-5 {
  aspect-ratio: 5 / 6;
}

/* 无图占位：保持和封面同样的比例，栅格才不会高低不齐 */
.cover-blank {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(140deg, var(--muted), var(--secondary));
}

.blank-tag {
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
  padding: 0 14px;
  text-align: center;
}

.count-badge {
  position: absolute;
  right: 8px;
  top: 8px;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  font-size: var(--fs-2xs);
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
}

/* 搜索命中的话题标签角标 */
.tag-badge {
  position: absolute;
  left: 8px;
  top: 8px;
  padding: 2px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-2xs);
  font-weight: 600;
  /* 底是强调色，字必须是页面底色 —— 白字压黄绿只有 1.75:1 */
  color: var(--accent-foreground);
  background: var(--accent);
}

.play-badge {
  position: absolute;
  right: 8px;
  top: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 50%;
  backdrop-filter: blur(2px);
  /* 卡片 hover 时角标跟着放大 —— 参考动效里「卡片被拿起来」的同一套手感，
     封面 zoom 1.04、角标 1.1，差值让角标有浮出来的层次 */
  transition: transform var(--dur-fast) var(--ease-out-expo);
}

.card:hover .play-badge,
.card:focus-visible .play-badge {
  transform: scale(1.1);
}

/*
 * 推荐理由：贴底的小胶囊。
 *
 * ⚠️ 默认不显示，悬停才浮出来。
 *
 * 之前是常驻的 —— 结果用户一眼看过去，满屏左下角都是「刚刚发布」
 * 「你常看这位作者」：推荐系统给每一条候选都会算出一个最大贡献项当理由
 * （feed-score.ts 的 topReason），而新鲜度和作者亲和度几乎总是赢，
 * 于是这两句话铺满了整个首屏，信息量被重复次数稀释成了噪声。
 * 保留信息、去掉噪声的办法不是删掉理由，而是让它按需出现：
 * 想知道为什么推这条，鼠标停一下就能看到。
 */
.reason-badge {
  position: absolute;
  left: 8px;
  bottom: 8px;
  max-width: calc(100% - 16px);
  padding: 2px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-2xs);
  font-weight: 600;
  line-height: 1.6;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}

/* ===== 悬停预览层 ===== */

/*
 * 话题徽章（hover 显形）—— 对应参考动效里右上角的分类标签。
 * 和搜索命中的 .tag-badge 是同一套视觉，但出场时机不同：
 * tag-badge 是「搜索命中」的常驻信息，这个是浏览时的补充说明。
 * 左上角已被 tag-badge 占用的情况在模板里排除了（!tagMatched）。
 */
.topic-peek {
  position: absolute;
  left: 8px;
  top: 8px;
  padding: 2px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-2xs);
  font-weight: 600;
  color: var(--accent-foreground);
  background: var(--accent);
  opacity: 0;
  transform: translateY(-4px);
  transition:
    opacity var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}

/*
 * 底部渐变：胶囊是白字，直接压在浅色封面（雪景、白墙）上看不见。
 * 渐变和胶囊同步显形，hover 离开时一起退场。
 * aria-hidden 已在模板标出 —— 纯装饰，读屏不该念。
 */
.peek-scrim {
  position: absolute;
  inset: auto 0 0;
  height: 56px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out-expo);
}

/* 胶囊行：贴右下角，避开左下角的推荐理由徽章 */
.peek {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  gap: 6px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--fs-2xs);
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  font-variant-numeric: tabular-nums;
  /* 出场前的隐藏态：藏进封面底边下面 */
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}

.pill .el-icon {
  font-size: 11px;
}

/*
 * 错峰出场：沿用参考动效 0.2 / 0.24 / 0.28s 的节奏思路，
 * 但用 delay 而不是拉长 duration —— 三张胶囊步幅一致、先后有别，
 * delay 只写在 hover 态，离开时全部归零（胶囊一起退场，不拖泥带水）。
 * 键盘聚焦（:focus-visible）走同一套，读屏和鼠标用户看到的东西一致。
 */
.card-wrap:hover .topic-peek,
.card:focus-visible .topic-peek,
.card-wrap:hover .peek-scrim,
.card:focus-visible .peek-scrim {
  opacity: 1;
  transform: none;
}

.card-wrap:hover .pill,
.card:focus-visible .pill {
  opacity: 1;
  transform: none;
}

.card-wrap:hover .peek .pill:nth-child(1),
.card:focus-visible .peek .pill:nth-child(1) {
  transition-delay: 0ms;
}
.card-wrap:hover .peek .pill:nth-child(2),
.card:focus-visible .peek .pill:nth-child(2) {
  transition-delay: 45ms;
}

/*
 * 推荐理由和胶囊共用封面底边（一个左一个右），都在悬停时出现。
 * 理由的最大宽度收窄到 52%，窄卡上两者相遇也不会叠字。
 */
.card-wrap:hover .reason-badge,
.card:focus-visible .reason-badge {
  opacity: 1;
  transform: none;
  max-width: 52%;
}

/*
  不感兴趣按钮：
  - 默认 opacity 0，hover 卡片才显形
  - 聚焦时也显形，否则键盘用户永远看不到这个操作
  - z-index 压在封面之上：它现在是 .card 的兄弟节点而不是后代，
    两者都是定位元素，靠文档顺序已经够，但写出来免得以后有人调顺序时踩坑
*/
.dismiss-btn {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out-expo);
}

.card-wrap:hover .dismiss-btn,
.dismiss-btn:focus-visible {
  opacity: 1;
  /* 卡片抬升（.card 的 translateY(-4px)）时按钮跟着走，否则悬停瞬间它悬在原位 */
  transform: translateY(-4px);
}

.dismiss-btn:hover {
  background: var(--accent);
}

/* 只动 transform / opacity / color / border-color，不碰 layout 属性 */
.dismiss-btn:hover {
  transform: translateY(-4px) scale(1.08);
}

/* ===== 标题 ===== */
.title {
  margin: 8px 0 6px;
  font-size: var(--fs-base);
  line-height: 1.45;
  color: var(--foreground);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  /*
   * 预留两行高度。
   *
   * 瀑布流的「整齐」不是靠等高，而是靠**同一区域的基线对齐**：
   * 一行标题的卡片会把下面的作者行往上提半行，整列看起来就歪。
   * 代价是只有一行的卡片底部空一行半 —— 用一次留白换整列的齐，
   * 而瀑布流本身每一列高度都不等，卡片整体高矮看不出来。
   */
  min-height: calc(2 * 1.45em);
  /* 跟着卡片一起亮：给出「这条被选中了」的第二个通道。
     对纯图片网格来说，多一层文字反馈比只动图片更好辨认。 */
  transition: color var(--dur-fast) var(--ease-out-expo);
}

.card:hover .title,
.card:focus-visible .title {
  /*
   * ⚠️ 这里曾经是 `var(--accent-foreground)`，2026-11-07 被用户当场抓到：
   * 悬停后标题直接消失。
   *
   * 原因：那个令牌的语义是「压在强调色**块**上的字色」——
   * 深色主题下是 #19191b（近黑），因为要压在 #c6ca4c 的黄绿块上才读得清。
   * 而标题底下是页面背景（同样是近黑），于是字被涂成了背景色。
   * 要表达「强调色**文字**」，用的应该是 --accent 本身：
   * 深色主题 #c6ca4c / 浅色主题 #5f6417，两个方向都过 AA。
   */
  color: var(--accent);
}

.title .hit {
  color: var(--accent);
  font-weight: 600;
}

/* ===== 作者行 =====
 *
 * 一行放完：作者 · 时间 …… 点赞。
 * 之前时间是单独一行，每张卡因此多出约 18px，作者行起点也参差。
 */
.foot {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.author {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-xs);
}

/* 作者行现在是 router-link，键盘焦点要有落点 */
.author:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/*
 * 没有关联作者的笔记：渲染成纯文本，**不带** pointer 光标。
 * 之前这里是 div + @click，鼠标有手型、点了弹一句 toast，
 * 键盘却完全够不到 —— 一个看起来能点、实际只有一半人能用的控件。
 * 现在它从一开始就不是控件，光标也不会骗人。
 */
.author--plain {
  cursor: default;
}

.avatar {
  background: var(--muted);
  color: var(--foreground);
  font-size: var(--fs-2xs);
  flex-shrink: 0;
}

.nickname {
  font-size: var(--fs-xs);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 作者、时间、点赞之间的分隔点。用它而不是给每段加 margin：
   时间被挤掉时分隔点会跟着消失，而不是留下两个空洞。 */
.dot {
  color: var(--text-3);
  font-size: var(--fs-xs);
  flex-shrink: 0;
}

.time {
  font-size: var(--fs-xs);
  color: var(--text-3);
  white-space: nowrap;
  flex-shrink: 0;
}

.like {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  padding-left: 6px;
  font-size: var(--fs-xs);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
</style>
