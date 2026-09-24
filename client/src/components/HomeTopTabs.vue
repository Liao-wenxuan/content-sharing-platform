<script setup lang="ts">
import { computed } from 'vue'
import { useSidebarStore } from '@/stores/sidebar'
import { useAuthStore } from '@/stores/auth'
import { useHomeTabsStore } from '@/stores/homeTabs'

const sidebar = useSidebarStore()
const auth = useAuthStore()
const homeTabs = useHomeTabsStore()

// 头像首字母 fallback（用昵称首字）
const avatarInitial = computed(() => auth.user?.nickname?.[0]?.toUpperCase() || '?')

// ===== 上层：频道 tab =====
const channels = [
  { key: 'follow', label: '关注', badge: 4 }, // 红色徽章演示
  { key: 'discover', label: '发现' },
  { key: 'ya', label: '雅安' }
]

// ===== 下层：分类 tab =====
const categories = [
  { key: 'recommend', label: '推荐' },
  { key: 'video', label: '视频' },
  { key: 'hot', label: '热点' },
  { key: 'live', label: '直播' },
  { key: 'drama', label: '短剧' },
  { key: 'exp', label: '经验', hasMore: true } // ▾ 下拉
]

function selectChannel(key: string) {
  homeTabs.channel = key
}

function selectCategory(key: string) {
  homeTabs.category = key
}

// 搜索按钮（暂打 console 占位）
function onSearch() {
  console.log('[HomeTopTabs] open search')
  // TODO: 接搜索 modal 或跳 /search
}
</script>

<template>
  <!-- 整个顶部栏 fixed 吸顶 -->
  <header class="topbar">
    <!-- ===== 上层：头像 / 频道 / 搜索 ===== -->
    <div class="row top-row">
      <!-- 左侧：头像按钮（点击触发侧边栏） -->
      <!-- 已登录：显示真实头像或昵称首字；未登录：显示默认人物图标 -->
      <button
        v-if="auth.isLoggedIn"
        class="avatar-btn"
        type="button"
        aria-label="打开侧边栏"
        @click="sidebar.open()"
      >
        <img
          v-if="auth.user?.avatar"
          :src="auth.user.avatar"
          :alt="`${auth.user.nickname} 头像`"
          class="avatar-img"
        />
        <span v-else class="avatar-text">{{ avatarInitial }}</span>
      </button>
      <button
        v-else
        class="circle-btn"
        type="button"
        aria-label="打开侧边栏"
        @click="sidebar.open()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <!-- 中间：频道 tab -->
      <div class="channel-tabs">
        <button
          v-for="ch in channels"
          :key="ch.key"
          type="button"
          class="channel-tab"
          :class="{ active: homeTabs.channel === ch.key }"
          @click="selectChannel(ch.key)"
        >
          <span class="channel-label">{{ ch.label }}</span>
          <span v-if="ch.badge" class="channel-badge">{{ ch.badge }}</span>
          <span v-if="homeTabs.channel === ch.key" class="channel-underline" />
        </button>
      </div>

      <!-- 右侧：搜索 -->
      <button class="circle-btn" type="button" aria-label="搜索" @click="onSearch">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path
            d="m20 20-3.5-3.5"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <!-- ===== 下层：分类 tab ===== -->
    <nav class="row category-row">
      <button
        v-for="cat in categories"
        :key="cat.key"
        type="button"
        class="category-tab"
        :class="{ active: homeTabs.category === cat.key }"
        @click="selectCategory(cat.key)"
      >
        <span>{{ cat.label }}</span>
        <span v-if="cat.hasMore" class="caret" aria-hidden="true">▾</span>
      </button>
    </nav>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  /* 全宽 viewport 铺满：100% 跟随 <html>，不依赖父容器宽度 */
  width: 100%;
  max-width: 100vw;
  /* Liquid glass 顶栏：透出底色 + 模糊 */
  background: var(--glass-bg);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  /* 底部 1px 折射线：液态玻璃的标志性细节 */
  border-bottom: 1px solid var(--glass-border-dk);
  box-shadow:
    0 1px 0 var(--glass-highlight) inset,
    var(--glass-shadow);
}

.row {
  display: flex;
  align-items: center;
}

/* ===== 上层 ===== */
.top-row {
  height: 52px;
  padding: 0 12px;
  gap: 8px;
}

.circle-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
  padding: 0;
}

.circle-btn:hover {
  background: var(--glass-bg-strong);
}

.circle-btn svg {
  width: 22px;
  height: 22px;
  display: block;
}

/* 已登录态头像按钮 */
.avatar-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--primary);
  color: var(--primary-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  padding: 0;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.avatar-btn:hover {
  opacity: 0.85;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.avatar-text {
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
}

/* 频道 tab 区域（flex 1 居中） */
.channel-tabs {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
}

.channel-tab {
  position: relative;
  padding: 6px 4px;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-family: inherit;
  font-size: 17px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color 0.15s;
}

.channel-tab:hover {
  color: var(--foreground);
}

.channel-tab.active {
  color: var(--foreground);
  font-weight: 700;
}

.channel-label {
  line-height: 1;
}

/* 红色徽章（小红书风格小圆点 + 数字）*/
.channel-badge {
  background: #ef4444;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  line-height: 1.4;
  min-width: 18px;
  text-align: center;
}

/* 选中态的红色下划线 */
.channel-underline {
  position: absolute;
  bottom: -2px;
  left: 50%;
  transform: translateX(-50%);
  width: 22px;
  height: 3px;
  background: #ef4444;
  border-radius: 2px;
}

/* ===== 下层分类 ===== */
.category-row {
  height: 40px;
  padding: 0 16px;
  gap: 18px;
  overflow-x: auto;
  scrollbar-width: none;
}
.category-row::-webkit-scrollbar {
  display: none;
}

.category-tab {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 2px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
  transition: color 0.15s;
  flex-shrink: 0;
}

.category-tab:hover {
  color: var(--foreground);
}

.category-tab.active {
  color: var(--foreground);
  font-weight: 700;
  background: var(--glass-bg-strong);
}

.caret {
  font-size: 10px;
  opacity: 0.8;
}

/* ===== 响应式适配 ===== */
/* 桌面：频道 tab gap 大、分类 padding 舒展 */
@media (min-width: 1024px) {
  .top-row {
    padding: 0 24px;
  }
  .channel-tabs {
    gap: 32px;
  }
  .category-row {
    padding: 0 24px;
    gap: 22px;
  }
}

/* 平板：紧凑一点 */
@media (min-width: 768px) and (max-width: 1023px) {
  .top-row {
    padding: 0 16px;
  }
  .channel-tabs {
    gap: 22px;
  }
}

/* 手机：紧凑、内边距更小 */
@media (max-width: 480px) {
  .top-row {
    height: 48px;
    padding: 0 8px;
    gap: 4px;
  }
  .channel-tabs {
    gap: 16px;
  }
  .channel-tab {
    font-size: 14px;
  }
  .category-row {
    height: 38px;
    padding: 0 12px;
    gap: 14px;
  }
  .category-tab {
    font-size: 13px;
    padding: 4px 6px;
  }
  .circle-btn {
    width: 32px;
    height: 32px;
  }
  .circle-btn svg {
    width: 20px;
    height: 20px;
  }
}
</style>
