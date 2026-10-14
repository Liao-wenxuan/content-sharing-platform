<script setup lang="ts">
/**
 * 应用外壳（桌面端三栏布局）
 *
 *   ┌──────────┬─────────────────────────┐
 *   │          │ TopBar（sticky）        │
 *   │ SideNav  ├─────────────────────────┤
 *   │ (sticky) │ <router-view>           │
 *   └──────────┴─────────────────────────┘
 *
 * 与旧版的差别：
 * - 移除移动端的 BottomNav / 抽屉 Sidebar / 双层 HomeTopTabs
 * - 新增固定左栏 SideNav 与顶栏 TopBar
 * - 登录页走独立全屏布局（不进三栏壳）
 */
import { computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
// Element Plus 的默认语言包是英文。按需引入模式下没有 app.use(ElementPlus, { locale })，
// 所以组件内部的文案会直接用默认的 en —— 中文站点上 el-select 会显示 "No data"、
// el-upload 会显示 "Click to upload"。归因时 en.mjs 实打实进了首屏 chunk。
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import SideNav from '@/components/SideNav.vue'
import TopBar from '@/components/TopBar.vue'
import ErrorBoundary from '@/components/ErrorBoundary.vue'
import { useAuthStore } from '@/stores/auth'
import { connectWs, disconnectWs } from '@/composables/useWebSocket'
import { useUserSettings } from '@/composables/useUserSettings'

const route = useRoute()
const auth = useAuthStore()

/**
 * 偏好要在**全局**加载一次，而不是等设置页打开才拉。
 *
 * 因为偏好要影响的不只是设置页：主题、密度、首页落点、内容过滤
 * 全站都读它。等进设置页才加载的话，用户第一次打开首页会先看到
 * 一瞬的默认样式再跳到真实设置 —— 那种「闪一下」比加载慢更难受。
 */
const { load: loadSettings } = useUserSettings()
loadSettings()

/** 登录页不套三栏壳：全屏居中更符合登录表单的阅读节奏 */
const isAuthPage = computed(() => route.name === 'login')

/**
 * 登录态变化时开关 WebSocket —— 放在 App 这一层统一管，
 * 免得每个用到聊天的组件都要自己 connect/disconnect，容易漏。
 */
watch(
  () => auth.token,
  (token) => {
    if (token) connectWs()
    else disconnectWs()
  },
  { immediate: true }
)

// 路由切换时回到顶部（避免从详情页返回时还停在列表中部）
// 仅在 path 变化时触发；同 path 的 query 变化保留滚动位置
watch(
  () => route.path,
  () => {
    nextTick(() => window.scrollTo({ top: 0, behavior: 'auto' }))
  }
)
</script>

<template>
  <!--
    el-config-provider 必须包住**所有**页面，而不是只包设置页。
    它是 provide/inject 注入：登录页的 el-input、发布页的 el-upload、
    任何一处的 el-select 空状态文案都从这里取语言包。
    放在顶层还顺带避免了「某些页面忘了包」的漏网。
  -->
  <el-config-provider :locale="zhCn">
    <!-- ===== 独立全屏页（登录） ===== -->
    <div v-if="isAuthPage" class="standalone">
      <ErrorBoundary>
        <router-view />
      </ErrorBoundary>
    </div>

    <!-- ===== 桌面三栏 ===== -->
    <div v-else class="shell">
      <SideNav />

      <div class="shell-body">
        <TopBar />

        <main class="content">
          <ErrorBoundary>
            <router-view />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  </el-config-provider>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}

.shell-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  padding: 24px 24px 48px;
}

.standalone {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
