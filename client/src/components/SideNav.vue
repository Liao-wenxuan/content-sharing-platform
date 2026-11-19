<script setup lang="ts">
/**
 * 桌面端左侧固定导航。
 *
 * 只放「需要反复切换」的主干入口：搜索在顶栏（带即时建议下拉）。
 * 消息在侧栏和顶栏铃铛各有一个入口 —— 铃铛负责「扫一眼未读」，
 * 侧栏负责「我要进去处理」，两边共用同一份未读状态，数字不会打架。
 *
 * ≤768px 整栏隐藏，交给 MobileNav 的底部导航 ——
 * 216px 的常驻左栏在 375 宽下会把内容挤成一条，折叠不了就只能换形态。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Compass, EditPen, User, Setting, Star, Collection, Bell } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useWebSocket } from '@/composables/useWebSocket'
import { useNotifications } from '@/composables/useNotifications'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
// 和顶栏铃铛用同一份单例状态：通知未读 + 私信未读。
// 这里只读不订阅 —— 拉数和 WS 订阅由 TopBar 统一管，侧栏不重复 connect。
const { unreadTotal: chatUnread } = useWebSocket()
const { unreadCount: notifyUnread } = useNotifications()
const messageUnread = computed(() => chatUnread.value + notifyUnread.value)

interface NavItem {
  path: string
  label: string
  icon: unknown
  /** 需要登录才显示（未登录点进去也只会被路由守卫弹回登录页） */
  requiresAuth?: boolean
}

const navItems: NavItem[] = [
  { path: '/', label: '发现', icon: Compass },
  // 和「发现」共用 `/` 这一个 path（只是 query 的差别），见 activeMenu
  { path: '/?channel=follow', label: '关注', icon: Star, requiresAuth: true },
  { path: '/publish', label: '发布', icon: EditPen, requiresAuth: true },
  { path: '/messages', label: '消息', icon: Bell, requiresAuth: true },
  // 收藏夹管理页：主页「收藏」tab 只管看，整理归类放这里
  { path: '/favorites', label: '收藏', icon: Collection, requiresAuth: true },
  { path: '/profile/me', label: '我的', icon: User },
  { path: '/settings', label: '设置', icon: Setting, requiresAuth: true }
]

const visibleItems = computed(() =>
  navItems.filter((item) => !item.requiresAuth || auth.isLoggedIn)
)

/** 是否停在关注流（发现页的 channel=follow 视图） */
const isFollowRoute = computed(() => route.path === '/' && route.query.channel === 'follow')

/**
 * 当前高亮的菜单项。
 *
 * 「发现」和「关注」共用 `/` 这一个 path，只按 path 判会同时高亮两项，
 * 所以 `/` 要单独判 query。
 *
 * 早期版本给 NavItem 加了个 match() 让「发现」优先匹配，
 * 结果发现项的 match 在**所有**非关注路由上都返回 true，
 * find() 第一个就命中，于是 /favorites、/settings 全被高亮成「发现」。
 * match() 这种「靠第一个 true 决定结果」的写法太容易误伤，
 * 改成按 path 穷举，每个分支都能一眼看出该高亮谁。
 */
const activeMenu = computed(() => {
  const path = route.path
  if (path === '/') return isFollowRoute.value ? '/?channel=follow' : '/'
  if (path.startsWith('/profile')) return '/profile/me'
  // 粉丝 / 关注列表是从「关注」这一项点进去的下钻页，高亮要跟着回「关注」，
  // 否则这一页侧栏全灭，看不出自己从哪来
  if (path.startsWith('/follows')) return '/?channel=follow'
  // 消息页有侧栏入口了，?tab=chat 之类的 query 不影响：菜单 index 只看 path
  if (path.startsWith('/messages')) return '/messages'
  // 笔记详情和搜索的入口不在侧栏，回落高亮「发现」保持连贯
  if (path.startsWith('/post')) return '/'
  if (path.startsWith('/search')) return '/'
  // 兴趣画像的入口在「设置 → 内容偏好调节」，不在侧栏。  // 但从首页「这些推荐是怎么来的？」点进来时，侧栏要有个去处，
  // 否则这一页侧栏全灭，用户不知道自己在哪
  if (path.startsWith('/interest')) return '/settings'
  return path
})

/**
 * 侧栏底部只有一个入口：未登录时是「登录 / 注册」。
 *
 * ⚠️ 这里原来还有一条 logout 分支（auth.logout() + toast + 跳回首页），
 * 但模板里从来没有任何地方调用它 —— 退出登录在顶栏的账号菜单
 * （TopBar.vue）和设置页（SettingsView.vue）里各有一处。
 * 一个永远走不到的分支比没有更糟：它让人以为侧栏管退出登录，
 * 读代码的人还得去模板里找一遍才能确认它不生效。已删。
 */
function handleCommand(command: string) {
  if (command === 'login') {
    router.push({ name: 'login', query: { redirect: route.fullPath } })
  }
}
</script>

<template>
  <aside class="side-nav">
    <!-- 品牌区 -->
    <div class="brand">
      <span class="brand-mark">拾</span>
      <span class="brand-name">内容社区</span>
    </div>

    <!-- 主导航 -->
    <el-menu :default-active="activeMenu" :router="true" class="nav-menu">
      <el-menu-item v-for="item in visibleItems" :key="item.path" :index="item.path">
        <!-- 未读角标挂在图标上（导航角标惯例：贴图标右上），不是挂在文字上——
             后者会把红点推到菜单项中部，看着像飘在半空 -->
        <el-badge
          v-if="item.path === '/messages' && messageUnread > 0"
          :value="messageUnread"
          :max="99"
          class="nav-badge"
        >
          <el-icon><component :is="item.icon" /></el-icon>
        </el-badge>
        <el-icon v-else><component :is="item.icon" /></el-icon>
        <span>{{ item.label }}</span>
      </el-menu-item>
    </el-menu>

    <!-- 底部：登录入口 / 创作引导 -->
    <div class="side-footer">
      <template v-if="auth.isLoggedIn">
        <p class="footer-tip">记录当下，分享生活</p>
      </template>
      <el-button v-else type="primary" class="login-btn" @click="handleCommand('login')">
        登录 / 注册
      </el-button>
    </div>
  </aside>
</template>

<style scoped>
.side-nav {
  width: var(--side-nav-width);
  flex-shrink: 0;
  height: 100vh;
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--background);
  padding: 20px 12px;
}

/* ===== 品牌 ===== */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 20px;
}

.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: var(--fs-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.brand-name {
  font-size: var(--fs-md);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--foreground);
}

/* ===== 导航 ===== */
.nav-menu {
  border-right: none;
  flex: 1;
}

.nav-menu :deep(.el-menu-item) {
  height: 42px;
  line-height: 42px;
  border-radius: var(--radius-sm);
  margin-bottom: 2px;
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-out-expo),
    color var(--dur-fast) var(--ease-out-expo);
}

/*
 * 选中态用「左描边 + 强调色文字」，不靠底色。
 *
 * 底色方案（原来 var(--muted)）的问题：一行 42px 高、宽 184px 的块，
 * 填满底色后视觉重量太大，7 个菜单项里只要有一个选中，
 * 整个侧栏的重心就歪了。参照项目用的是 2px 的竖条 ——
 * 更轻，而且「在这里」这件事比「这一块亮了」更明确。
 */
.nav-menu :deep(.el-menu-item.is-active) {
  background: var(--surface-2);
  color: var(--accent);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--accent);
}

.nav-menu :deep(.el-menu-item:hover) {
  background: var(--surface-2);
  color: var(--text-1);
}

/* 消息项的未读角标：收进 42px 高的行里，别让红点贴到隔壁项 */
.nav-menu :deep(.nav-badge) {
  display: inline-flex;
  align-items: center;
}

.nav-menu :deep(.nav-badge .el-badge__content) {
  /* badge 包的是图标。EP 默认 transform 把角标右移自身半宽多，红点会飘到
     图标右边 ~14px；用 right 往回推，让红点中心落在图标右上角。 */
  top: 0;
  right: 14px;
  border: none;
  font-size: var(--fs-2xs);
}

/* 选中项 hover 时不要把强调色冲掉 */
.nav-menu :deep(.el-menu-item.is-active:hover) {
  color: var(--accent);
}

/* ===== 底部 ===== */
.side-footer {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.footer-tip {
  margin: 0;
  padding: 0 8px;
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
  line-height: 1.6;
}

.login-btn {
  width: 100%;
  font-weight: 600;
}

/* 与 App.vue / MobileNav.vue / TopBar.vue 同一个断点 */
@media (max-width: 768px) {
  .side-nav {
    display: none;
  }
}
</style>
