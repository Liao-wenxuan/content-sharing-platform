<script setup lang="ts">
/**
 * 桌面端顶部栏
 *
 * 布局：左搜索框（撑满）→ 右「发布」按钮 + 主题切换 + 用户菜单。
 * 用户菜单把「个人主页 / 设置 / 退出」收进 ElDropdown，
 * 避免在窄栏里堆一排图标按钮。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Search,
  EditPen,
  Moon,
  Sunny,
  ArrowDown,
  SwitchButton,
  User,
  Setting
} from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { useTheme } from '@/composables/useTheme'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()
const { isDark, toggleTheme } = useTheme()

const avatarText = computed(() => auth.user?.nickname?.[0]?.toUpperCase() || '?')

function onSearch() {
  ElMessage.info('搜索功能开发中，敬请期待')
}

function goPublish() {
  router.push('/publish')
}

function handleCommand(command: string) {
  if (command === 'profile') {
    router.push('/profile/me')
    return
  }
  if (command === 'settings') {
    router.push('/settings')
    return
  }
  if (command === 'logout') {
    auth.logout()
    toast.show('已退出登录', 'success')
    if (route.meta.requiresAuth) router.push('/')
  }
}
</script>

<template>
  <header class="top-bar">
    <!-- 搜索 -->
    <el-input
      class="search-input"
      placeholder="搜索你感兴趣的内容"
      :prefix-icon="Search"
      clearable
      @keyup.enter="onSearch"
    />

    <div class="bar-actions">
      <el-button type="primary" :icon="EditPen" class="publish-btn" @click="goPublish">
        发布笔记
      </el-button>

      <el-tooltip :content="isDark ? '切换到浅色' : '切换到深色'" placement="bottom">
        <el-button
          class="icon-btn"
          circle
          :icon="isDark ? Sunny : Moon"
          aria-label="切换主题"
          @click="toggleTheme"
        />
      </el-tooltip>

      <!-- 已登录：头像下拉 -->
      <el-dropdown v-if="auth.isLoggedIn" trigger="click" @command="handleCommand">
        <button type="button" class="user-trigger">
          <el-avatar :size="32" :src="auth.user?.avatar || undefined">
            {{ avatarText }}
          </el-avatar>
          <span class="user-name">{{ auth.user?.nickname }}</span>
          <el-icon class="arrow"><component :is="ArrowDown" /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="profile" :icon="User">个人主页</el-dropdown-item>
            <el-dropdown-item command="settings" :icon="Setting">设置</el-dropdown-item>
            <el-dropdown-item command="logout" :icon="SwitchButton" divided>
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <!-- 未登录：登录按钮 -->
      <el-button
        v-else
        type="primary"
        plain
        @click="router.push({ name: 'login', query: { redirect: route.fullPath } })"
      >
        登录
      </el-button>
    </div>
  </header>
</template>

<style scoped>
.top-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 16px;
  height: var(--top-bar-height);
  padding: 0 24px;
  background: var(--background);
  border-bottom: 1px solid var(--border);
}

.search-input {
  max-width: 480px;
}

.bar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.publish-btn {
  font-weight: 600;
}

.icon-btn {
  flex-shrink: 0;
}

.user-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--foreground);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}

.user-trigger:hover {
  background: var(--muted);
}

.user-name {
  font-weight: 500;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arrow {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
