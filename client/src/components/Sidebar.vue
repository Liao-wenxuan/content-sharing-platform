<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSidebarStore } from '@/stores/sidebar'
import { useToastStore } from '@/stores/toast'

const sidebar = useSidebarStore()
const router = useRouter()
const toast = useToastStore()

// ===== 菜单项类型 =====
// group: 同 group 之间共享一张卡片
// badge: 右侧红色徽章（小红书的"新"标签）
interface MenuItem {
  key: string
  label: string
  icon: string // SVG path d
  badge?: string
  to?: string // 点击跳转（暂未接路由时点一下就关 sidebar）
}

// ===== 4 个分组（对应截图里的 4 张卡片）=====
const groups: { items: MenuItem[] }[] = [
  // 第一组：社交 + 创作
  {
    items: [
      {
        key: 'add-friend',
        label: '添加好友',
        icon: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M20 8v6 M23 11h-6'
      },
      { key: 'creator', label: '创作者中心', icon: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z' }
    ]
  },
  // 第二组：内容管理
  {
    items: [
      {
        key: 'drafts',
        label: '我的草稿',
        icon: 'M21 8v13H3V3h13 M7 13h10 M7 17h6 M21 3v5h-5',
        to: '/profile/me'
      },
      {
        key: 'activity',
        label: '我的活动',
        icon: 'M12 2 14.5 9 22 9.5 16.5 14.5 18 22 12 18 6 22 7.5 14.5 2 9.5 9.5 9z',
        badge: '新',
        to: '/profile/me'
      },
      {
        key: 'history',
        label: '浏览记录',
        icon: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 2',
        to: '/profile/me'
      },
      {
        key: 'downloads',
        label: '我的下载',
        icon: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
        to: '/profile/me'
      }
    ]
  },
  // 第三组：电商
  {
    items: [
      { key: 'orders', label: '订单', icon: 'M5 7h14l-1.5 12h-11L5 7z M9 7V5a3 3 0 0 1 6 0v2' },
      {
        key: 'cart',
        label: '购物车',
        icon: 'M3 4h2l2.7 12.3a2 2 0 0 0 2 1.7h8.6a2 2 0 0 0 2-1.6L23 8H6 M10 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M20 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'
      },
      {
        key: 'wallet',
        label: '钱包',
        icon: 'M21 7H3v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2h-3a2 2 0 1 1 0-4h3V9a2 2 0 0 0-2-2z'
      }
    ]
  },
  // 第四组：生态
  {
    items: [
      {
        key: 'miniprogram',
        label: '小程序',
        icon: 'M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M16 20a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 22a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'
      }
    ]
  }
]

// ===== 底部 3 个圆形按钮 =====
const bottomActions: MenuItem[] = [
  {
    key: 'scan',
    label: '扫一扫',
    icon: 'M3 7V5a2 2 0 0 1 2-2h2 M21 7V5a2 2 0 0 0-2-2h-2 M3 17v2a2 2 0 0 0 2 2h2 M21 17v2a2 2 0 0 1-2 2h-2 M7 12h10'
  },
  {
    key: 'help',
    label: '帮助与客服',
    icon: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z'
  },
  {
    key: 'settings',
    label: '设置',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.05a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.05a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    to: '/settings'
  }
]

// ===== 菜单点击：路由跳转 + 无路由的菜单提示 =====
function onItemClick(item: MenuItem) {
  sidebar.close()
  if (item.to) {
    router.push(item.to)
  } else {
    // 没接路由的菜单（电商 / 生态类）：toast 友好提示
    toast.show(`「${item.label}」即将上线`)
  }
}

// ===== Esc 键关闭 =====
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && sidebar.isOpen) {
    sidebar.close()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩层：点击关闭 -->
    <Transition name="overlay">
      <div v-if="sidebar.isOpen" class="sidebar-overlay" @click="sidebar.close()" />
    </Transition>

    <!-- 抽屉面板 -->
    <Transition name="drawer">
      <aside
        v-if="sidebar.isOpen"
        class="sidebar"
        role="dialog"
        aria-modal="true"
        aria-label="侧边栏"
      >
        <!-- 顶部留白（手机状态栏区域） -->
        <div class="safe-top" />

        <!-- 主内容滚动区 -->
        <div class="scroll-area">
          <div v-for="(group, gi) in groups" :key="gi" class="group-card">
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              class="menu-item"
              @click="onItemClick(item)"
            >
              <svg viewBox="0 0 24 24" class="menu-icon" aria-hidden="true">
                <path
                  :d="item.icon"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="menu-label">{{ item.label }}</span>
              <span v-if="item.badge" class="badge">{{ item.badge }}</span>
            </button>
          </div>
        </div>

        <!-- 底部 3 个圆形按钮（固定不滚动） -->
        <div class="bottom-actions">
          <button
            v-for="item in bottomActions"
            :key="item.key"
            type="button"
            class="action-btn"
            @click="onItemClick(item)"
          >
            <span class="action-circle">
              <svg viewBox="0 0 24 24" class="action-icon" aria-hidden="true">
                <path
                  :d="item.icon"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span class="action-label">{{ item.label }}</span>
          </button>
        </div>

        <!-- 底部安全区（iPhone home 条等） -->
        <div class="safe-bottom" />
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ===== 遮罩 ===== */
.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 100;
}

/* ===== 抽屉面板 ===== */
.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 300px;
  max-width: 80vw;
  background: #1a1a1a;
  color: #fafafa;
  z-index: 101;
  display: flex;
  flex-direction: column;
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.4);
  /* 主题色硬编码 dark 是因为：
     - 用户截图本身就是 dark（小红书 dark mode）
     - light mode 下这个侧边栏仍应该是深色（小红书在亮色下也是深色抽屉）
     - 与 shadcn 主题解耦，独立视觉 */
}

/* ===== 顶部安全区（避开状态栏 / 摄像头） ===== */
.safe-top {
  height: env(safe-area-inset-top, 0);
  flex-shrink: 0;
}

.safe-bottom {
  height: env(safe-area-inset-bottom, 0);
  flex-shrink: 0;
}

/* ===== 主滚动区 ===== */
.scroll-area {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 隐藏滚动条但保留滚动 */
  scrollbar-width: none;
}
.scroll-area::-webkit-scrollbar {
  display: none;
}

/* ===== 分组卡片 ===== */
.group-card {
  background: #2a2a2a;
  border-radius: 14px;
  padding: 4px 0;
  overflow: hidden;
}

/* ===== 菜单项 ===== */
.menu-item {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 18px;
  background: transparent;
  border: none;
  color: inherit;
  font-family: inherit;
  font-size: 16px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.menu-item:active {
  background: rgba(255, 255, 255, 0.08);
}

.menu-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  color: #fafafa;
}

.menu-label {
  flex: 1;
  font-weight: 500;
}

.badge {
  background: #ef4444;
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
  line-height: 1.4;
}

/* ===== 底部 3 个圆形按钮 ===== */
.bottom-actions {
  display: flex;
  justify-content: space-around;
  padding: 14px 16px 8px;
  flex-shrink: 0;
}

.action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 4px;
}

.action-circle {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: #2a2a2a;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s,
    transform 0.1s;
}

.action-btn:hover .action-circle {
  background: #333;
}

.action-btn:active .action-circle {
  transform: scale(0.94);
}

.action-icon {
  width: 22px;
  height: 22px;
  color: #fafafa;
}

.action-label {
  color: #d4d4d8;
  font-weight: 400;
  white-space: nowrap;
}

/* ===== 过渡动画 ===== */
/* 抽屉从左滑入 */
.drawer-enter-active,
.drawer-leave-active {
  transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1);
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(-100%);
}

/* 遮罩淡入淡出 */
.overlay-enter-active,
.overlay-leave-active {
  transition: opacity 0.28s ease;
}
.overlay-enter-from,
.overlay-leave-to {
  opacity: 0;
}
</style>
