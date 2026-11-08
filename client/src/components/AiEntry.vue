<script setup lang="ts">
/**
 * 顶栏的「站内 AI」入口 —— 只有触发器。
 *
 * 面板在 AiPanel.vue 里，用 defineAsyncComponent **异步**加载。
 *
 * 为什么拆开：AI 面板是「点开才用」的东西，而触发器只是个按钮。
 * 静态 import 的话，面板那 4~5 KB 代码 + 它的 scoped CSS 全都进首屏 chunk ——
 * 实测 entry raw 从 273.41 KiB 涨到 277.84 KiB。
 * 这个项目一贯的主张是「首页不加载用户不会点的功能的代码」
 * （首页本来就不加载 el-upload / el-dialog），所以这里保持一致。
 *
 * 异步本来配了一句 onMounted 预热（顶栏一挂载就下载），但首屏性能实测里
 * 它稳定出现在「视口图片就绪」之前：AiPanel + ai + CSS 共 3 个请求，
 * 和 entry / CSS / 封面抢同一条 1.6Mbps 的管道。用户还没表示要点，
 * 首页却为它付了 3 次往返 —— 这和上面「首页不加载不会点的功能」自相矛盾。
 *
 * 现在改成**只按意图**预热：鼠标移到按钮 / 键盘聚焦时立刻下载；
 * 点击时 defineAsyncComponent 自己会加载，4KB 的 chunk 不构成等待。
 * 不再设「页面加载完过几秒自动预热」的兜底 —— 实测它总会落进
 * 首屏关键资源的下载窗口，等于又把那 3 个请求请回来了。
 */
import { ref, defineAsyncComponent } from 'vue'
import { useRouter } from 'vue-router'
import { MagicStick } from '@element-plus/icons-vue'

const router = useRouter()
const open = ref(false)

const loadPanel = () => import('@/components/AiPanel.vue')
const AiPanel = defineAsyncComponent(loadPanel)

let warmed = false
function warmPanel() {
  if (warmed) return
  warmed = true
  void loadPanel()
}

function ask(text: string) {
  open.value = false
  router.push({ path: '/ai', query: { q: text } })
}
</script>

<template>
  <el-tooltip content="站内 AI 问答" placement="bottom">
    <el-button
      class="icon-btn ai-trigger-btn"
      circle
      :icon="MagicStick"
      aria-label="站内 AI 问答"
      @click="open = true"
      @pointerenter="warmPanel"
      @focus="warmPanel"
    />
  </el-tooltip>

  <component :is="AiPanel" v-if="open" @close="open = false" @ask="ask" />
</template>
