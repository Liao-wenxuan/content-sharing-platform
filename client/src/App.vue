<script setup lang="ts">
import { onMounted, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import BottomNav from '@/components/BottomNav.vue'
import Sidebar from '@/components/Sidebar.vue'
import ToastHost from '@/components/ToastHost.vue'
import ErrorBoundary from '@/components/ErrorBoundary.vue'
import HomeTopTabs from '@/components/HomeTopTabs.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// 只在 HomeView 显示顶部双层 tab 栏（脱离路由级 max-width，铺满 viewport）
const showTopTabs = computed(() => route.name === 'home')

// 路由切换时回到顶部（避免从详情页返回时还在中间位置）
// 仅在 path 变化时触发；同 path 的 query 变化（如 tab 切换）保留滚动位置
watch(
  () => route.path,
  () => {
    nextTick(() => {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
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
    <!-- 顶部 tab 栏：在 .main 外、#app 内，sticky 铺满 viewport -->
    <!--
      HomeTopTabs 用的是 position: sticky（不是 fixed），自身已经在文档流里占位，
      所以下面的 router-view 不会被遮挡，不需要额外 spacer。
      之前那个 .top-tabs-spacer 是历史遗留，造成 92px / 88px 多余空白。
    -->
    <HomeTopTabs v-if="showTopTabs" />

    <main class="main">
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
  /* HomeTopTabs 用 position: fixed 永远吸顶；
   * 这里用 padding-top 让出 ~92px（desktop 52 + 40 两行），
   * mobile 上更紧凑，给 88px。
   */
  padding-top: 92px;
  /* 底部 nav 高度 + 安全区，避免内容被遮挡 */
  padding-bottom: calc(72px + env(safe-area-inset-bottom));
  min-height: 100vh;
}

@media (max-width: 480px) {
  .main {
    padding-top: 88px;
  }
}
</style>