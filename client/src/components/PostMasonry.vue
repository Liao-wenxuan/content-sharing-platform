<script setup lang="ts">
/**
 * 帖子瀑布流
 *
 * 首页和搜索页共用，所以从 HomeView 里抽出来。
 *
 * 分列、高度估算、关键词切分都在 utils/masonry.ts 里（纯函数，可单测），
 * 这个组件只做两件事：ResizeObserver 监听宽度 → 按结果渲染 DOM。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, VideoPlay, Close } from '@element-plus/icons-vue'
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
const router = useRouter()
const gridWidth = ref(1200)
const colCount = ref(5)
const { settings } = useUserSettings()

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!gridRef.value) return
  resizeObserver = new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width
    gridWidth.value = w
    colCount.value = computeColCount(w)
  })
  resizeObserver.observe(gridRef.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

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
 * 点作者跳到他的主页。
 *
 * 之前这里只有一句「个人主页跳转开发中」的 toast ——
 * 一个能被点到、点下去只会得到一句「快了」的假按钮。
 * 路由 `/user/:id` 早就存在了，缺的只是这一跳。
 *
 * `.prevent` 是必须的：整个卡片是 router-link，
 * 不拦住的话会先触发卡片的跳转再触发这一跳，两个导航互相打架。
 */
function onAuthorClick(post: Post) {
  const authorId = post.author?.id
  if (!authorId) {
    // 作者信息缺失（比如种子数据里的匿名笔记）时不给假反馈 ——
    // 「点了没反应」比「明确告知不能点」更糟
    ElMessage.info('这条笔记没有关联作者')
    return
  }
  router.push(`/profile/${authorId}`)
}

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
    <span class="filter-link" @click="showFilterHint = !showFilterHint">为什么？</span>
  </p>
  <p v-if="filteredCount > 0 && showFilterHint" class="filter-hint">
    <template v-if="settings.minorMode">未成年人模式只显示纯文字笔记。 </template>
    <template v-if="plainBlockedCount > 0">
      已屏蔽话题：{{ plainBlockedCount }} 个（在「设置 → 内容偏好」里可以取消）。
    </template>
  </p>

  <div ref="gridRef" class="masonry">
    <div v-for="(col, ci) in columns" :key="ci" class="masonry-col sg-reveal">
      <router-link
        v-for="item in col"
        :key="item.post.id"
        :to="`/post/${item.post.id}`"
        class="card"
      >
        <!-- 封面：有图显示图，无图也保留同尺寸占位，保证列高均匀 -->
        <div class="cover" :class="`ratio-${item.ratio}`">
          <img
            v-if="item.post.imageUrls?.length"
            class="sg-img"
            :class="{ 'is-loaded': loadedImages.has(item.post.id) }"
            :src="coverSrc(item.post)"
            :alt="`${item.post.author?.nickname} 的笔记封面`"
            loading="lazy"
            @load="markImageLoaded(item.post.id)"
          />
          <div v-else class="cover-blank">
            <span class="blank-tag"># {{ item.post.topicTag || '日常' }}</span>
          </div>

          <span v-if="item.post.imageUrls && item.post.imageUrls.length > 1" class="count-badge">
            +{{ item.post.imageUrls.length }}
          </span>
          <span v-if="item.post.topicTag === '视频'" class="play-badge">
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
            不感兴趣。hover 才显形：常驻会变成视觉噪声，
            而且它是个**破坏性**操作，不该和「点进去看」抢同等的视觉权重。
            .prevent 挡住 router-link 的跳转，.stop 冒泡出去。
          -->
          <button
            v-if="dismissable"
            type="button"
            class="dismiss-btn"
            :aria-label="`不感兴趣：${item.post.content.slice(0, 20)}`"
            @click.prevent.stop="emit('dismiss', item.post.id)"
          >
            <el-icon><component :is="Close" /></el-icon>
          </button>
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

        <!-- 作者 + 点赞 -->
        <div class="foot">
          <div class="author" @click.prevent="onAuthorClick(item.post)">
            <el-avatar :size="20" class="avatar">
              {{ avatarText(item.post.author?.nickname) }}
            </el-avatar>
            <span class="nickname">{{ item.post.author?.nickname || '未知用户' }}</span>
          </div>
          <span class="like">
            <el-icon><component :is="Star" /></el-icon>
            {{ item.post.likeCount }}
          </span>
        </div>

        <span class="time" :title="item.post.createdAt">{{ formatTime(item.post.createdAt) }}</span>
      </router-link>
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

.filter-link {
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.filter-link:hover {
  color: var(--accent-dim);
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

.card {
  display: block;
  color: inherit;
  border-radius: var(--radius-md);
  /* 键盘用户也要看到「这里能点进去」的邀请，和 hover 同一套反馈 */
  transition: background-color var(--dur-fast) var(--ease-out-expo);
}

.card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
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
  color: #fff;
  background: var(--accent);
}

.play-badge {
  position: absolute;
  right: 8px;
  top: 8px;
  color: #fff;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}

/* 推荐理由：贴底的小胶囊，不遮挡主体内容 */
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
}

/*
  不感兴趣按钮：
  - 默认 opacity 0，hover 卡片才显形
  - 聚焦时也显形，否则键盘用户永远看不到这个操作
*/
.dismiss-btn {
  position: absolute;
  right: 8px;
  top: 8px;
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

.card:hover .dismiss-btn,
.dismiss-btn:focus-visible {
  opacity: 1;
}

.dismiss-btn:hover {
  background: var(--accent);
}

/* 只动 transform / opacity / color / border-color，不碰 layout 属性 */
.dismiss-btn:hover {
  transform: scale(1.08);
}

/* ===== 标题 ===== */
.title {
  margin: 10px 0 8px;
  font-size: var(--fs-base);
  line-height: 1.45;
  color: var(--foreground);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  /* 跟着卡片一起亮：给出「这条被选中了」的第二个通道。
     对纯图片网格来说，多一层文字反馈比只动图片更好辨认。 */
  transition: color var(--dur-fast) var(--ease-out-expo);
}

.card:hover .title,
.card:focus-visible .title {
  color: var(--accent-foreground);
}

.title .hit {
  color: var(--accent);
  font-weight: 600;
}

/* ===== 作者行 ===== */
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.author {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.avatar {
  background: var(--muted);
  color: var(--foreground);
  font-size: var(--fs-2xs);
  flex-shrink: 0;
}

.nickname {
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.like {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.time {
  display: block;
  margin-top: 4px;
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
  opacity: 0.7;
}
</style>
