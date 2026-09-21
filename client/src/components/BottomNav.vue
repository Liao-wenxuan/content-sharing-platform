<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

// 5 个 tab — 第 3 个是中间圆形 + 按钮
interface Tab {
  to: string
  label: string
  icon: string  // simple SVG path d
  match?: (path: string) => boolean  // 自定义激活判断；马匹/我的/消息 默认按 path prefix
}

const isActive = (path: string, match?: (p: string) => boolean) => {
  if (match) return match(path)
  // 默认：精确匹配或子路径（排除 /publish /messages /profile/* 这些特殊情况）
  if (path === '/') return route.path === '/'
  if (path === '/messages') return route.path.startsWith('/messages')
  if (path === '/profile/me') return route.path.startsWith('/profile')
  if (path === '/market') return route.path.startsWith('/market')
  return false
}

const tabs: Tab[] = [
  {
    to: '/',
    label: '首页',
    icon: 'M3 12L12 3l9 9M5 10v10h14V10'
  },
  {
    to: '/market',
    label: '市集',
    icon: 'M3 7h18l-2 13H5L3 7zM8 7V5a4 4 0 0 1 8 0v2'
  },
  // 第 3 个是中间 + 按钮，独立渲染
  {
    to: '/publish',
    label: '发布',
    icon: 'M12 5v14M5 12h14',
    match: () => false  // 永不 active 高亮
  },
  {
    to: '/messages',
    label: '消息',
    icon: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'
  },
  {
    to: '/profile/me',
    label: '我',
    icon: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'
  }
]

// 未登录时访问 /profile/me → 自动跳 /login（在路由里处理）
// 这里提供一个点击拦截：如果未登录，强制去 login
const handleProfile = (e: MouseEvent) => {
  // Pinia 状态在 setup 之外访问要确保 Pinia 已激活；用 useAuthStore 更安全
  // 这里仅路由跳转，由 router 守卫接管
  void e
}
void handleProfile  // 占位防 lint 报未用
</script>

<template>
  <nav class="bottom-nav">
    <router-link
      v-for="(tab, i) in tabs"
      :key="tab.to"
      :to="tab.to"
      class="tab"
      :class="{
        active: isActive(tab.to, tab.match),
        center: i === 2
      }"
    >
      <!-- 中间 + 按钮：圆形大按钮，无 label -->
      <template v-if="i === 2">
        <span class="plus">+</span>
      </template>
      <template v-else>
        <svg viewBox="0 0 24 24" class="tab-icon" aria-hidden="true">
          <path :d="tab.icon" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tab-label">{{ tab.label }}</span>
      </template>
    </router-link>
  </nav>
</template>

<style scoped>
.bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: grid;
  /* 5 等分，中间 + 占位与其余 4 个等宽 */
  grid-template-columns: repeat(4, 1fr) 1.4fr;
  align-items: center;
  background: var(--background);
  border-top: 1px solid var(--border);
  padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
  z-index: 50;
}

.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 0;
  color: var(--muted-foreground);
  text-decoration: none;
  font-size: 11px;
  transition: color 0.15s;
}

.tab.active {
  color: var(--foreground);
  font-weight: 600;
}

.tab-icon {
  width: 22px;
  height: 22px;
  display: block;
}

.tab-label {
  line-height: 1;
}

/* 中间 + 按钮：圆形 accent 色 */
.tab.center {
  position: relative;
  margin: -22px 0 0;     /* 向上凸出半个身位 */
  height: 56px;
}

.tab.center .plus {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 30px;
  font-weight: 300;
  line-height: 1;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.tab.center:active .plus {
  transform: scale(0.94);
}
</style>