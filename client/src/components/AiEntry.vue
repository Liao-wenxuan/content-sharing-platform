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
 * 异步的代价是第一次点开可能等一下 chunk 下载，所以 onMounted 里**预热**一次 ——
 * 顶栏渲染时就开始下载，等用户真的去点，通常已经就绪。
 */
import { ref, defineAsyncComponent, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { MagicStick } from '@element-plus/icons-vue'

const router = useRouter()
const open = ref(false)

const loadPanel = () => import('@/components/AiPanel.vue')
const AiPanel = defineAsyncComponent(loadPanel)

// 预热：不等用户点才去下载
onMounted(() => {
  void loadPanel()
})

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
    />
  </el-tooltip>

  <component :is="AiPanel" v-if="open" @close="open = false" @ask="ask" />
</template>
