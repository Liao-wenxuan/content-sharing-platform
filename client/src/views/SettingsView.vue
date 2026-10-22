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
import { ElMessageBox } from '@/utils/element'
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
        label: '内容偏好',
        desc: '屏蔽话题 · 多语言说明',
        icon: ChatLineSquare,
        kind: 'panel',
        panel: 'language'
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
      },
      {
        key: 'minor',
        label: '未成年人模式',
        desc: '只显示纯文字笔记',
        icon: Opportunity,
        kind: 'panel',
        panel: 'privacy'
      }
    ]
  },
  {
    /*
     * 卡片顺序是**算出来的**，不是随手排的。
     *
     * 布局是多列（column-width），浏览器只能**整卡断列** ——
     * 一张 3 行的卡不可能被拆到两列去。所以两列想一样高，
     * 唯一的办法是让每列各含一张 3 行的卡：
     *
     *   左列 账号(2) + 通用(3) + 隐私与安全(2)     = 7 行
     *   右列 内容与外观(3) + 常用工具(2) + 帮助(2) = 7 行
     *
     * 交换「内容与外观」和「隐私与安全」之前，右列是 2+2+2 行，
     * 和左列差整整一张 3 行卡 —— 实测列底落差 137px，右下角空一块。
     * 换完之后，三档密度的落差实测全是 0px。
     *
     * item 的 key / label / panel 全部没动 —— 13 个可点击项的数量不变，
     * e2e 是按 label 定位的，所以这套分组改动对测试是透明的。
     */
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
        key: 'theme',
        label: '深色模式',
        desc: '配色与对比度',
        icon: Moon,
        kind: 'toggle'
      },
      {
        key: 'widget',
        label: '添加小组件',
        desc: '生成浏览器侧边栏入口',
        icon: Grid,
        kind: 'panel',
        panel: 'widget'
      }
    ]
  },
  {
    title: '常用工具',
    items: [
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

        <!--
          ⚠️ <li> 只负责列表语义，可点的是里面的 <button>。

          之前这里是 `<li class="item-row" role="button" tabindex="0">`，
          同一个 role 同时坏了两件事：
          ① role 覆盖掉 <li> 隐含的 listitem，axe 判「<ul> 里出现了
             不允许的子节点 [role=button]」（5 张卡片各中一次）
          ② 带开关的行里套着 el-switch，是交互控件嵌套（serious）

          所以开关行不给 role，也不整行可点 —— 它本来也只有开关可点。
          开关自己带 aria-label：读屏念到它时得知道自己在切什么，
          而行首那行字对开关不是 label。
        -->
        <ul class="item-list">
          <li v-for="item in group.items" :key="item.key" class="item-item">
            <div v-if="item.kind === 'toggle'" class="item-row" :data-item="item.key">
              <el-icon class="item-icon"><component :is="item.icon" /></el-icon>

              <span class="item-text">
                <span class="item-label">{{ item.label }}</span>
                <span v-if="item.desc" class="item-desc">{{ item.desc }}</span>
              </span>

              <span v-if="item.key === 'theme'" class="item-value">{{ themeHint }}</span>

              <el-switch :model-value="isDark" :aria-label="item.label" @change="toggleTheme" />
            </div>

            <button
              v-else
              type="button"
              class="item-row clickable"
              :data-item="item.key"
              @click="onItemClick(item)"
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

              <el-icon class="item-arrow">
                <component :is="Monitor" />
              </el-icon>
            </button>
          </li>
        </ul>
      </el-card>
    </div>

    <!--
      页脚带：账号摘要 + 危险操作。

      这两张卡原来一张在多列流里、一张在流外。
      「当前账号」那张有 4 行摘要 + 协议链接，在列里是 307px，
      而且排在最后 —— 于是右列 4 张卡、左列 3 张，列底落差 186px，
      底下空出一大块。

      挪到页脚并把摘要横排之后：
        - 列里只剩 6 张卡，浏览器按 3/3 均分；
        - 账号摘要自己变成一条 ~130px 的信息带，和「退出登录」并排；
        - 整页比原来矮 220px。
    -->
    <div class="settings-footer">
      <el-card shadow="never" class="group-card account-card">
        <template #header><span class="group-title">当前账号</span></template>
        <!--
          横排而不是竖排。竖排 4 行摘要把卡撑到 307px，
          而这里是页脚，越矮越像信息带、越不像又一张卡片。
          用 dl/dt/dd 而不是 el-descriptions：
          el-descriptions 的列数是写死的 prop，没法跟着宽度换，
          窄屏就得再写一个 media query 把 4 列压回 1 列。
          flex + wrap 天然会换行，不需要额外的断点。
        -->
        <dl class="account-facts">
          <div class="fact">
            <dt>昵称</dt>
            <dd>{{ auth.user?.nickname || '未登录' }}</dd>
          </div>
          <div class="fact">
            <dt>用户 ID</dt>
            <dd class="tnum">{{ auth.user?.id ?? '-' }}</dd>
          </div>
          <div class="fact">
            <dt>当前主题</dt>
            <dd>{{ themeHint }}</dd>
          </div>
          <div class="fact">
            <dt>界面库</dt>
            <dd>Element Plus（主题已接管）</dd>
          </div>
        </dl>

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
    </div>

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
      title="内容偏好"
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
  max-width: var(--content-max-width);
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
/*
 * 这里用 CSS 多列（multi-column）而不是 Grid，量过之后换的。
 *
 * Grid 是**行式**布局：同一横排的格子共享一个行高，所以每排里
 * 最高的那张卡片会把旁边几张撑出空白。而设置页各分组的条目数差异很大
 * （原来一张 6 项、一张 1 项），这个空白就会大到「像缺了一块卡片」。
 *
 * 同样的内容量下实测三种方案：
 *
 *   方案                同排最大空洞   两列底部落差   内容区总高
 *   Grid（原来）            69px         323px      1206px
 *   multi-column（第一版）  —（无「排」   186px      1069px
 *                         的概念）
 *   + 账号摘要挪进页脚带      —           137px       883px
 *   + 分组重新分配（这一版）  —             0px       814px
 *
 * 多列是每列各自流动，空白被摊在每张卡片下方，而不是攒成
 * 「一整张卡片的下方全空」那一块 —— 视觉上后者才是刺眼的那种。
 *
 * ⚠️ 顺序没有被打乱：多列按列填充，从上到下读完左列再读右列，
 * 正好等于 DOM 顺序（账号 → 通用 → 隐私与安全 → 内容与外观 →
 * 常用工具 → 帮助）。「当前账号」挪到了页脚带，不参与分列。
 *
 * 试过但撤回的两种：
 *   - Grid + align-items: stretch：边框齐了，但「账号」只有 2 行、
 *     「内容与外观」有 6 行，前者被拉出半张卡片的空洞，同样更糟。
 *   - Grid + grid-auto-flow: dense：前四张刚好填满 2×2，没有空洞可回填。
 */
.settings-grid {
  /*
   * 用 column-width 而不是 columns: 2 —— 前者让浏览器按容器宽度
   * 自己决定列数：1080 的内容宽下正好出 2 列，窄屏（不足两张 440px）
   * 自动收成单列，和原来 minmax(440px, 1fr) 的断点一致。
   */
  column-width: 440px;
  column-gap: var(--sp-4);
}

.group-card {
  /* 卡片绝不能被列切成两半 */
  break-inside: avoid;
  margin: 0 0 var(--sp-4) 0;
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

/* <li> 只提供列表语义，不再承担点击和聚焦 */
.item-item {
  list-style: none;
}

.item-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  /*
   * 用 --sp-3 而不是量出来的 11px，是为了让密度档位真的生效。
   *
   * 行高由「图标高」和「文字高」两者取大决定，而 .item-text 在没有
   * desc 时只有一行 —— 那时行高被 32px 的图标卡住，量下来三档都是
   * 54px 纹丝不动。切「界面密度」时只有卡片之间的 gap 在变，
   * 行与行的呼吸感完全不变，看着就像密度只生效了一半。
   */
  padding: var(--sp-3) 0;
}

/*
 * 整行可点，而不是只有右侧那个图标可点。
 * 44px 高的行里只放一个 20px 的图标作为点击目标，
 * 在触控板和笔记本上都会很难点中。
 *
 * .clickable 现在同时挂在 div 和 button 上，但只有 button 分支带点击行为，
 * 所以 cursor / hover 写在这里不会给开关行安上一个点不动的光标。
 */
.item-row.clickable {
  /* button 自带的边框和背景要抹掉，否则焦点框会被浏览器默认样式顶掉 */
  width: 100%;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
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
  /*
   * 原来是 1px。在 comfortable 档（line-height 1.9）下 label 占 26.6px、
   * desc 占 22.8px，中间那 1px 完全看不出来，标题和说明糊成一团。
   * 4px 才够把「这是什么」和「这里面有什么」分成两行。
   */
  gap: var(--sp-1);
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

/* ===== 账号摘要（页脚带） ===== */
.account-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-6);
  margin: 0;
}

.fact {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.fact dt {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.fact dd {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-1);
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

/* ===== 页脚带 ===== */
/*
 * 账号摘要和危险操作并排成一条带。
 * align-items: stretch 是有意的：两张卡高度不一时，矮的那张补齐，
 * 带子内部不留空洞。
 */
.settings-footer {
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: var(--sp-4);
  margin-top: var(--sp-2);
}

.settings-footer .account-card {
  flex: 1 1 420px;
}

.settings-footer .danger-card {
  flex: 0 1 340px;
}

/* ===== 危险操作 ===== */
.danger-card {
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
