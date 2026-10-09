<script setup lang="ts">
/**
 * 市集分区导航
 *
 * 市集有五个页面（橱窗 / 详情 / 购物车 / 订单 / 钱包），
 * 但它们在**侧栏只占一项**。
 *
 * 为什么不加进 SideNav：侧栏的定位是「频道级浏览」，
 * 已经放了发现 / 关注 / 发布 / 市集 / 收藏 / 我的 / 设置。
 * 再把购物车、订单、钱包铺进去，侧栏会变成一个功能清单而不是导航，
 * 每个入口都得靠图标猜意思。
 *
 * 所以做成页面内的分段导航 —— 和小红书「店铺 / 购物车 / 订单」在同一个
 * 页面顶部的做法一致，走进去之后相关的东西都在手边。
 */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useCart } from '@/composables/useCart'

const route = useRoute()
const auth = useAuthStore()
const { count, load } = useCart()

const tabs = [
  { path: '/market', label: '橱窗' },
  { path: '/market/cart', label: '购物车', auth: true },
  { path: '/market/orders', label: '订单', auth: true },
  { path: '/market/wallet', label: '钱包', auth: true }
]

const visibleTabs = tabs.filter((t) => !t.auth || auth.isLoggedIn)

/**
 * 当前高亮。
 *
 * 不用「第一个 startsWith 命中」那种写法（SideNav 踩过，
 * 见那里的注释），而是每个分支显式判，最后兜底。
 * 兜底是「橱窗」：/market 自己和 /market/product/:id 都归它 ——
 * 商品详情是橱窗的下钻，停在这儿能告诉人「我还在橱窗这一层里」。
 */
const activeTab = computed(() => {
  const path = route.path
  if (path.startsWith('/market/cart')) return '/market/cart'
  if (path.startsWith('/market/orders')) return '/market/orders'
  if (path.startsWith('/market/wallet')) return '/market/wallet'
  // 兜底是「橱窗」：/market 自己和 /market/product/:id 都归它。
  // 商品详情页归到「橱窗」是对的 —— 用户就是从橱窗点进来的，
  // 高亮停在来处能告诉人「我还在橱窗这一层里」。
  return '/market'
})

onMounted(() => {
  // 只在登录态拉一次，角标才有数。未登录不发这个注定 401 的请求
  if (auth.isLoggedIn) load()
})
</script>

<template>
  <nav class="market-tabs">
    <RouterLink
      v-for="tab in visibleTabs"
      :key="tab.path"
      :to="tab.path"
      class="tab"
      :class="{ active: activeTab === tab.path }"
    >
      {{ tab.label }}
      <span v-if="tab.path === '/market/cart' && count > 0" class="badge">{{ count }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.market-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}

.tab {
  position: relative;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--muted-foreground);
  text-decoration: none;
  transition: color 0.15s ease;
}

.tab:hover {
  color: var(--foreground);
}

.tab.active {
  color: var(--foreground);
  font-weight: 600;
}

.tab.active::after {
  content: '';
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}

.badge {
  display: inline-block;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  margin-left: 4px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  vertical-align: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .tab {
    transition: none;
  }
}
</style>
