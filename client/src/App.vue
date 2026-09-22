<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import BottomNav from '@/components/BottomNav.vue'
import Sidebar from '@/components/Sidebar.vue'

const auth = useAuthStore()

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
    <main class="main">
      <router-view />
    </main>

    <BottomNav v-if="auth.isLoggedIn || true" />

    <!-- 侧边栏：Teleport 到 body，独立层级 -->
    <Sidebar />
  </div>
</template>

<style scoped>
.main {
  /* 底部 nav 高度 + 安全区，避免内容被遮挡 */
  padding-bottom: calc(72px + env(safe-area-inset-bottom));
  min-height: 100vh;
}
</style>