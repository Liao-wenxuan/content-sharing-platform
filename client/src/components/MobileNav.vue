<script setup lang="ts">
/**
 * 移动端底部导航（≤768px）
 *
 * 桌面端侧栏是常驻的 216px 左栏，窄屏下它不会折叠 ——
 * 375 宽的手机上等于先砍掉一大半可用宽度，再让 TopBar 挤成一条。
 * 这里不改动桌面端的三栏结构，只在窄屏把侧栏换成底栏：
 * 同一个断点由 SideNav（隐藏）、App.vue（留底部安全区）、TopBar（收敛动作区）、
 * 本组件（显示）各自用 CSS 判断，不需要 JS 监听 resize，也就不会在
 * 首屏闪一下「先是侧栏、再变底栏」。
 *
 * 五个格子始终都在，包括未登录时的「关注 / 发布 / 消息」：
 * 按登录态过滤会让底栏在登录后突然从 3 格跳成 5 格，
 * 而且游客根本不知道这个站有发布功能。未登录点需要登录的项，
 * 统一带 redirect 去登录页，回来还在原来想去的地方。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Compass, Star, EditPen, Bell, User } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'

interface NavItem {
  key: string
  label: string
  icon: unknown
  path: string
  query?: Record<string, string>
  requiresAuth?: boolean
}

const items: NavItem[] = [
  { key: 'home', label: '发现', icon: Compass, path: '/' },
  {
    key: 'follow',
    label: '关注',
    icon: Star,
    path: '/',
    query: { channel: 'follow' },
    requiresAuth: true
  },
  { key: 'publish', label: '发布', icon: EditPen, path: '/publish', requiresAuth: true },
  { key: 'messages', label: '消息', icon: Bell, path: '/messages', requiresAuth: true },
  { key: 'me', label: '我的', icon: User, path: '/profile/me' }
]

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

/**
 * 高亮按 path 穷举，不用 match() 那种「第一个 true 命中」的写法。
 * 详情 / 搜索 / 话题页的入口都不在底栏，回落高亮「发现」保持连贯；
 * 设置、收藏、浏览记录这些是从「我的」下钻的，高亮回「我的」。
 */
const activeKey = computed(() => {
  const p = route.path
  if (p === '/') return route.query.channel === 'follow' ? 'follow' : 'home'
  if (p.startsWith('/follows')) return 'follow'
  if (p.startsWith('/publish')) return 'publish'
  if (p.startsWith('/messages') || p.startsWith('/chat')) return 'messages'
  if (
    p.startsWith('/profile') ||
    p.startsWith('/favorites') ||
    p.startsWith('/settings') ||
    p.startsWith('/interest') ||
    p.startsWith('/view-history') ||
    p.startsWith('/switch-account')
  ) {
    return 'me'
  }
  if (p.startsWith('/post') || p.startsWith('/search') || p.startsWith('/topic')) return 'home'
  return 'home'
})

function go(item: NavItem) {
  if (item.requiresAuth && !auth.isLoggedIn) {
    const target = item.query ? `${item.path}?${new URLSearchParams(item.query)}` : item.path
    router.push({ name: 'login', query: { redirect: target } })
    return
  }
  router.push({ path: item.path, query: item.query })
}
</script>

<template>
  <nav class="mobile-nav" aria-label="主导航">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="nav-item"
      :class="{ 'is-active': activeKey === item.key, 'is-publish': item.key === 'publish' }"
      :aria-current="activeKey === item.key ? 'page' : undefined"
      :aria-label="item.label"
      @click="go(item)"
    >
      <span class="nav-icon-wrap">
        <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
      </span>
      <span class="nav-label">{{ item.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
/*
 * 默认藏在桌面端。用 display:none 而不是 v-if：axe 会跳过隐藏节点，
 * 桌面端的 a11y 审计不会被多出来的一套导航干扰。
 */
.mobile-nav {
  display: none;
}

@media (max-width: 768px) {
  .mobile-nav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    display: flex;
    align-items: stretch;
    height: calc(58px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    border-top: 1px solid var(--border);
    background: var(--background);
    /* 内容滚到底栏下面时，半透明 + 模糊比纯色更容易看出「这是浮层」 */
    backdrop-filter: blur(12px);
  }

  .nav-item {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 6px 2px;
    border: none;
    background: transparent;
    color: var(--text-2);
    font-family: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .nav-item:active {
    background: var(--surface-2);
  }

  .nav-item.is-active {
    color: var(--accent);
  }

  .nav-icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-full);
    transition: background-color var(--dur-fast) var(--ease-out-expo);
  }

  /* 发布是唯一「写」操作，中间给个实心圆让它和其它四格区分开 */
  .nav-item.is-publish .nav-icon-wrap {
    width: 30px;
    height: 30px;
    background: var(--accent);
    /* ⚠️ 不能用 #fff：深色主题里 --accent 是亮黄绿，白字压上去几乎看不见。
       --accent-foreground 是专门配好的「压在强调色块上的字色」，深色下是深炭 */
    color: var(--accent-foreground);
  }

  .nav-item.is-publish.is-active .nav-icon-wrap {
    box-shadow:
      0 0 0 2px var(--background),
      0 0 0 3px var(--accent);
  }

  .nav-icon {
    font-size: 18px;
  }

  .nav-label {
    font-size: var(--fs-2xs);
    line-height: 1.2;
    white-space: nowrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-icon-wrap {
    transition: none;
  }
}
</style>
