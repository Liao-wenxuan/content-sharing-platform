<script setup lang="ts">
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()
</script>

<template>
  <!-- 浮动 toast，固定在屏幕底部 -->
  <Transition name="toast">
    <div
      v-if="toast.current"
      class="toast"
      :class="`tone-${toast.current.tone ?? 'info'}`"
      role="status"
      aria-live="polite"
      @click="toast.dismiss()"
    >
      {{ toast.current.message }}
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(80px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 200;
  max-width: calc(100vw - 32px);
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 500;
  /* Liquid glass toast：跟随主题（dark 黑玻璃 / light 白玻璃） */
  background: var(--glass-bg-strong);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border: 1px solid var(--glass-border);
  color: var(--foreground);
  box-shadow: var(--glass-shadow);
  cursor: pointer;
  user-select: none;
}

.tone-success {
  background: rgba(34, 197, 94, 0.85);
  border-color: rgba(34, 197, 94, 0.5);
  color: #fff;
}

.tone-error {
  background: rgba(239, 68, 68, 0.85);
  border-color: rgba(239, 68, 68, 0.5);
  color: #fff;
}

/* 进出动画 */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.2s,
    transform 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
</style>
