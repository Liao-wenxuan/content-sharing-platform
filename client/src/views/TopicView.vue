<script setup lang="ts">
/**
 * 话题页 /topic/:tag
 *
 * 话题没有实体表，页面上的一切都是 posts.topic_tag 的现算聚合
 * （笔记数、参与人数、封面都来自 SQL GROUP BY），所以这个页面
 * 不存在「话题建了但没内容」的空壳状态。
 *
 * 为什么相关话题按「同话题作者的其它话题」推：
 * 「写了同一个话题的人还关注了什么」天然和你此刻的浏览兴趣相关，
 * 而随机推热门话题等于在首页再放一遍推荐位。
 */
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { topicsApi, topicPath, type TopicSummary, type RelatedTopic } from '@/api/topics'
import type { Post } from '@/api/posts'
import PostMasonry from '@/components/PostMasonry.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()

const topic = ref<TopicSummary | null>(null)
const posts = ref<Post[]>([])
const related = ref<RelatedTopic[]>([])

const page = ref(1)
const total = ref(0)
const hasMore = ref(false)

const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
/** 话题不存在（404）要给出不同的引导，而不是当成加载失败 */
const notFound = ref(false)

/** route.params.tag 已经由 vue-router 解码过一次 */
const tag = computed(() => String(route.params.tag ?? '').trim())

async function load() {
  if (!tag.value) return
  loading.value = true
  errorMsg.value = ''
  notFound.value = false
  posts.value = []
  page.value = 1
  try {
    const res = await topicsApi.detail(tag.value, { page: 1, pageSize: 20 })
    // null = 后端说这个话题不存在（不是请求失败）
    if (!res) {
      notFound.value = true
      topic.value = null
      return
    }
    topic.value = res.topic
    posts.value = res.list
    related.value = res.related
    total.value = res.pagination.total
    hasMore.value = res.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const res = await topicsApi.detail(tag.value, { page: next })
    // 翻到一半话题被删了（不太可能但不该崩）：当到底处理
    if (!res) {
      hasMore.value = false
      return
    }
    const seen = new Set(posts.value.map((p) => p.id))
    posts.value = [...posts.value, ...res.list.filter((p) => !seen.has(p.id))]
    page.value = next
    hasMore.value = res.pagination.hasMore
  } catch {
    /* 翻页失败停在当前页，不清空 */
  } finally {
    loadingMore.value = false
  }
}

function goTag(t: string) {
  router.push(topicPath(t))
}

onMounted(load)

// 从「前端开发」的相关话题点进「vue」时，URL 变了但组件不会重建，
// 必须监听参数自己重新加载
watch(tag, load)

// 浏览器标签页标题跟着话题走，刷新和收藏夹里都能看出这是哪个话题
watch(
  topic,
  (t) => {
    document.title = t ? `#${t.tag} - 内容社区` : '内容社区'
  },
  { immediate: true }
)
</script>

<template>
  <div class="topic">
    <EmptyState v-if="loading && !topic" variant="loading" title="加载话题..." />

    <EmptyState
      v-else-if="notFound"
      icon="🏷️"
      :title="`还没有人用过「${tag}」这个话题`"
      hint="你可以在发布笔记时自己创造它"
      action="去发一篇"
      @action="router.push('/publish')"
    />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="load"
    />

    <template v-else-if="topic">
      <!-- ===== 话题头部 ===== -->
      <header class="topic-head">
        <div v-if="topic.cover" class="topic-cover">
          <img :src="topic.cover" :alt="`${topic.tag} 话题封面`" />
        </div>

        <div class="topic-info">
          <h1 class="topic-name"><span class="hash">#</span>{{ topic.tag }}</h1>
          <p class="topic-stat">{{ total }} 篇笔记 · {{ topic.authorCount }} 人参与</p>
        </div>
      </header>

      <!-- ===== 相关话题 ===== -->
      <section v-if="related.length > 0" class="related">
        <span class="related-label">相关话题</span>
        <button
          v-for="r in related"
          :key="r.tag"
          type="button"
          class="related-chip"
          @click="goTag(r.tag)"
        >
          #{{ r.tag }}
          <span class="related-count">{{ r.postCount }}</span>
        </button>
      </section>

      <!-- ===== 笔记列表 ===== -->
      <EmptyState
        v-if="posts.length === 0 && !loading"
        icon="✍️"
        :title="`「${topic.tag}」下还没有笔记`"
        hint="发一篇带这个话题的笔记，它就会出现在这里"
        compact
      />

      <PostMasonry v-else :posts="posts" />

      <div v-if="posts.length > 0" class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="no-more">— 已经到底了 —</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.topic {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

/* ===== 头部 ===== */
.topic-head {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 20px;
}

.topic-cover {
  width: 132px;
  height: 88px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  background: var(--muted);
}

.topic-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.topic-name {
  margin: 0;
  font-size: 26px;
  font-weight: 600;
  color: var(--foreground);
  line-height: 1.2;
}

/* # 用弱化色，不然整个标题都在喊 */
.topic-name .hash {
  color: var(--accent);
  margin-right: 2px;
}

.topic-stat {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--muted-foreground);
}

/* ===== 相关话题 ===== */
.related {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 20px;
}

.related-label {
  font-size: 13px;
  color: var(--muted-foreground);
  margin-right: 2px;
}

.related-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--foreground);
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.related-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.related-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.related-count {
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

/* ===== 分页 ===== */
.pager {
  display: flex;
  justify-content: center;
  padding-top: 20px;
}

.no-more {
  font-size: 13px;
  color: var(--muted-foreground);
}
</style>
