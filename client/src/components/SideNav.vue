<script setup lang="ts">
/**
 * 桌面端左侧固定导航
 *
 * 取代原来的移动端抽屉 Sidebar + 底部 BottomNav：
 * 桌面端不需要「展开 / 收起」，导航常驻左栏即可。
 *
 * 选中态：ElMenu 的 router 模式 + :default-active 绑 route.path。
 * 个人主页 /profile/me 在访客态也可能命中（见 ProfileView 的占位态），
 * 这里统一回落到「我的」这一项。
 *
 * 只放「需要反复切换」的主干入口：搜索在顶栏（带即时建议下拉），
 * 消息做成顶栏铃铛，侧栏留给频道级浏览，避免导航项越堆越多。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Compass, EditPen, Shop, User, Setting, Star, Collection } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

interface NavItem {
  path: string
  label: string
  icon: unknown
  /** 需要登录才显示（未登录点进去也只会被路由守卫弹回登录页） */
  requiresAuth?: boolean
}

const navItems: NavItem[] = [
  { path: '/', label: '发现', icon: Compass },
  // 和「发现」共用 `/` 这一个 path（只是 query 的差别），见 activeMenu
  { path: '/?channel=follow', label: '关注', icon: Star, requiresAuth: true },
  { path: '/publish', label: '发布', icon: EditPen, requiresAuth: true },
  { path: '/market', label: '市集', icon: Shop },
  // 收藏夹管理页：主页「收藏」tab 只管看，整理归类放这里
  { path: '/favorites', label: '收藏', icon: Collection, requiresAuth: true },
  { path: '/profile/me', label: '我的', icon: User },
  { path: '/settings', label: '设置', icon: Setting, requiresAuth: true }
]

const visibleItems = computed(() =>
  navItems.filter((item) => !item.requiresAuth || auth.isLoggedIn)
)

/** 是否停在关注流（发现页的 channel=follow 视图） */
const isFollowRoute = computed(() => route.path === '/' && route.query.channel === 'follow')

/**
 * 当前高亮的菜单项。
 *
 * 「发现」和「关注」共用 `/` 这一个 path，只按 path 判会同时高亮两项，
 * 所以 `/` 要单独判 query。
 *
 * 早期版本给 NavItem 加了个 match() 让「发现」优先匹配，
 * 结果发现项的 match 在**所有**非关注路由上都返回 true，
 * find() 第一个就命中，于是 /favorites、/settings、/market 全被高亮成「发现」。
 * match() 这种「靠第一个 true 决定结果」的写法太容易误伤，
 * 改成按 path 穷举，每个分支都能一眼看出该高亮谁。
 */
const activeMenu = computed(() => {
  const path = route.path
  if (path === '/') return isFollowRoute.value ? '/?channel=follow' : '/'
  if (path.startsWith('/profile')) return '/profile/me'
  // 笔记详情和搜索的入口不在侧栏，回落高亮「发现」保持连贯
  if (path.startsWith('/post')) return '/'
  if (path.startsWith('/search')) return '/'
  return path
})

function handleCommand(command: string) {
  if (command === 'logout') {
    auth.logout()
    toast.show('已退出登录', 'success')
    if (route.meta.requiresAuth) router.push('/')
    return
  }
  if (command === 'login') {
    router.push({ name: 'login', query: { redirect: route.fullPath } })
  }
}
</script>

<template>
  <aside class="side-nav">
    <!-- 品牌区 -->
    <div class="brand">
      <span class="brand-mark">拾</span>
      <span class="brand-name">内容社区</span>
    </div>

    <!-- 主导航 -->
    <el-menu :default-active="activeMenu" :router="true" class="nav-menu">
      <el-menu-item v-for="item in visibleItems" :key="item.path" :index="item.path">
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ item.label }}</span>
      </el-menu-item>
    </el-menu>

    <!-- 底部：登录入口 / 创作引导 -->
    <div class="side-footer">
      <template v-if="auth.isLoggedIn">
        <p class="footer-tip">记录当下，分享生活</p>
      </template>
      <el-button v-else type="primary" class="login-btn" @click="handleCommand('login')">
        登录 / 注册
      </el-button>
    </div>
  </aside>
</template>

<style scoped>
.side-nav {
  width: var(--side-nav-width);
  flex-shrink: 0;
  height: 100vh;
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--background);
  padding: 20px 12px;
}

/* ===== 品牌 ===== */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 20px;
}

.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.brand-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--foreground);
}

/* ===== 导航 ===== */
.nav-menu {
  border-right: none;
  flex: 1;
}

.nav-menu :deep(.el-menu-item) {
  height: 42px;
  line-height: 42px;
  border-radius: 8px;
  margin-bottom: 2px;
  font-size: 14px;
  font-weight: 500;
  color: var(--foreground);
}

.nav-menu :deep(.el-menu-item.is-active) {
  background: var(--muted);
  color: var(--accent);
  font-weight: 600;
}

.nav-menu :deep(.el-menu-item:hover) {
  background: var(--muted);
}

/* ===== 底部 ===== */
.side-footer {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.footer-tip {
  margin: 0;
  padding: 0 8px;
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.6;
}

.login-btn {
  width: 100%;
  font-weight: 600;
}
</style>
