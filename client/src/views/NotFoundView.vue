<script setup lang="ts">
import { useRouter } from 'vue-router'

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
  <div class="not-found glass">
    <div class="glyph" aria-hidden="true">
      <span class="digit">4</span>
      <span class="orb" />
      <span class="digit">4</span>
    </div>
    <h1 class="title">这里什么都没有</h1>
    <p class="subtitle">页面不存在，或者已经被移除了</p>
    <div class="actions">
      <button class="btn glass-pill primary" @click="goHome">回到首页</button>
      <button class="btn glass-pill" @click="goBack">返回上一页</button>
    </div>
  </div>
</template>

<style scoped>
.not-found {
  /* 占满主内容区，居中布局 */
  min-height: calc(100vh - 72px - 92px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  gap: 16px;
  /* glass token 已经给出半透明 + 模糊；这里加一档"卡片感" */
  background: var(--glass-bg);
  border-radius: 24px;
  margin: 24px auto;
  max-width: 560px;
  width: calc(100% - 32px);
}

.glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 120px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.04em;
  color: var(--foreground);
  margin-bottom: 8px;
}

.glyph .digit {
  background: linear-gradient(180deg, var(--foreground) 0%, color-mix(in srgb, var(--foreground) 40%, transparent) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.glyph .orb {
  width: 0.9em;
  height: 0.9em;
  border-radius: 50%;
  background: radial-gradient(
    circle at 30% 30%,
    color-mix(in srgb, var(--accent) 80%, white 0%) 0%,
    var(--accent) 60%,
    color-mix(in srgb, var(--accent) 40%, transparent) 100%
  );
  box-shadow: 0 0 32px color-mix(in srgb, var(--accent) 50%, transparent);
  animation: orb-pulse 3s ease-in-out infinite;
}

@keyframes orb-pulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow: 0 0 32px color-mix(in srgb, var(--accent) 50%, transparent);
  }
  50% {
    transform: scale(1.08);
    box-shadow: 0 0 48px color-mix(in srgb, var(--accent) 70%, transparent);
  }
}

.title {
  font-size: 28px;
  font-weight: 600;
  margin: 0;
  color: var(--foreground);
}

.subtitle {
  font-size: 15px;
  color: color-mix(in srgb, var(--foreground) 60%, transparent);
  margin: 0;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
  justify-content: center;
}

.btn {
  font-size: 14px;
  padding: 10px 22px;
  cursor: pointer;
  color: var(--foreground);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.btn:hover {
  transform: translateY(-1px);
}

.btn.primary {
  background: var(--accent);
  color: white;
  border-color: transparent;
}

@media (max-width: 480px) {
  .glyph {
    font-size: 88px;
    gap: 8px;
  }
  .title {
    font-size: 22px;
  }
  .not-found {
    min-height: calc(100vh - 72px - 88px);
    padding: 32px 20px;
  }
}
</style>