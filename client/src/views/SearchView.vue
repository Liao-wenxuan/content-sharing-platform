<script setup lang="ts">
/**
 * 搜索结果页
 *
 * 设计取舍：
 * - 独立路由 `/search?q=xxx` 而不是顶栏下拉：结果可分享、可刷新、能翻页
 * - 搜索词进 URL，浏览器前进后退天然可用，也不用自己管状态同步
 * - 命中关键词在标题里高亮（PostMasonry 的 highlight prop）
 * - 搜索历史存 localStorage，只留最近 10 条，可单条删除 / 清空
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Delete, Clock } from '@element-plus/icons-vue'
import { postsApi, type Post } from '@/api/posts'
import PostMasonry from '@/components/PostMasonry.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()

const HISTORY_KEY = 'sg:search-history'
const MAX_HISTORY = 10

const posts = ref<Post[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const total = ref(0)
const page = ref(1)
const hasMore = ref(false)
const sort = ref<'latest' | 'hot' | 'comment'>('latest')
const history = ref<string[]>([])

const SORTS = [
  { key: 'latest', label: '最新' },
  { key: 'hot', label: '最多点赞' },
  { key: 'comment', label: '最多评论' }
] as const

// ===== 搜索历史 =====
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    history.value = raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    history.value = []
  }
}

function saveHistory(kw: string) {
  const next = [kw, ...history.value.filter((h) => h !== kw)].slice(0, MAX_HISTORY)
  history.value = next
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}

function removeHistory(kw: string) {
  history.value = history.value.filter((h) => h !== kw)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
}

function clearHistory() {
  history.value = []
  localStorage.removeItem(HISTORY_KEY)
}

function useHistory(kw: string) {
  router.push({ name: 'search', query: { q: kw } })
}

function clearSearch() {
  router.push({ name: 'search' })
}

// ===== 查询 =====
const query = computed(() => (typeof route.query.q === 'string' ? route.query.q.trim() : ''))

async function runSearch(reset: boolean) {
  const kw = query.value
  if (!kw) {
    posts.value = []
    total.value = 0
    hasMore.value = false
    return
  }

  if (reset) {
    page.value = 1
    posts.value = []
  }
  loading.value = reset
  loadingMore.value = !reset
  errorMsg.value = ''

  try {
    const data = await postsApi.search({
      q: kw,
      page: page.value,
      pageSize: 20,
      sort: sort.value
    })
    posts.value.push(...data.list)
    total.value = data.pagination.total
    hasMore.value = data.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '搜索失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  page.value++
  await runSearch(false)
}

// URL 里的 q 变化 → 重新搜；排序变化由下面的 watch(sort) 处理
watch(query, (kw, prev) => {
  if (kw === prev) return
  if (kw) {
    saveHistory(kw)
    runSearch(true)
  } else {
    posts.value = []
    total.value = 0
    hasMore.value = false
  }
})

watch(sort, () => {
  if (query.value) runSearch(true)
})

onMounted(() => {
  loadHistory()
  if (query.value) {
    saveHistory(query.value)
    runSearch(true)
  }
})
</script>

<template>
  <div class="search-page">
    <!--
      这里不再放搜索框：顶栏的输入框是 sticky 的，任何滚动位置都能改关键词，
      页面内再放一个只会造成两个输入框互相干扰。
    -->

    <div v-if="query" class="result-meta">
      找到 <b>{{ total }}</b> 条与「<b>{{ query }}</b
      >」相关的笔记
      <el-radio-group v-model="sort" size="small" class="sort-group">
        <el-radio-button v-for="s in SORTS" :key="s.key" :value="s.key">
          {{ s.label }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <!-- 无关键词：显示历史 + 引导 -->
    <template v-if="!query">
      <el-card v-if="history.length" shadow="never" class="history-card">
        <template #header>
          <div class="card-head">
            <span class="card-title"
              ><el-icon><component :is="Clock" /></el-icon> 最近搜索</span
            >
            <el-button link size="small" @click="clearHistory">
              <el-icon><component :is="Delete" /></el-icon> 清空
            </el-button>
          </div>
        </template>
        <div class="history-list">
          <el-tag
            v-for="kw in history"
            :key="kw"
            class="history-tag"
            effect="plain"
            closable
            @click="useHistory(kw)"
            @close="removeHistory(kw)"
          >
            {{ kw }}
          </el-tag>
        </div>
      </el-card>

      <el-empty description="输入关键词，搜索笔记内容、话题或作者">
        <p class="hint">试试搜索：美食、职场、旅行、健身、柚子</p>
      </el-empty>
    </template>

    <!-- 有关键词 -->
    <template v-else>
      <EmptyState v-if="loading && posts.length === 0" variant="loading" title="搜索中..." />

      <EmptyState
        v-else-if="errorMsg"
        variant="error"
        :title="errorMsg"
        action="重试"
        @action="runSearch(true)"
      />

      <template v-else>
        <el-empty v-if="posts.length === 0" :description="`没有找到与「${query}」相关的内容`">
          <el-button @click="clearSearch">换个词试试</el-button>
        </el-empty>

        <PostMasonry v-else :posts="posts" :highlight="query" />

        <div v-if="posts.length > 0" class="pager">
          <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
          <span v-else class="no-more">— 共 {{ total }} 条，已全部显示 —</span>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.search-page {
  max-width: 1560px;
  margin: 0 auto;
}

/* ===== 结果计数 ===== */
.result-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  font-size: 13px;
  color: var(--muted-foreground);
}

.result-meta b {
  color: var(--foreground);
}

.sort-group {
  margin-left: auto;
}

/* ===== 历史 ===== */
.history-card {
  max-width: 720px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
}

.history-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.history-tag {
  cursor: pointer;
  border-radius: 999px;
}

.hint {
  font-size: 13px;
  color: var(--muted-foreground);
  margin: 0;
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
