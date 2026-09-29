<script setup lang="ts">
/**
 * 发现页（对标小红书 explore 布局）
 *
 * 与上一版的差别：
 * - 去掉「发现」大标题 + 副标题：首页直接以频道栏起头，把纵向空间让给瀑布流
 * - 去掉第二层分类胶囊：合并成一层频道栏（居中 + 红色短下划线，对齐小红书）
 * - 内容列从 1080px 放宽到 1560px，栅格 4 列 → 6 列
 * - 卡片改成「图优先」：封面图（圆角、无边框）+ 两行标题 + 作者/点赞行
 * - 无图笔记也保留等高占位块，栅格不再参差不齐
 *
 * 为什么不用 grid 做瀑布流：
 * grid 的行高由该行最高的卡片决定，短卡片下面会留出一大片空白。
 * 真正的小红书是「每列独立高度」的 masonry，所以这里用最短列优先
 * 自己分列（column-major 会让阅读顺序变成竖着读，所以不用 CSS columns）。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Star, VideoPlay } from '@element-plus/icons-vue'
import { postsApi, type Post } from '@/api/posts'
import { useRelativeTime } from '@/composables/useRelativeTime'
import { useHomeTabsStore } from '@/stores/homeTabs'
import EmptyState from '@/components/EmptyState.vue'

const { formatTime } = useRelativeTime()
const homeTabs = useHomeTabsStore()

const posts = ref<Post[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const page = ref(1)
const hasMore = ref(false)

// 频道（对齐小红书首页频道栏）
const channels = [
  { key: 'recommend', label: '推荐' },
  { key: 'outfit', label: '穿搭' },
  { key: 'food', label: '美食' },
  { key: 'beauty', label: '彩妆' },
  { key: 'movie', label: '影视' },
  { key: 'workplace', label: '职场' },
  { key: 'emotion', label: '情感' },
  { key: 'home', label: '家居' },
  { key: 'game', label: '游戏' },
  { key: 'travel', label: '旅行' },
  { key: 'fitness', label: '健身' },
  { key: 'video', label: '视频' }
]

// ===== 瀑布流分列 =====
// 6 张一循环的封面比例，和 CSS 里的 .ratio-N 一一对应。
// 分列时按「预估高度」放进当前最矮的一列，这样阅读顺序仍是左→右→换行。
const RATIOS = [
  [1, 1],
  [3, 4],
  [4, 5],
  [3, 5],
  [2, 3],
  [5, 6]
] as const

const MIN_COL_WIDTH = 232
const GAP = 18
const gridRef = ref<HTMLElement | null>(null)
const gridWidth = ref(1200)
const colCount = ref(5)

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!gridRef.value) return
  resizeObserver = new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width
    gridWidth.value = w
    // 内容区能塞几列就塞几列，最少 2 列
    colCount.value = Math.max(2, Math.floor((w + GAP) / (MIN_COL_WIDTH + GAP)))
  })
  resizeObserver.observe(gridRef.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

interface ColumnItem {
  post: Post
  ratio: number
}

/** 估算一张卡片的渲染高度：封面 + 标题两行 + 作者行 */
function estimateHeight(item: { post: Post; ratio: number }, colWidth: number): number {
  const [rw, rh] = RATIOS[item.ratio]
  // 无图笔记也渲染同尺寸占位块，所以封面高度一样
  const cover = (colWidth * rh) / rw
  const title = item.post.content.length > 26 ? 40 : 20
  return cover + 10 + title + 8 + 20 + 18
}

const columns = computed<ColumnItem[][]>(() => {
  const n = colCount.value
  const colWidth = (gridWidth.value - GAP * (n - 1)) / n
  const buckets: ColumnItem[][] = Array.from({ length: n }, () => [])
  const heights = new Array(n).fill(0)

  posts.value.forEach((post, i) => {
    const item: ColumnItem = { post, ratio: i % 6 }
    let target = 0
    for (let c = 1; c < n; c++) {
      if (heights[c] < heights[target]) target = c
    }
    buckets[target].push(item)
    heights[target] += estimateHeight(item, colWidth)
  })

  return buckets
})

async function loadFeed(reset: boolean) {
  if (reset) {
    page.value = 1
    posts.value = []
  }

  loading.value = reset
  loadingMore.value = !reset
  errorMsg.value = ''

  try {
    const data = await postsApi.getFeed({
      page: page.value,
      pageSize: 12,
      category: homeTabs.category
    })
    posts.value.push(...data.list)
    hasMore.value = data.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function reload() {
  return loadFeed(true)
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  page.value++
  await loadFeed(false)
}

function avatarText(nickname?: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

function onAuthorClick() {
  ElMessage.info('个人主页跳转开发中')
}

onMounted(() => loadFeed(true))

watch(
  () => homeTabs.category,
  () => loadFeed(true)
)
</script>

<template>
  <div class="explore">
    <!-- 频道栏：居中 + 红色短下划线 -->
    <el-tabs v-model="homeTabs.category" class="channel-tabs">
      <el-tab-pane v-for="ch in channels" :key="ch.key" :label="ch.label" :name="ch.key" />
    </el-tabs>

    <EmptyState v-if="loading && posts.length === 0" variant="loading" title="正在加载笔记..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="reload"
    />

    <template v-else>
      <el-empty v-if="posts.length === 0" description="这个频道还没有内容">
        <el-button type="primary" @click="$router.push('/publish')">去发第一篇</el-button>
      </el-empty>

      <div v-else ref="gridRef" class="masonry">
        <div v-for="(col, ci) in columns" :key="ci" class="masonry-col">
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
                :src="item.post.imageUrls[0]"
                :alt="`${item.post.author?.nickname} 的笔记封面`"
                loading="lazy"
              />
              <div v-else class="cover-blank">
                <span class="blank-tag"># {{ item.post.topicTag || '日常' }}</span>
              </div>

              <span
                v-if="item.post.imageUrls && item.post.imageUrls.length > 1"
                class="count-badge"
              >
                +{{ item.post.imageUrls.length }}
              </span>
              <span v-if="item.post.topicTag === '视频'" class="play-badge">
                <el-icon><component :is="VideoPlay" /></el-icon>
              </span>
            </div>

            <!-- 标题：两行截断 -->
            <p class="title">{{ item.post.content }}</p>

            <!-- 作者 + 点赞 -->
            <div class="foot">
              <div class="author" @click.prevent="onAuthorClick">
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

            <span class="time" :title="item.post.createdAt">
              {{ formatTime(item.post.createdAt) }}
            </span>
          </router-link>
        </div>
      </div>

      <div v-if="posts.length > 0" class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="no-more">— 已经到底了 —</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.explore {
  /* 首页比内页宽：小红书 explore 在 1920 下是 6 列 */
  max-width: 1560px;
  margin: 0 auto;
}

/* ===== 频道栏 ===== */
.channel-tabs :deep(.el-tabs__header) {
  display: flex;
  justify-content: center;
  margin-bottom: 22px;
}

.channel-tabs :deep(.el-tabs__nav-wrap),
.channel-tabs :deep(.el-tabs__nav-scroll) {
  display: flex;
  justify-content: center;
}

.channel-tabs :deep(.el-tabs__nav) {
  border-bottom: none;
}

.channel-tabs :deep(.el-tabs__item) {
  position: relative;
  height: 44px;
  padding: 0 4px;
  margin: 0 20px;
  font-size: 16px;
  color: var(--foreground);
  opacity: 0.62;
}

.channel-tabs :deep(.el-tabs__item:hover) {
  opacity: 0.9;
}

.channel-tabs :deep(.el-tabs__item.is-active) {
  color: var(--foreground);
  opacity: 1;
  font-weight: 600;
}

/* 官方整宽下划线换成小红书式的居中短红条 */
.channel-tabs :deep(.el-tabs__active-bar) {
  display: none;
}

.channel-tabs :deep(.el-tabs__item.is-active::after) {
  content: '';
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: 18px;
  height: 3px;
  border-radius: 2px;
  background: var(--el-color-primary);
}

/* ===== 瀑布流 ===== */
.masonry {
  display: flex;
  align-items: flex-start;
  gap: 18px;
}

.masonry-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.card {
  display: block;
  color: inherit;
}

/* 封面：圆角、无边框，卡片本身没有背景和描边（小红书是「图+字」，不是盒子） */
.cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 8px;
  background: var(--muted);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.35s ease;
}

.card:hover .cover img {
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
  font-size: 13px;
  color: var(--muted-foreground);
  padding: 0 14px;
  text-align: center;
}

.count-badge {
  position: absolute;
  right: 8px;
  top: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
}

.play-badge {
  position: absolute;
  right: 8px;
  top: 8px;
  color: #fff;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}

/* ===== 标题 ===== */
.title {
  margin: 10px 0 8px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--foreground);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
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
  font-size: 10px;
  flex-shrink: 0;
}

.nickname {
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.like {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.time {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted-foreground);
  opacity: 0.7;
}

/* ===== 分页 ===== */
.pager {
  display: flex;
  justify-content: center;
  padding: 36px 0 12px;
}

.no-more {
  color: var(--muted-foreground);
  font-size: 13px;
}
</style>
