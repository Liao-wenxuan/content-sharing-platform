<script setup lang="ts">
/**
 * 桌面端顶部栏
 *
 * 布局：左搜索框（撑满）→ 右「发布」按钮 + 主题切换 + 消息铃铛 + 用户菜单。
 * 用户菜单把「个人主页 / 设置 / 退出」收进 ElDropdown，
 * 避免在窄栏里堆一排图标按钮。
 *
 * 搜索：输入时下拉给出「笔记 / 话题 / 用户」三类建议，回车进 /search?q=xxx。
 * 搜索词和 URL 双向同步，所以结果页点顶栏的返回 / 后退 / 刷新都不会串味。
 * 下拉是自己写的面板而不是 el-autocomplete：内容要分三组、每组样式不同，
 * 套组件反而更绕，而且需要完整的 ↑↓ / Enter / Esc 键盘导航。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Search,
  EditPen,
  Moon,
  Sunny,
  ArrowDown,
  SwitchButton,
  User,
  Setting,
  Bell,
  Clock,
  PriceTag,
  TrendCharts,
  Delete
} from '@element-plus/icons-vue'
import { postsApi, type SuggestResponse } from '@/api/posts'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { useTheme } from '@/composables/useTheme'
import { useSearchHistory } from '@/composables/useSearchHistory'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()
const { isDark, toggleTheme } = useTheme()
const {
  history,
  save: saveHistory,
  remove: removeHistory,
  clear: clearHistory
} = useSearchHistory()

const keyword = ref('')
const focused = ref(false)
const wrapRef = ref<HTMLElement | null>(null)
const suggest = ref<SuggestResponse>({ query: '', hotTopics: [], posts: [], topics: [], users: [] })
const activeIndex = ref(-1)

/** URL 上的 q 是唯一真源，输入框只是它的投影 */
const urlQuery = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))

watch(
  urlQuery,
  (q) => {
    keyword.value = q
  },
  { immediate: true }
)

/** 面板只在「有焦点」且「有可展示内容」时出现 */
const panelVisible = computed(() => focused.value && groups.value.length > 0)

/** 展平成一条线性列表，键盘 ↑↓ 直接按下标走 */
type Row =
  | { kind: 'history'; value: string }
  | { kind: 'topic'; value: string; count?: number }
  | { kind: 'post'; value: string; id: number; cover: string | null }
  | { kind: 'user'; value: string; id: number; avatar: string | null }

const rows = computed<Row[]>(() => {
  const q = keyword.value.trim()
  const out: Row[] = []
  // 没输入时先给历史和热门话题，让下拉一打开就有东西
  if (!q) {
    for (const h of history.value) out.push({ kind: 'history', value: h })
    for (const t of suggest.value.hotTopics)
      out.push({ kind: 'topic', value: t.tag, count: t.count })
    return out
  }
  for (const t of suggest.value.topics) out.push({ kind: 'topic', value: t })
  for (const p of suggest.value.posts)
    out.push({ kind: 'post', value: p.content, id: p.id, cover: p.cover })
  for (const u of suggest.value.users)
    out.push({ kind: 'user', value: u.nickname, id: u.id, avatar: u.avatar })
  return out
})

/** 按类型分组渲染，顺序与 rows 一致（键盘下标才对得上） */
const groups = computed(() => {
  const buckets: { kind: Row['kind']; title: string; items: Row[] }[] = [
    { kind: 'history', title: '最近搜索', items: [] },
    { kind: 'topic', title: '话题', items: [] },
    { kind: 'post', title: '笔记', items: [] },
    { kind: 'user', title: '用户', items: [] }
  ]
  const byKind = Object.fromEntries(buckets.map((b) => [b.kind, b.items]))
  for (const r of rows.value) byKind[r.kind].push(r)
  return buckets.filter((b) => b.items.length > 0)
})

function isRowActive(row: Row) {
  return rows.value[activeIndex.value] === row
}

// ===== 请求建议 =====
let reqSeq = 0

async function loadSuggest(q: string) {
  const seq = ++reqSeq
  try {
    const res = await postsApi.suggest({ q })
    // 过期响应直接丢：快速连打时后到的旧请求不能覆盖新结果
    if (seq !== reqSeq) return
    suggest.value = res
  } catch {
    if (seq === reqSeq)
      suggest.value = { query: q, hotTopics: [], posts: [], topics: [], users: [] }
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined

function onInput() {
  activeIndex.value = -1
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => loadSuggest(keyword.value.trim()), 250)
}

function onFocus() {
  focused.value = true
  // 打开时也拉一次：没输入要拿热门话题填面板
  loadSuggest(keyword.value.trim())
}

function onBlur() {
  // 延迟关闭：否则 mousedown 在面板里的点击会先触发 blur，点了没反应
  setTimeout(() => {
    focused.value = false
    activeIndex.value = -1
  }, 150)
}

// ===== 交互 =====
function onSearch() {
  const kw = keyword.value.trim()
  if (!kw) {
    if (route.name === 'search') router.push({ name: 'search' })
    return
  }
  saveHistory(kw)
  focused.value = false
  if (route.name !== 'search' || urlQuery.value !== kw) {
    router.push({ name: 'search', query: { q: kw } })
  }
}

function onClear() {
  keyword.value = ''
  activeIndex.value = -1
  suggest.value = { query: '', hotTopics: [], posts: [], topics: [], users: [] }
  if (route.name === 'search') router.push({ name: 'search' })
}

/** 选中一条建议：笔记进详情、用户进主页、话题和历史按关键词搜 */
function pickRow(row: Row) {
  focused.value = false
  if (row.kind === 'post') {
    router.push(`/post/${row.id}`)
    return
  }
  if (row.kind === 'user') {
    router.push(`/profile/${row.id}`)
    return
  }
  keyword.value = row.value
  saveHistory(row.value)
  router.push({ name: 'search', query: { q: row.value } })
}

/** 只有下拉开着时才拦方向键，否则要留给页面滚动 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    focused.value = false
    activeIndex.value = -1
    return
  }
  if (!panelVisible.value) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % rows.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + rows.value.length) % rows.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (activeIndex.value >= 0 && rows.value[activeIndex.value]) {
      pickRow(rows.value[activeIndex.value])
    } else {
      onSearch()
    }
  }
}

function onHistoryRemove(value: string) {
  removeHistory(value)
  loadSuggest(keyword.value.trim())
}

function onHistoryClear() {
  clearHistory()
  loadSuggest(keyword.value.trim())
}

const avatarText = computed(() => auth.user?.nickname?.[0]?.toUpperCase() || '?')

function goPublish() {
  router.push('/publish')
}

function goMessages() {
  router.push('/messages')
}

function handleCommand(command: string) {
  if (command === 'profile') {
    router.push('/profile/me')
    return
  }
  if (command === 'settings') {
    router.push('/settings')
    return
  }
  if (command === 'logout') {
    auth.logout()
    toast.show('已退出登录', 'success')
    if (route.meta.requiresAuth) router.push('/')
  }
}

// 路由一变就收起面板，避免切页后下拉还挂在旧页面上
watch(
  () => route.fullPath,
  () => {
    focused.value = false
    activeIndex.value = -1
  }
)

// 组件卸载时清掉挂着的定时器
watch(
  () => wrapRef.value,
  () => {
    nextTick(() => {
      document.addEventListener('click', onOutsideClick)
    })
  },
  { immediate: true }
)

function onOutsideClick(e: MouseEvent) {
  if (wrapRef.value && !wrapRef.value.contains(e.target as Node)) {
    focused.value = false
    activeIndex.value = -1
  }
}
</script>

<template>
  <header class="top-bar">
    <!-- 搜索 + 建议下拉 -->
    <div ref="wrapRef" class="search-wrap" @keydown="onKeydown">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索你感兴趣的内容"
        :prefix-icon="Search"
        clearable
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keyup.enter="onSearch"
        @clear="onClear"
      />

      <div v-if="panelVisible" class="suggest-panel">
        <template v-for="g in groups" :key="g.kind">
          <div class="group-title">{{ g.title }}</div>
          <button
            v-for="row in g.items"
            :key="`${g.kind}-${'id' in row ? row.id : row.value}`"
            type="button"
            class="suggest-row"
            :class="{ active: isRowActive(row) }"
            @mousedown.prevent="pickRow(row)"
          >
            <!-- 笔记：封面缩略图 -->
            <img
              v-if="row.kind === 'post'"
              class="row-cover"
              :src="row.cover || ''"
              alt=""
              @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
            />
            <!-- 用户：头像 -->
            <el-avatar
              v-else-if="row.kind === 'user'"
              class="row-avatar"
              :size="24"
              :src="row.avatar || undefined"
            >
              {{ row.value.slice(0, 1) }}
            </el-avatar>
            <el-icon v-else class="row-icon">
              <component :is="row.kind === 'history' ? Clock : PriceTag" />
            </el-icon>

            <span class="row-text">{{ row.value }}</span>

            <span v-if="row.kind === 'topic' && row.count" class="row-count">
              {{ row.count }} 篇
            </span>
            <el-button
              v-else-if="row.kind === 'history'"
              link
              class="row-del"
              @click.stop="onHistoryRemove(row.value)"
            >
              <el-icon><component :is="Delete" /></el-icon>
            </el-button>
          </button>
        </template>

        <!-- 只有一个清空按钮时挂在面板底部 -->
        <div v-if="history.length && !keyword.trim()" class="panel-footer">
          <el-button link size="small" @click="onHistoryClear">
            <el-icon><component :is="Delete" /></el-icon> 清空搜索历史
          </el-button>
          <span class="panel-hint">
            <el-icon><component :is="TrendCharts" /></el-icon> ↑↓ 选择 · Enter 打开 · Esc 关闭
          </span>
        </div>
      </div>
    </div>

    <div class="bar-actions">
      <el-button type="primary" :icon="EditPen" class="publish-btn" @click="goPublish">
        发布笔记
      </el-button>

      <el-tooltip :content="isDark ? '切换到浅色' : '切换到深色'" placement="bottom">
        <el-button
          class="icon-btn"
          circle
          :icon="isDark ? Sunny : Moon"
          aria-label="切换主题"
          @click="toggleTheme"
        />
      </el-tooltip>

      <!-- 消息：侧栏不再放这一项，改成顶栏铃铛（仅登录态） -->
      <el-tooltip v-if="auth.isLoggedIn" content="消息" placement="bottom">
        <el-button class="icon-btn" circle :icon="Bell" aria-label="消息" @click="goMessages" />
      </el-tooltip>

      <!-- 已登录：头像下拉 -->
      <el-dropdown v-if="auth.isLoggedIn" trigger="click" @command="handleCommand">
        <button type="button" class="user-trigger">
          <el-avatar :size="32" :src="auth.user?.avatar || undefined">
            {{ avatarText }}
          </el-avatar>
          <span class="user-name">{{ auth.user?.nickname }}</span>
          <el-icon class="arrow"><component :is="ArrowDown" /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="profile" :icon="User">个人主页</el-dropdown-item>
            <el-dropdown-item command="settings" :icon="Setting">设置</el-dropdown-item>
            <el-dropdown-item command="logout" :icon="SwitchButton" divided>
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <!-- 未登录：登录按钮 -->
      <el-button
        v-else
        type="primary"
        plain
        @click="router.push({ name: 'login', query: { redirect: route.fullPath } })"
      >
        登录
      </el-button>
    </div>
  </header>
</template>

<style scoped>
.top-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 16px;
  height: var(--top-bar-height);
  padding: 0 24px;
  background: var(--background);
  border-bottom: 1px solid var(--border);
}

/* ===== 搜索 ===== */
.search-wrap {
  position: relative;
  flex: 0 1 480px;
}

.search-input {
  width: 100%;
}

.suggest-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 420px;
  overflow-y: auto;
  padding: 6px;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 28%);
}

.group-title {
  padding: 8px 10px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
  letter-spacing: 0.02em;
}

.suggest-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 14px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.suggest-row:hover,
.suggest-row.active {
  background: var(--muted);
}

.row-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-icon {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--muted-foreground);
}

.row-cover,
.row-avatar {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--muted);
}

.row-avatar {
  border-radius: 999px;
}

.row-count {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted-foreground);
}

.row-del {
  flex-shrink: 0;
  opacity: 0;
}

.suggest-row:hover .row-del {
  opacity: 1;
}

.panel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
  padding: 8px 10px 4px;
  border-top: 1px solid var(--border);
}

.panel-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted-foreground);
}

/* ===== 右侧动作区 ===== */
.bar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.publish-btn {
  font-weight: 600;
}

.icon-btn {
  flex-shrink: 0;
}

.user-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--foreground);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}

.user-trigger:hover {
  background: var(--muted);
}

.user-name {
  font-weight: 500;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arrow {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
