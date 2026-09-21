<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import BottomNav from '@/components/BottomNav.vue'

const auth = useAuthStore()
const isDark = ref(false)

function applyTheme() {
  document.documentElement.classList.toggle('dark', isDark.value)
}

function toggleTheme() {
  isDark.value = !isDark.value
  applyTheme()
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
}

onMounted(() => {
  // URL 参数 ?theme=dark 优先（方便截图 + 调试）
  const urlTheme = new URLSearchParams(window.location.search).get('theme')
  if (urlTheme === 'dark') {
    isDark.value = true
  } else if (urlTheme === 'light') {
    isDark.value = false
  } else {
    isDark.value = localStorage.getItem('theme') === 'dark'
  }
  applyTheme()
})
</script>

<template>
  <div id="app">
    <main class="main">
      <router-view />
    </main>

    <!-- 浮动主题切换：放在主区右上角，不依赖 nav -->
    <button
      @click="toggleTheme"
      class="theme-fab"
      :title="isDark ? '切换到亮色' : '切换到暗色'"
      :aria-label="isDark ? '切换到亮色' : '切换到暗色'"
    >
      {{ isDark ? '☀' : '☾' }}
    </button>

    <BottomNav v-if="auth.isLoggedIn || true" />
  </div>
</template>

<style scoped>
.main {
  /* 底部 nav 高度 + 安全区，避免内容被遮挡 */
  padding-bottom: calc(72px + env(safe-area-inset-bottom));
  min-height: 100vh;
}

.theme-fab {
  position: fixed;
  right: 16px;
  top: 16px;
  z-index: 40;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--background);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  box-shadow: var(--shadow-sm);
  transition: all 0.15s;
  line-height: 1;
}

.theme-fab:hover {
  color: var(--foreground);
  border-color: var(--foreground);
}
</style>