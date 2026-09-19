<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

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

function handleLogout() {
  auth.logout()
}
</script>

<template>
  <div id="app">
    <nav class="nav">
      <router-link to="/" class="nav-link">首页</router-link>

      <template v-if="!auth.isLoggedIn">
        <router-link to="/login" class="nav-link">登录</router-link>
      </template>
      <template v-else>
        <span class="user">@{{ auth.user?.nickname }}</span>
        <button @click="handleLogout" class="logout-btn">退出</button>
      </template>

      <router-link to="/publish" class="nav-link">发布</router-link>
      <router-link to="/profile/me" class="nav-link">我的</router-link>

      <button
        @click="toggleTheme"
        class="theme-btn"
        :title="isDark ? '切换到亮色' : '切换到暗色'"
      >
        {{ isDark ? '☀' : '☾' }}
      </button>
    </nav>

    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.nav {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 12px 24px;
  background: var(--background);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
  transition: background-color 0.2s, border-color 0.2s;
}

.nav-link {
  padding: 6px 12px;
  border-radius: var(--radius);
  font-size: 14px;
  color: var(--muted-foreground);
  font-weight: 500;
  transition: all 0.15s;
}

.nav-link:hover {
  background: var(--muted);
  color: var(--foreground);
}

.nav-link.router-link-active {
  color: var(--foreground);
  background: var(--muted);
}

.user {
  color: var(--foreground);
  font-weight: 600;
  font-size: 14px;
  padding: 0 8px;
}

.logout-btn {
  padding: 6px 12px;
  background: transparent;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: all 0.15s;
}

.logout-btn:hover {
  background: var(--muted);
  color: var(--foreground);
  border-color: var(--foreground);
}

/* 主题切换按钮：推到 nav 最右 */
.theme-btn {
  margin-left: auto;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 14px;
  color: var(--muted-foreground);
  font-family: inherit;
  transition: all 0.15s;
  line-height: 1;
}

.theme-btn:hover {
  background: var(--muted);
  color: var(--foreground);
  border-color: var(--foreground);
}

.main {
  min-height: calc(100vh - 60px);
}
</style>