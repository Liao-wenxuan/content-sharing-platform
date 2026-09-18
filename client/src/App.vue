<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

function handleLogout() {
  auth.logout()
}
</script>

<template>
  <div id="app">
    <nav class="nav">
      <router-link to="/" class="nav-link">首页</router-link>

      <!-- 关键：v-if/v-else 切换登录态显示 -->
      <router-link v-if="!auth.isLoggedIn" to="/login" class="nav-link">
        登录
      </router-link>
      <template v-else>
        <span class="user">@{{ auth.user?.nickname }}</span>
        <button @click="handleLogout" class="logout-btn">退出</button>
      </template>

      <router-link to="/publish" class="nav-link">发布</router-link>
      <router-link to="/profile/me" class="nav-link">我的</router-link>
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
  transition: all 0.15s;
}

.logout-btn:hover {
  background: var(--muted);
  color: var(--foreground);
  border-color: var(--foreground);
}

.main {
  min-height: calc(100vh - 60px);
}
</style>