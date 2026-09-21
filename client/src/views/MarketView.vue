<script setup lang="ts">
// 市集（Mallplace）暂未实现，留个占位路由避免 BottomNav 点击 404
</script>

<template>
  <div class="market-stub">
    <svg viewBox="0 0 64 64" class="empty-icon" aria-hidden="true">
      <path d="M8 16h48l-4 36H12L8 16z" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M22 16v-4a10 10 0 0 1 20 0v4" fill="none" stroke="currentColor" stroke-width="2" />
    </svg>
    <h1>市集功能即将上线</h1>
    <p>商品橱窗、订单、购物车会在这里 ✨</p>
    <router-link to="/" class="back-home">返回首页</router-link>
  </div>
</template>

<style scoped>
.market-stub {
  max-width: 480px;
  margin: 80px auto;
  padding: 24px;
  text-align: center;
  color: var(--muted-foreground);
}

.empty-icon {
  width: 64px;
  height: 64px;
  margin-bottom: 12px;
  opacity: 0.6;
}

h1 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground);
}

p {
  font-size: 13px;
  margin: 0 0 16px;
}

.back-home {
  display: inline-block;
  padding: 8px 18px;
  border-radius: var(--radius);
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 13px;
  text-decoration: none;
  font-weight: 500;
}
</style>