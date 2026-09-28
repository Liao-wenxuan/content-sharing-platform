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
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Compass, EditPen, ChatDotRound, Shop, User, Setting } from '@element-plus/icons-vue'
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
  { path: '/publish', label: '发布', icon: EditPen, requiresAuth: true },
  { path: '/messages', label: '消息', icon: ChatDotRound, requiresAuth: true },
  { path: '/market', label: '市集', icon: Shop },
  { path: '/profile/me', label: '我的', icon: User },
  { path: '/settings', label: '设置', icon: Setting, requiresAuth: true }
]

const visibleItems = computed(() =>
  navItems.filter((item) => !item.requiresAuth || auth.isLoggedIn)
)

/** 当前高亮的菜单项 */
const activeMenu = computed(() => {
  const path = route.path
  if (path.startsWith('/profile')) return '/profile/me'
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
