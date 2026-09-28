<script setup lang="ts">
/**
 * 404 页
 *
 * 桌面端改造：手写大号 "404" 数字 + 自绘 orb → ElResult。
 * 保留原来的两个出口：回首页 / 返回上一页。
 */
import { useRouter } from 'vue-router'
import { House, ArrowLeft } from '@element-plus/icons-vue'

const router = useRouter()

function goHome() {
  router.replace({ name: 'home' })
}

function goBack() {
  // 没有历史栈就回首页
  if (window.history.length > 1) {
    router.back()
  } else {
    router.replace({ name: 'home' })
  }
}
</script>

<template>
  <div class="not-found">
    <el-result icon="warning" title="404" sub-title="页面不存在，或者已经被移除了">
      <template #extra>
        <el-button type="primary" :icon="House" @click="goHome">回到首页</el-button>
        <el-button :icon="ArrowLeft" @click="goBack">返回上一页</el-button>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.not-found {
  max-width: 640px;
  margin: 0 auto;
  padding-top: 32px;
}

/* 404 数字用主色描边感：跟随主题的红色 */
.not-found :deep(.el-result__title p) {
  font-size: 56px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--accent);
}
</style>
