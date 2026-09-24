<script setup lang="ts">
/**
 * 全局错误边界
 *
 * 工作原理：
 * - App.vue 包了一层 <ErrorBoundary>，catch 整个 router-view 子树错误
 * - 错误时显示友好降级 UI，不让整个 SPA 白屏
 * - 用户可点击「重试」重置错误状态，重新渲染
 *
 * 注意：onErrorCaptured 不会 catch 异步错误 / event handler 错误 / SSR 错误，
 *       只 catch 子组件 setup / render 阶段的同步异常。
 */
import { ref, onErrorCaptured } from 'vue'

const hasError = ref(false)
const errorMessage = ref('')

onErrorCaptured((err) => {
  console.error('[ErrorBoundary] caught:', err)
  hasError.value = true
  errorMessage.value = err instanceof Error ? err.message : String(err)
  // 返回 false 阻止继续向上传播
  return false
})

function reset() {
  hasError.value = false
  errorMessage.value = ''
}
</script>

<template>
  <!-- 正常状态：透传子内容 -->
  <slot v-if="!hasError" />

  <!-- 错误状态：友好降级 UI -->
  <div v-else class="error-fallback" role="alert">
    <div class="card">
      <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
        <path
          d="M12 9v4 M12 17h.01 M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <h2>页面出错了</h2>
      <p class="message">{{ errorMessage }}</p>
      <button class="retry-btn" type="button" @click="reset">重试</button>
    </div>
  </div>
</template>

<style scoped>
.error-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  min-height: 50vh;
}

.card {
  max-width: 420px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 32px 24px;
  box-shadow: var(--shadow-sm);
}

.icon {
  width: 48px;
  height: 48px;
  color: var(--destructive);
  margin-bottom: 12px;
}

h2 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  color: var(--foreground);
}

.message {
  margin: 0 0 20px;
  font-size: 13px;
  color: var(--muted-foreground);
  word-break: break-word;
}

.retry-btn {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: var(--radius);
  padding: 10px 24px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: opacity 0.15s;
}

.retry-btn:hover {
  opacity: 0.9;
}
</style>
