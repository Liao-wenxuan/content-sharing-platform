import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue')
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      // 已登录用户进 /login 直接跳首页
      meta: { guestOnly: true }
    },
    {
      path: '/post/:id',
      name: 'post-detail',
      component: () => import('@/views/PostDetailView.vue')
    },
    {
      path: '/publish',
      name: 'publish',
      component: () => import('@/views/PublishView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/profile/:id',
      name: 'profile',
      // 个人主页公开可访问：未登录时进 /profile/me 展示「未登录」占位态，
      // 由页面内部的「登录」按钮引导，而不是路由层直接拦到登录页。
      component: () => import('@/views/ProfileView.vue')
    },
    {
      path: '/messages',
      name: 'messages',
      component: () => import('@/views/MessagesView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/market',
      name: 'market',
      component: () => import('@/views/MarketView.vue')
    },
    {
      // 搜索结果页：关键词走 ?q=，所以可分享 / 可刷新 / 可前进后退
      path: '/search',
      name: 'search',
      component: () => import('@/views/SearchView.vue')
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { requiresAuth: true }
    },
    {
      // 404 catch-all：未知路径都进 NotFoundView
      // 用 pathMatch 拿到原始 path，便于未来诊断
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue')
    }
  ]
})

// ===== 全局前置守卫 =====
router.beforeEach((to) => {
  const auth = useAuthStore()

  // 已登录用户访问 /login → 跳首页（避免登录页回环）
  if (to.meta.guestOnly && auth.isLoggedIn) {
    return { name: 'home' }
  }

  // 需要登录但未登录 → 跳登录，附 redirect 参数
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  return true
})

export default router
