<script setup lang="ts">
/**
 * 市集（Mallplace）占位页
 *
 * 功能还没做，先用 Element Plus 的 ElResult 撑住页面，
 * 避免点导航直接 404。原注释里的 "BottomNav" 已随移动端下线一起删除。
 */
import { Shop } from '@element-plus/icons-vue'
</script>

<template>
  <div class="market">
    <el-result icon="warning" title="市集功能即将上线" sub-title="商品橱窗、订单、购物车会在这里">
      <template #icon>
        <el-icon class="result-icon"><component :is="Shop" /></el-icon>
      </template>
      <template #extra>
        <el-button type="primary" @click="$router.push('/')">返回首页</el-button>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.market {
  max-width: 720px;
  margin: 0 auto;
  padding-top: 40px;
}

.result-icon {
  font-size: 64px;
  color: var(--muted-foreground);
}
</style>
