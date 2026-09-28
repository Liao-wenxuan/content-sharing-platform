<script setup lang="ts">
import { onMounted, computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import BottomNav from '@/components/BottomNav.vue'
import Sidebar from '@/components/Sidebar.vue'
import ToastHost from '@/components/ToastHost.vue'
import ErrorBoundary from '@/components/ErrorBoundary.vue'
import HomeTopTabs from '@/components/HomeTopTabs.vue'

const auth = useAuthStore()
const route = useRoute()

// 只在 HomeView 显示顶部双层 tab 栏（脱离路由级 max-width，铺满 viewport）
const showTopTabs = computed(() => route.name === 'home')

// 路由切换时回到顶部（避免从详情页返回时还在中间位置）
// 仅在 path 变化时触发；同 path 的 query 变化（如 tab 切换）保留滚动位置
watch(
  () => route.path,
  () => {
    nextTick(() => {
      // 'auto' = 瞬时跳转（不做 smooth 动画），避免路由切换时页面"滑"一下
      window.scrollTo({ top: 0, behavior: 'auto' })
    })
  }
)

// 主题初始化（具体切换逻辑搬到 SettingsView 里）
onMounted(() => {
  const urlTheme = new URLSearchParams(window.location.search).get('theme')
  if (urlTheme === 'dark' || urlTheme === 'light') {
    document.documentElement.classList.toggle('dark', urlTheme === 'dark')
    localStorage.setItem('theme', urlTheme)
  } else {
    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark')
  }
})
</script>

<template>
  <div id="app">
    <!--
      顶部 tab 栏：在 .main 外、#app 内，position: fixed 铺满 viewport。
      因为脱离文档流，.main 需要 .has-top-tabs 的 padding-top 让位。
    -->
    <HomeTopTabs v-if="showTopTabs" />

    <main class="main" :class="{ 'has-top-tabs': showTopTabs }">
      <!-- 全局错误边界：子组件 render 期同步异常时降级，避免白屏 -->
      <ErrorBoundary>
        <router-view />
      </ErrorBoundary>
    </main>

    <BottomNav v-if="auth.isLoggedIn || true" />

    <!-- 侧边栏：Teleport 到 body，独立层级 -->
    <Sidebar />

    <!-- 全局 toast 通知（独立层级） -->
    <ToastHost />
  </div>
</template>

<style scoped>
.main {
  /* 底部 nav 高度 + 安全区，避免内容被遮挡 */
  padding-bottom: calc(72px + env(safe-area-inset-bottom));
  min-height: 100vh;
}

/*
 * 只有首页才需要给 fixed 的 HomeTopTabs 让位。
 * 其他页面（详情 / 发布 / 消息 / 我的 / 登录）没有这根顶栏，
 * 如果无条件加 padding-top 就会凭空多出 88~92px 空白。
 */
.main.has-top-tabs {
  padding-top: 92px;
}

@media (max-width: 480px) {
  .main.has-top-tabs {
    padding-top: 88px;
  }
}
</style>
