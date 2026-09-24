<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useToastStore } from '@/stores/toast'

const router = useRouter()
const toast = useToastStore()

// ===== 主题状态（与 App.vue 同步：共用 localStorage 'theme'）=====
// 跟随系统：null；浅色：'light'；深色：'dark'
const theme = ref<'light' | 'dark'>('light')

function applyTheme(t: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', t === 'dark')
  localStorage.setItem('theme', t)
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(theme.value)
}

// 进入页面时同步当前主题（App.vue 已初始化过 document.documentElement）
onMounted(() => {
  theme.value = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
})

// ===== 设置菜单分组（参考小红书布局）=====
interface Item {
  key: string
  label: string
  icon: string // SVG path d
  value?: string // 右侧文本（例："1.94 GB" / "未开启"）
  to?: string // 点击跳转（占位用 console.log）
  toggle?: boolean // 是否显示右侧开关（仅"深色模式"用）
}

interface Group {
  items: Item[]
}

const groups: Group[] = [
  // 第一组：账号类
  {
    items: [
      {
        key: 'account',
        label: '账号与安全',
        icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2'
      },
      {
        key: 'general',
        label: '通用设置',
        icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.05a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.05a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'
      },
      {
        key: 'notify',
        label: '通知设置',
        icon: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9z M10 21a2 2 0 0 0 4 0'
      },
      {
        key: 'lang',
        label: '多语言和翻译',
        icon: 'M5 7h6 M9 5v2 M5 13l4-1 1 3 M12 21l5-11 5 11 M14 17h6'
      },
      {
        key: 'privacy',
        label: '隐私设置',
        icon: 'M6 10V7a6 6 0 0 1 12 0v3 M5 10h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8z'
      }
    ]
  },
  // 第二组：内容类（含"深色模式"开关——从 App.vue 浮动按钮搬过来）
  {
    items: [
      {
        key: 'storage',
        label: '存储空间',
        icon: 'M3 6h18 M5 6v14h14V6 M10 11v6 M10 3h4v3h-4z',
        value: '1.94 GB'
      },
      { key: 'content', label: '内容偏好调节', icon: 'M3 12h7 M14 12h7 M14 6h7 M14 18h7 M10 6v12' },
      {
        key: 'address',
        label: '收货地址',
        icon: 'M12 22s8-7 8-13a8 8 0 0 0-16 0c0 6 8 13 8 13z M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'
      },
      {
        key: 'widget',
        label: '添加小组件',
        icon: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z'
      },
      {
        key: 'minor',
        label: '未成年人模式',
        icon: 'M12 2 8 6h3v6h2V6h3l-4-4z M5 22h14v-2H5z',
        value: '未开启'
      },
      {
        key: 'theme',
        label: '深色模式',
        icon: 'M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z',
        toggle: true
      }
    ]
  },
  // 第三组：体验
  {
    items: [
      {
        key: 'beta',
        label: '新功能体验',
        icon: 'M9 11v6 M9 7h.01 M12 22a8 8 0 1 1 0-16 8 8 0 0 1 0 16z'
      }
    ]
  },
  // 第四组：帮助
  {
    items: [
      {
        key: 'help',
        label: '帮助与客服',
        icon: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'
      },
      {
        key: 'about',
        label: '关于小红书',
        icon: 'M12 8v4 M12 16h.01 M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z'
      }
    ]
  },
  // 第五组：账号操作
  {
    items: [{ key: 'switch', label: '切换账号', icon: 'M16 17l5-5-5-5 M21 12H9 M9 21H3v-8' }]
  }
]

// ===== 退出登录（写在底部，用 action 组渲染）=====
const dangerActions: Item[] = [
  {
    key: 'logout',
    label: '退出登录',
    icon: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9'
  }
]

// 底部协议链接
const legalLinks = [
  { label: '《个人信息收集清单》', href: '#' },
  { label: '《第三方信息共享清单》', href: '#' },
  { label: '《小红书用户服务协议》', href: '#' },
  { label: '《小红书用户隐私政策》', href: '#' }
]

// ===== 点击处理 =====
function onItemClick(item: Item) {
  if (item.toggle) {
    toggleTheme()
    return
  }
  // 大部分菜单项业务未实现，给用户友好提示而不是静默无反应
  toast.show(`「${item.label}」即将上线`)
}

function onActionClick(item: Item) {
  if (item.key === 'logout') {
    // 直接清登录态 + 回首页
    import('@/stores/auth').then(({ useAuthStore }) => {
      const auth = useAuthStore()
      auth.logout()
      router.push('/')
    })
    return
  }
  toast.show(`「${item.label}」即将上线`)
}

function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.push('/')
  }
}
</script>

<template>
  <div class="settings">
    <!-- 顶部返回 + 标题 -->
    <header class="topbar">
      <button class="back-btn" type="button" aria-label="返回" @click="goBack">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15 6l-6 6 6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <h1 class="title">设置</h1>
    </header>

    <!-- 分组卡片 -->
    <main class="groups">
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

          <!-- 右侧：开关 / value / chevron -->
          <template v-if="item.toggle">
            <span
              class="switch"
              :class="{ on: theme === 'dark' }"
              role="switch"
              :aria-checked="theme === 'dark'"
            >
              <span class="switch-knob" />
            </span>
          </template>
          <template v-else>
            <span v-if="item.value" class="menu-value">{{ item.value }}</span>
            <span class="chevron">›</span>
          </template>
        </button>
      </div>

      <!-- 第五组：退出登录 -->
      <div class="group-card danger-card">
        <button
          v-for="item in dangerActions"
          :key="item.key"
          type="button"
          class="menu-item action-item"
          @click="onActionClick(item)"
        >
          {{ item.label }}
        </button>
      </div>
    </main>

    <!-- 底部协议链接 -->
    <footer class="legal">
      <a v-for="(link, i) in legalLinks" :key="i" :href="link.href" class="legal-link">{{
        link.label
      }}</a>
    </footer>
  </div>
</template>

<style scoped>
.settings {
  min-height: 100vh;
  background: var(--background);
  color: var(--foreground);
}

/* ===== 顶部 ===== */
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background);
  border-bottom: 1px solid var(--border);
}

.back-btn {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
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
}

.back-btn:hover {
  background: var(--muted);
}

.back-btn svg {
  width: 22px;
  height: 22px;
  display: block;
}

.title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

/* ===== 卡片分组 ===== */
.groups {
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group-card {
  /* 玻璃设置卡：dark / light 都用同一 token */
  background: var(--glass-bg);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid var(--glass-border-dk);
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.10);
}
.group-card::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg,
    transparent 0%, var(--glass-highlight) 50%, transparent 100%);
  pointer-events: none;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 16px;
  background: transparent;
  border: none;
  color: inherit;
  font-family: inherit;
  font-size: 15px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.menu-item:not(:last-child) {
  border-bottom: 1px solid var(--glass-border-dk);
}
}

.menu-item:hover {
  background: var(--glass-bg-strong);
}

.menu-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: var(--muted-foreground);
}

.menu-label {
  flex: 1;
  font-weight: 500;
}

.menu-value {
  color: var(--muted-foreground);
  font-size: 14px;
}

.chevron {
  color: var(--muted-foreground);
  font-size: 20px;
  line-height: 1;
  margin-left: 4px;
}

/* ===== 开关（iOS 风格）===== */
.switch {
  position: relative;
  display: inline-block;
  width: 42px;
  height: 24px;
  /* 玻璃开关（关） */
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border-dk);
  border-radius: 999px;
  transition: background 0.2s;
  cursor: pointer;
}

.switch.on {
  /* 玻璃开关（开）：绿色，保留品牌 */
  background: rgba(34, 197, 94, 0.85);
  border-color: rgba(34, 197, 94, 0.5);
}

.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.switch.on .switch-knob {
  transform: translateX(18px);
}

/* ===== 退出登录 ===== */
.danger-card .action-item {
  justify-content: center;
  color: var(--foreground);
  font-weight: 500;
}

/* ===== 底部协议 ===== */
.legal {
  padding: 24px 16px 40px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 12px;
  text-align: center;
}

.legal-link {
  font-size: 12px;
  color: var(--muted-foreground);
  text-decoration: none;
  transition: color 0.15s;
}

.legal-link:hover {
  color: var(--foreground);
  text-decoration: underline;
}
</style>
