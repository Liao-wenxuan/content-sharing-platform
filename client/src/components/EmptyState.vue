<script setup lang="ts">
/**
 * 通用空状态 / 加载中 / 错误占位
 *
 * 用法：
 *   <EmptyState loading />                                 <!-- 加载中 -->
 *   <EmptyState icon="📭" title="暂无消息" hint="..." />     <!-- 空 -->
 *   <EmptyState variant="error" title="加载失败" action="重试" @action="reload" />
 */
defineProps<{
  /** variant: 'loading' | 'empty' | 'error' */
  variant?: 'loading' | 'empty' | 'error'
  /** emoji / icon（empty/error 时显示；loading 默认 spinner） */
  icon?: string
  /** 主标题 */
  title: string
  /** 副标题/提示 */
  hint?: string
  /** 主操作按钮文案（不传则不渲染） */
  action?: string
  /** 紧凑模式：缩小 padding + glyph，适合内嵌在 section 内 */
  compact?: boolean
}>()

defineEmits<{
  (e: 'action'): void
}>()
</script>

<template>
  <div
    class="empty-state"
    :class="[`variant-${variant ?? 'empty'}`, { compact: compact }]"
  >
    <div class="glyph" aria-hidden="true">
      <!-- 加载中：纯 CSS 旋转环 -->
      <span v-if="(variant ?? 'empty') === 'loading'" class="spinner" />
      <!-- 空/错误：emoji 或默认 -->
      <span v-else class="icon">{{ icon ?? (variant === 'error' ? '⚠️' : '📭') }}</span>
    </div>
    <div class="title">{{ title }}</div>
    <div v-if="hint" class="hint">{{ hint }}</div>
    <button v-if="action" type="button" class="action-btn glass-pill" @click="$emit('action')">
      {{ action }}
    </button>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  gap: 12px;
  text-align: center;
  min-height: 200px;
}

.glyph {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  margin-bottom: 4px;
}

/* 加载中：环形旋转 */
.spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid var(--glass-border);
  border-top-color: var(--accent);
  animation: empty-spin 0.8s linear infinite;
}

@keyframes empty-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 空 / 错误的图标弱化 */
.icon {
  opacity: 0.6;
  filter: grayscale(0.3);
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--foreground);
}

.hint {
  font-size: 14px;
  color: color-mix(in srgb, var(--foreground) 55%, transparent);
  max-width: 320px;
  line-height: 1.5;
}

.action-btn {
  margin-top: 12px;
  font-size: 14px;
  padding: 8px 20px;
  cursor: pointer;
  color: var(--foreground);
  transition: transform 0.15s ease;
}

.action-btn:hover {
  transform: translateY(-1px);
}

.variant-error .title {
  color: var(--destructive);
}

/* 紧凑模式：内嵌在小 section 内 */
.empty-state.compact {
  padding: 24px 16px;
  min-height: 0;
  gap: 8px;
}

.empty-state.compact .glyph {
  width: 40px;
  height: 40px;
  font-size: 24px;
}

.empty-state.compact .spinner {
  width: 24px;
  height: 24px;
  border-width: 2px;
}

.empty-state.compact .title {
  font-size: 14px;
}

.empty-state.compact .hint {
  font-size: 13px;
}
</style>