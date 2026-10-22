import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
// 首页**故意不走懒加载**。
//
// 限速实测（scripts/perf-smoke.mjs，Slow 4G）给出的时间线：
//   FCP 1240ms → /api/feed 1792ms 才发起
// 中间这 552ms 花在「下载首页 chunk + 挂载组件」上 ——
// 而这段时间里用户看着的是已经渲染出来、却空空如也的骨架。
//
// 首页 chunk 只有约 10KB（HomeView + PostMasonry + EmptyState），
// 换来的是省掉一次「等 chunk 下完 → 执行 → 才能发接口」的串行。
// 入口 chunk 大 10KB 的代价，换首屏早 400ms 出现内容，划算。
import HomeView from '@/views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView
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
      // 站内 AI 对话。游客可进（问的是公开内容），
      // 登录只是为了「根据你的兴趣」给得更准。
      path: '/ai',
      name: 'ai-chat',
      component: () => import('@/views/AiChatView.vue')
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
      path: '/follows/:id',
      name: 'follow-list',
      // 粉丝 / 关注列表合用一页，Tab 走 query.tab
      component: () => import('@/views/FollowListView.vue'),
      // 公开可访问：未登录也能看粉丝/关注数（列表里的关注按钮会提示登录）
      props: true
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
      // 市集的四个子页都挂在 /market 下（不是散在根路径）：
      // SideNav 只给市集留一个入口，其余靠页面内的 MarketTabs 切换，
      // 侧栏因此不会退化成一份功能清单
      path: '/market/product/:id',
      name: 'product-detail',
      component: () => import('@/views/ProductDetailView.vue'),
      props: true
    },
    {
      // 卖家管理自己商品的地方。
      //
      // 放在 /market/mine 而不是 /my/products：市集的子页都在 /market 下，
      // 散到根路径会让 MarketTabs 的高亮判断多一个分支。
      path: '/market/mine',
      name: 'my-products',
      component: () => import('@/views/MyProductsView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/market/cart',
      name: 'cart',
      component: () => import('@/views/CartView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/market/orders',
      name: 'orders',
      component: () => import('@/views/OrdersView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/market/wallet',
      name: 'wallet',
      component: () => import('@/views/WalletView.vue'),
      meta: { requiresAuth: true }
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
      // 收藏夹管理（建夹 / 改名 / 删夹 / 批量整理未分类）
      path: '/favorites',
      name: 'favorites',
      component: () => import('@/views/FavoritesView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/topic/:tag',
      name: 'topic',
      component: () => import('@/views/TopicView.vue'),
      // 话题名是中文，URL 里必须 encodeURIComponent。
      // 路由本身不强制编码 —— vue-router 会把 params 解码一次，
      // 由 topicPath() 负责编码，跳转时不需要关心
      props: true
    },
    {
      // 浏览记录：私密、只对「我」有意义，所以是独立页面而不是个人主页的第五个 tab
      path: '/history',
      name: 'history',
      component: () => import('@/views/ViewHistoryView.vue'),
      meta: { requiresAuth: true }
    },
    {
      // 兴趣画像：推荐流的可解释 + 可纠正入口。
      // 不要求登录 —— 未登录时展示的是「为什么你现在没有画像」，
      // 这本身也是对冷启动排序的解释，跳走反而更不诚实
      path: '/interest',
      name: 'interest',
      component: () => import('@/views/InterestView.vue')
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
