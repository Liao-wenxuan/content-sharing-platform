<script setup lang="ts">
/**
 * 设置页
 *
 * ## 为什么全部改成抽屉面板
 *
 * 之前这个页面上有 13 个「点了只会弹一句『即将上线』」的按钮。
 * 那种按钮比不放更糟 —— 它在教用户这个站点的按钮有一半是假的。
 *
 * 现在每个入口背后都有**真的**面板或跳转：
 * 有后端能力的接接口，没有的换成另一种真实形态
 * （比如「添加小组件」变成生成一段真能用的浏览器脚本）。
 *
 * 抽屉而不是新路由：这些设置都是「调完就回」的操作，
 * 让用户为了改一个开关而换一整个页面，代价大于收益。
 * 而「帮助 / 关于」是纯阅读内容，走抽屉同样合适。
 */
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
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
  Monitor
} from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { useUserSettings } from '@/composables/useUserSettings'
import { useTheme } from '@/composables/useTheme'
import { useStorageStats, REPO_URL } from '@/composables/useStorageStats'
import { formatBytes } from '@/utils/format'
import PanelAccount from './settings/PanelAccount.vue'
import PanelGeneral from './settings/PanelGeneral.vue'
import PanelNotify from './settings/PanelNotify.vue'
import PanelLanguage from './settings/PanelLanguage.vue'
import PanelPrivacy from './settings/PanelPrivacy.vue'
import PanelStorage from './settings/PanelStorage.vue'
import PanelAddresses from './settings/PanelAddresses.vue'
import PanelWidget from './settings/PanelWidget.vue'
import PanelHelp from './settings/PanelHelp.vue'
import PanelAbout from './settings/PanelAbout.vue'
import PanelSwitchAccount from './settings/PanelSwitchAccount.vue'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()
const { isDark, toggleTheme } = useTheme()
const { load, saving, loadError } = useUserSettings()
const storage = useStorageStats()

/** 当前打开的面板。null = 全关 */
const openPanel = ref<string | null>(null)

function open(key: string) {
  openPanel.value = key
}

function close() {
  openPanel.value = null
}

// ===== 菜单分组 =====
//
// `kind` 决定这一行长什么样：
//   'route'   → 显示「查看」，点了跳走
//   'panel'   → 显示「设置」，点了开抽屉
//   'toggle'  → 右侧是开关，不显示按钮
//   'action'  → 是个动作本身（退出登录），不显示按钮
//
// 分这么细是因为**按钮文案本身就是信息**：
// 「设置」和「查看」在用户心里的预期完全不同，
// 之前全都写成「设置」而其中一半根本进不去。
interface MenuItem {
  key: string
  label: string
  icon: unknown
  desc: string
  kind: 'route' | 'panel' | 'toggle' | 'action'
  to?: string
  panel?: string
}

interface MenuGroup {
  title: string
  items: MenuItem[]
}

const groups: MenuGroup[] = [
  {
    title: '账号',
    items: [
      {
        key: 'account',
        label: '账号与安全',
        desc: '改密码 · 登录设备',
        icon: User,
        kind: 'panel',
        panel: 'account'
      },
      {
        key: 'switch',
        label: '切换账号',
        desc: '这台设备登录过的账号',
        icon: Switch,
        kind: 'panel',
        panel: 'switch'
      }
    ]
  },
  {
    title: '通用',
    items: [
      {
        key: 'general',
        label: '通用设置',
        desc: '首页落点 · 图片行为 · 密度与字号',
        icon: Setting,
        kind: 'panel',
        panel: 'general'
      },
      {
        key: 'notify',
        label: '通知设置',
        desc: '哪些互动要提醒我',
        icon: Bell,
        kind: 'panel',
        panel: 'notify'
      },
      {
        key: 'lang',
        label: '多语言和翻译',
        desc: '内容语言 · 浏览器翻译提示',
        icon: ChatLineSquare,
        kind: 'panel',
        panel: 'language'
      }
    ]
  },
  {
    title: '内容与外观',
    items: [
      {
        key: 'content',
        label: '内容偏好调节',
        desc: '推荐流凭什么这么排 · 屏蔽管理',
        icon: Operation,
        kind: 'route',
        to: '/interest'
      },
      {
        key: 'address',
        label: '收货地址',
        desc: '地址簿',
        icon: Location,
        kind: 'panel',
        panel: 'addresses'
      },
      {
        key: 'storage',
        label: '存储空间',
        desc: '这个账号占了多少',
        icon: Coin,
        kind: 'panel',
        panel: 'storage'
      },
      {
        key: 'widget',
        label: '添加小组件',
        desc: '生成浏览器侧边栏入口',
        icon: Grid,
        kind: 'panel',
        panel: 'widget'
      },
      {
        key: 'minor',
        label: '未成年人模式',
        desc: '只显示纯文字笔记',
        icon: Opportunity,
        kind: 'panel',
        panel: 'privacy'
      },
      {
        key: 'theme',
        label: '深色模式',
        desc: '',
        icon: Moon,
        kind: 'toggle'
      }
    ]
  },
  {
    title: '隐私与安全',
    items: [
      {
        key: 'privacy',
        label: '隐私设置',
        desc: '主页可见性 · 导出我的数据',
        icon: Lock,
        kind: 'panel',
        panel: 'privacy'
      }
    ]
  },
  {
    title: '帮助',
    items: [
      {
        key: 'help',
        label: '帮助与客服',
        desc: '常见问题 · 自查清单',
        icon: QuestionFilled,
        kind: 'panel',
        panel: 'help'
      },
      {
        key: 'about',
        label: '关于内容社区',
        desc: '技术栈 · 数据在哪 · 源码',
        icon: InfoFilled,
        kind: 'panel',
        panel: 'about'
      }
    ]
  }
]

// ===== 点击分发 =====
function onItemClick(item: MenuItem) {
  if (item.kind === 'toggle') {
    toggleTheme()
    return
  }
  if (item.kind === 'route' && item.to) {
    router.push(item.to)
    return
  }
  if (item.kind === 'panel' && item.panel) {
    open(item.panel)
  }
}

async function logout() {
  try {
    await ElMessageBox.confirm(
      '退出后需要重新输入邮箱和密码。已保存的设置不受影响。',
      '确认退出登录？',
      { confirmButtonText: '退出', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return // 用户点了取消
  }
  auth.logout()
  toast.show('已退出登录', 'success')
  router.push('/login')
}

const themeHint = computed(() => (isDark.value ? '深色' : '浅色'))

/** 「存储空间」那一栏显示**真实统计值**，而不是写死的假字符串 */
const storageHint = computed(() => {
  if (storage.loading.value) return '统计中…'
  if (!storage.stats.value) return '查看'
  return formatBytes(storage.stats.value.usedBytes + storage.stats.value.avatarBytes)
})

onMounted(async () => {
  await load()
  storage.load()
})
</script>

<template>
  <div class="settings">
    <header class="page-header">
      <h1 class="page-title">设置</h1>
      <p class="page-subtitle">账号、内容和外观偏好</p>
    </header>

    <!-- 读取失败的提示：可关闭，且不挡住下面的界面 -->
    <el-alert
      v-if="loadError && !openPanel"
      type="warning"
      :closable="true"
      :title="loadError"
      class="load-alert"
      @close="loadError = ''"
    />

    <div class="settings-grid">
      <el-card v-for="group in groups" :key="group.title" shadow="never" class="group-card">
        <template #header
          ><span class="group-title">{{ group.title }}</span></template
        >

        <ul class="item-list">
          <li
            v-for="item in group.items"
            :key="item.key"
            class="item-row"
            :class="{ clickable: item.kind !== 'toggle' }"
            role="button"
            tabindex="0"
            @click="onItemClick(item)"
            @keydown.enter="onItemClick(item)"
            @keydown.space.prevent="onItemClick(item)"
          >
            <el-icon class="item-icon"><component :is="item.icon" /></el-icon>

            <span class="item-text">
              <span class="item-label">{{ item.label }}</span>
              <span v-if="item.desc" class="item-desc">{{ item.desc }}</span>
            </span>

            <!-- 真实值，不是写死的假字符串 -->
            <span v-if="item.key === 'theme'" class="item-value">{{ themeHint }}</span>
            <span v-else-if="item.key === 'storage'" class="item-value tnum">
              {{ storageHint }}
            </span>

            <el-switch
              v-if="item.kind === 'toggle'"
              :model-value="isDark"
              @click.stop
              @change="toggleTheme"
            />
            <el-icon v-else class="item-arrow">
              <component :is="Monitor" />
            </el-icon>
          </li>
        </ul>
      </el-card>

      <!-- 账号摘要 -->
      <el-card shadow="never" class="group-card account-card">
        <template #header><span class="group-title">当前账号</span></template>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="昵称">
            {{ auth.user?.nickname || '未登录' }}
          </el-descriptions-item>
          <el-descriptions-item label="用户 ID">
            <span class="tnum">{{ auth.user?.id ?? '-' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="当前主题">{{ themeHint }}</el-descriptions-item>
          <el-descriptions-item label="界面库">Element Plus（主题已接管）</el-descriptions-item>
        </el-descriptions>

        <div class="legal">
          <span class="legal-title">协议与政策</span>
          <div class="legal-links">
            <!--
              指向仓库里的真实文档，而不是「文档正在完善中」。
              本项目没有真实收集用户数据，所以**不写**一份看起来很正式的
              法律文本 —— 那比不写更糟，它会让人以为这里真的在运营。
              能诚实说明的只有「这份项目怎么处理数据」这一件事。
            -->
            <a
              v-for="link in [
                { label: '数据与隐私说明', path: 'docs/PRIVACY.md' },
                { label: '架构与数据模型', path: 'docs/architecture.md' },
                { label: '功能与测试清单', path: 'README.md' }
              ]"
              :key="link.path"
              class="legal-link"
              :href="`${REPO_URL}/blob/main/${link.path}`"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ link.label }} ↗
            </a>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 危险操作 -->
    <el-card shadow="never" class="group-card danger-card">
      <div class="danger-row">
        <div class="danger-info">
          <div class="danger-title">退出登录</div>
          <p class="danger-hint">退出后需要重新输入邮箱和密码。你的笔记、设置和订单都不会丢。</p>
        </div>
        <el-button type="danger" plain :icon="SwitchButton" @click="logout">退出登录</el-button>
      </div>
    </el-card>

    <!-- ============ 面板 ============ -->
    <el-drawer
      :model-value="openPanel === 'account'"
      title="账号与安全"
      size="480px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelAccount />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'switch'"
      title="切换账号"
      size="480px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelSwitchAccount />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'general'"
      title="通用设置"
      size="480px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelGeneral />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'notify'"
      title="通知设置"
      size="480px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelNotify />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'language'"
      title="多语言和翻译"
      size="480px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelLanguage />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'privacy'"
      title="隐私设置"
      size="520px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelPrivacy />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'storage'"
      title="存储空间"
      size="480px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelStorage />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'addresses'"
      title="收货地址"
      size="560px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelAddresses />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'widget'"
      title="添加小组件"
      size="520px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelWidget />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'help'"
      title="帮助与客服"
      size="560px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelHelp />
    </el-drawer>

    <el-drawer
      :model-value="openPanel === 'about'"
      title="关于内容社区"
      size="520px"
      @update:model-value="(v: boolean) => !v && close()"
    >
      <PanelAbout />
    </el-drawer>

    <div v-if="saving" class="saving-hint">保存中…</div>
  </div>
</template>

<style scoped>
.settings {
  max-width: 860px;
  margin: 0 auto;
}

.load-alert {
  margin-bottom: 16px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: var(--fs-display);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--text-1);
}

.page-subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-base);
  color: var(--text-2);
}

/* ===== 分组卡 ===== */
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--sp-4);
  align-items: start;
}

.group-title {
  font-weight: 600;
  font-size: var(--fs-base);
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 11px 0;
}

/*
 * 整行可点，而不是只有右侧那个图标可点。
 * 44px 高的行里只放一个 20px 的图标作为点击目标，
 * 在触控板和笔记本上都会很难点中。
 */
.item-row.clickable {
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background-color var(--dur-fast) var(--ease-out-expo);
}

.item-row.clickable:hover {
  background: var(--surface-2);
}

.item-row.clickable:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.item-icon {
  color: var(--text-3);
  font-size: var(--fs-md);
  flex-shrink: 0;
}

.item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.item-label {
  font-size: var(--fs-base);
  color: var(--text-1);
}

.item-desc {
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.5;
}

.item-value {
  font-size: var(--fs-sm);
  color: var(--text-2);
  flex-shrink: 0;
}

/*
 * 箭头图标而不是文字「设置」：
 * 箭头在说「旁边还有东西」，文字在承诺一个具体动作。
 * 而且这一列换成文字之后，每行都要多占 40px。
 */
.item-arrow {
  color: var(--text-3);
  font-size: var(--fs-sm);
  transform: rotate(180deg);
  flex-shrink: 0;
}

.item-row.clickable:hover .item-arrow {
  color: var(--accent);
}

/* ===== 账号摘要 ===== */
.account-card :deep(.el-descriptions) {
  font-size: var(--fs-sm);
}

.legal {
  margin-top: var(--sp-4);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border-soft);
}

.legal-title {
  display: block;
  font-size: var(--fs-xs);
  color: var(--text-3);
  margin-bottom: var(--sp-2);
}

.legal-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-3);
}

.legal-link {
  font-size: var(--fs-xs);
  color: var(--text-2);
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-out-expo);
}

.legal-link:hover {
  color: var(--accent);
}

/* ===== 危险操作 ===== */
.danger-card {
  margin-top: var(--sp-4);
  border-color: color-mix(in srgb, var(--destructive) 35%, var(--border));
}

.danger-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-5);
}

.danger-title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-1);
}

.danger-hint {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-2);
  line-height: 1.6;
}

.saving-hint {
  position: fixed;
  right: 24px;
  bottom: 24px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-3);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: var(--fs-xs);
}
</style>
