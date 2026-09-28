<script setup lang="ts">
/**
 * 设置页（桌面端）
 *
 * 组件替换：
 * - 手写 SVG path 图标 → Element Plus 图标组件
 * - 手写「深色模式」开关按钮 → ElSwitch
 * - 分组列表 → ElCard + ElDivider
 * - 主题状态改用 useTheme composable，与 TopBar 的主题按钮共享同一份 state
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  User,
  Setting,
  Bell,
  ChatLineSquare,
  Lock,
  Coin,
  Operation,
  Location,
  Grid,
  Opportunity,
  Moon,
  QuestionFilled,
  InfoFilled,
  Switch,
  SwitchButton,
  Refresh
} from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { useTheme } from '@/composables/useTheme'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()
const { isDark, toggleTheme } = useTheme()

// ===== 设置菜单分组 =====
interface Item {
  key: string
  label: string
  icon: unknown
  /** 右侧文本（例："1.94 GB" / "未开启"） */
  value?: string
  /** 是否渲染 ElSwitch（仅「深色模式」用） */
  switchable?: boolean
}

interface Group {
  title: string
  items: Item[]
}

const groups: Group[] = [
  {
    title: '账号',
    items: [
      { key: 'account', label: '账号与安全', icon: User },
      { key: 'general', label: '通用设置', icon: Setting },
      { key: 'notify', label: '通知设置', icon: Bell },
      { key: 'lang', label: '多语言和翻译', icon: ChatLineSquare },
      { key: 'privacy', label: '隐私设置', icon: Lock }
    ]
  },
  {
    title: '内容与外观',
    items: [
      { key: 'storage', label: '存储空间', icon: Coin, value: '1.94 GB' },
      { key: 'content', label: '内容偏好调节', icon: Operation },
      { key: 'address', label: '收货地址', icon: Location },
      { key: 'widget', label: '添加小组件', icon: Grid },
      { key: 'minor', label: '未成年人模式', icon: Opportunity, value: '未开启' },
      { key: 'theme', label: '深色模式', icon: Moon, switchable: true }
    ]
  },
  {
    title: '体验',
    items: [{ key: 'beta', label: '新功能体验', icon: Opportunity }]
  },
  {
    title: '帮助',
    items: [
      { key: 'help', label: '帮助与客服', icon: QuestionFilled },
      { key: 'about', label: '关于内容社区', icon: InfoFilled }
    ]
  },
  {
    title: '账号操作',
    items: [
      { key: 'switch', label: '切换账号', icon: Switch },
      { key: 'logout', label: '退出登录', icon: SwitchButton }
    ]
  }
]

// 底部协议链接
const legalLinks = [
  { label: '《个人信息收集清单》' },
  { label: '《第三方信息共享清单》' },
  { label: '《用户服务协议》' },
  { label: '《用户隐私政策》' }
]

// ===== 点击处理 =====
function onItemClick(item: Item) {
  if (item.switchable) {
    toggleTheme()
    return
  }
  if (item.key === 'logout') {
    auth.logout()
    toast.show('已退出登录', 'success')
    router.push('/')
    return
  }
  // 大部分菜单项业务未实现，给用户友好提示而不是静默无反应
  toast.show(`「${item.label}」即将上线`)
}

const themeHint = computed(() => (isDark.value ? '深色' : '浅色'))
</script>

<template>
  <div class="settings">
    <header class="page-header">
      <h1 class="page-title">设置</h1>
      <p class="page-subtitle">账号、内容和外观偏好</p>
    </header>

    <div class="settings-grid">
      <el-card v-for="group in groups" :key="group.title" shadow="never" class="group-card">
        <template #header
          ><span class="group-title">{{ group.title }}</span></template
        >

        <ul class="item-list">
          <li v-for="item in group.items" :key="item.key" class="item-row">
            <el-icon class="item-icon"><component :is="item.icon" /></el-icon>
            <span class="item-label">{{ item.label }}</span>

            <span v-if="item.value" class="item-value">{{ item.value }}</span>

            <el-switch v-if="item.switchable" :model-value="isDark" @change="toggleTheme" />

            <el-button v-else link class="item-action" @click="onItemClick(item)">
              {{ item.key === 'logout' ? '' : '设置' }}
            </el-button>
          </li>
        </ul>
      </el-card>

      <!-- 账户摘要 -->
      <el-card shadow="never" class="group-card account-card">
        <template #header><span class="group-title">当前账号</span></template>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="昵称">
            {{ auth.user?.nickname || '未登录' }}
          </el-descriptions-item>
          <el-descriptions-item label="用户 ID">{{ auth.user?.id ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="当前主题">{{ themeHint }}</el-descriptions-item>
          <el-descriptions-item label="界面库">Element Plus</el-descriptions-item>
        </el-descriptions>

        <div class="legal">
          <el-button
            v-for="link in legalLinks"
            :key="link.label"
            link
            size="small"
            class="legal-link"
            @click="toast.show('文档正在完善中')"
          >
            {{ link.label }}
          </el-button>
        </div>
      </el-card>
    </div>

    <!-- 危险操作 -->
    <el-card shadow="never" class="group-card danger-card">
      <div class="danger-row">
        <div class="danger-info">
          <div class="danger-title">退出登录</div>
          <p class="danger-hint">退出后需要重新输入邮箱和密码，本机的草稿不会被保存。</p>
        </div>
        <el-button
          type="danger"
          plain
          round
          :icon="Refresh"
          @click="onItemClick({ key: 'logout', label: '退出登录', icon: SwitchButton })"
        >
          退出登录
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.settings {
  max-width: 840px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--foreground);
}

.page-subtitle {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--muted-foreground);
}

/* ===== 分组卡 ===== */
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  align-items: start;
}

.group-title {
  font-weight: 600;
  font-size: 14px;
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 0;
}

.item-row + .item-row {
  border-top: 1px solid var(--border);
}

.item-icon {
  color: var(--muted-foreground);
  font-size: 16px;
  flex-shrink: 0;
}

.item-label {
  flex: 1;
  font-size: 14px;
  cursor: default;
}

.item-value {
  font-size: 13px;
  color: var(--muted-foreground);
}

.item-action {
  padding: 0;
  height: auto;
}

/* ===== 账号摘要 ===== */
.account-card :deep(.el-descriptions) {
  font-size: 13px;
}

.legal {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 14px;
}

.legal-link {
  padding: 0;
  height: auto;
  font-size: 12px;
}

/* ===== 危险操作 ===== */
.danger-card {
  margin-top: 16px;
  border-color: color-mix(in srgb, var(--destructive) 35%, var(--border));
}

.danger-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.danger-title {
  font-size: 14px;
  font-weight: 600;
}

.danger-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.6;
}
</style>
