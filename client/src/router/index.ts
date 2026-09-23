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
      // 别人的 profile 公开；自己的需要登录（LoginView 在 publish 也有类似处理）
      // 这里只在 LoginView 里判，避免误伤他人主页
      component: () => import('@/views/ProfileView.vue'),
      meta: { requiresAuthMe: true }
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
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { requiresAuth: true }
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

  // 自己的 profile 需要登录；他人 profile 公开
  if (to.meta.requiresAuthMe && to.params.id === 'me' && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  return true
})

export default router