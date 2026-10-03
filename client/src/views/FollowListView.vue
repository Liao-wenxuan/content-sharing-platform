<script setup lang="ts">
/**
 * 粉丝 / 关注列表
 *
 * 一个页面两个 Tab（query.tab 切换），因为两个列表的 UI 完全一样，
 * 拆成两个页面会多出一份几乎逐字重复的模板。
 *
 * 为什么 Tab 放 query 而不是组件局部 state：
 * 用户从主页点「粉丝」进来、点「关注」再切回来时，Tab 和滚动位置
 * 都得保持；放进 query 还能直接分享链接（「他有多少粉丝」是会被问的问题）。
 *
 * 列表每一行自带 isFollowing（后端批量给的），
 * 所以点「关注」只改这一行 + 顶部的计数，不发额外请求。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { followsApi, type FollowUser } from '@/api/follows'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import EmptyState from '@/components/EmptyState.vue'

type TabKey = 'followers' | 'following'

const route = useRoute()
const auth = useAuthStore()
const toast = useToastStore()

const targetId = computed<number | null>(() => {
  const num = Number(route.params.id)
  return Number.isInteger(num) && num > 0 ? num : null
})

const isOwner = computed(() => auth.user?.id === targetId.value)

const activeTab = computed<TabKey>(() =>
  route.query.tab === 'following' ? 'following' : 'followers'
)

const list = ref<FollowUser[]>([])
const total = ref(0)
const page = ref(1)
const hasMore = ref(false)
const loading = ref(false)
const errorMsg = ref('')
/** 正在提交的行 id，防止同一行连点 */
const busyId = ref<number | null>(null)

const PAGE_SIZE = 20

const emptyTitle = computed(() =>
  activeTab.value === 'followers'
    ? isOwner.value
      ? '还没有粉丝'
      : '还没有人关注 TA'
    : isOwner.value
      ? '还没有关注任何人'
      : 'TA 还没有关注任何人'
)

async function load(reset: boolean) {
  const id = targetId.value
  if (!id) {
    errorMsg.value = '用户 id 无效'
    return
  }

  if (reset) {
    page.value = 1
    list.value = []
    errorMsg.value = ''
  }
  loading.value = true

  try {
    const data =
      activeTab.value === 'followers'
        ? await followsApi.followers(id, { page: page.value, pageSize: PAGE_SIZE })
        : await followsApi.following(id, { page: page.value, pageSize: PAGE_SIZE })
    list.value = reset ? data.list : [...list.value, ...data.list]
    total.value = data.pagination.total
    hasMore.value = data.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function loadMore() {
  if (loading.value || !hasMore.value) return
  page.value += 1
  void load(false)
}

/** 行内关注 / 取关：就地改这一行，成功后用服务端计数对齐顶部数字 */
async function toggleRow(user: FollowUser) {
  if (busyId.value !== null) return
  if (!auth.isLoggedIn) {
    toast.show('登录后才能关注', 'info')
    return
  }

  busyId.value = user.id
  const next = !user.isFollowing
  // 乐观更新
  user.isFollowing = next
  try {
    const res = next ? await followsApi.follow(user.id) : await followsApi.unfollow(user.id)
    // 只在「我关注的人」列表里取关才会让列表变短
    if (activeTab.value === 'following' && !next) {
      list.value = list.value.filter((u) => u.id !== user.id)
      total.value = Math.max(0, total.value - 1)
    } else {
      total.value = res.followerCount
    }
  } catch {
    user.isFollowing = !next
    toast.show(next ? '关注失败' : '取消关注失败', 'error')
  } finally {
    busyId.value = null
  }
}

function avatarText(nickname: string): string {
  return nickname?.[0]?.toUpperCase() || '?'
}

onMounted(() => load(true))

// 切 Tab 或换用户：整页重载
watch([activeTab, targetId], () => load(true))
</script>

<template>
  <div class="follow-list">
    <div class="head">
      <h1 class="title">
        {{ activeTab === 'followers' ? '粉丝' : '关注' }}
        <span class="total">{{ total }}</span>
      </h1>
      <p class="subtitle">
        {{ activeTab === 'followers' ? '关注了这个账号的所有人' : '这个账号关注的所有人' }}
      </p>
    </div>

    <el-tabs :model-value="activeTab" class="tabs">
      <el-tab-pane label="粉丝" name="followers" />
      <el-tab-pane label="关注" name="following" />
    </el-tabs>

    <EmptyState v-if="errorMsg" variant="error" :title="errorMsg" />

    <EmptyState v-else-if="loading && list.length === 0" variant="loading" title="加载中..." />

    <EmptyState v-else-if="list.length === 0" variant="empty" :title="emptyTitle" />

    <ul v-else class="rows">
      <li v-for="u in list" :key="u.id" class="row">
        <router-link :to="`/profile/${u.id}`" class="row-link">
          <el-avatar :size="44" :src="u.avatar || undefined">
            {{ avatarText(u.nickname) }}
          </el-avatar>
          <div class="row-info">
            <div class="row-name">{{ u.nickname }}</div>
            <div class="row-meta">{{ u.postCount }} 篇笔记</div>
          </div>
        </router-link>

        <el-button
          v-if="u.id !== auth.user?.id"
          size="small"
          round
          :type="u.isFollowing ? 'default' : 'primary'"
          :plain="!u.isFollowing"
          :loading="busyId === u.id"
          @click="toggleRow(u)"
        >
          {{ u.isFollowing ? '已关注' : '关注' }}
        </el-button>
      </li>
    </ul>

    <div v-if="hasMore && list.length > 0" class="more">
      <el-button :loading="loading" @click="loadMore">加载更多</el-button>
    </div>
  </div>
</template>

<style scoped>
.follow-list {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  margin-bottom: 4px;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--foreground);
}

.total {
  margin-left: 6px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.tabs {
  margin-bottom: 8px;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
}

.row-link {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  text-decoration: none;
  color: inherit;
}

.row-info {
  min-width: 0;
}

.row-name {
  font-size: 15px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.more {
  display: flex;
  justify-content: center;
  padding: 20px 0;
}
</style>
