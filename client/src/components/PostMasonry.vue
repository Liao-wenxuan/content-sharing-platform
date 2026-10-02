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
import { ElMessage } from 'element-plus'
import { Star, VideoPlay } from '@element-plus/icons-vue'
import type { Post } from '@/api/posts'
import { useRelativeTime } from '@/composables/useRelativeTime'
import {
  GAP,
  computeColCount,
  distributeToColumns,
  segmentByKeyword,
  avatarText
} from '@/utils/masonry'

const props = defineProps<{
  posts: Post[]
  /** 关键词：命中片段会高亮（搜索页传，首页不传） */
  highlight?: string
}>()

const { formatTime } = useRelativeTime()

const gridRef = ref<HTMLElement | null>(null)
const gridWidth = ref(1200)
const colCount = ref(5)

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

const columns = computed(() => {
  const n = colCount.value
  const colWidth = (gridWidth.value - GAP * (n - 1)) / n
  return distributeToColumns(props.posts, n, colWidth)
})

function onAuthorClick() {
  ElMessage.info('个人主页跳转开发中')
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
</script>

<template>
  <div ref="gridRef" class="masonry">
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

        <span class="time" :title="item.post.createdAt">{{ formatTime(item.post.createdAt) }}</span>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
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

/* 封面：圆角、无边框，卡片本身没有背景和描边 */
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

/* 搜索命中的话题标签角标 */
.tag-badge {
  position: absolute;
  left: 8px;
  top: 8px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
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
</style>
