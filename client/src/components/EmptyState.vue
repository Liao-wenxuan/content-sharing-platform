<script setup lang="ts">
/**
 * 通用空状态 / 加载中 / 错误占位
 *
 * 桌面端改造后改用 Element Plus：
 * - loading → ElSkeleton（比原来的 CSS 旋转环更像"正在加载内容"）
 * - empty / error → ElEmpty，emoji 走 `#image` 插槽自定义
 *
 * 用法：
 *   <EmptyState variant="loading" title="正在加载笔记..." />
 *   <EmptyState icon="📭" title="暂无消息" hint="..." />
 *   <EmptyState variant="error" title="加载失败" action="重试" @action="reload" />
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** variant: 'loading' | 'empty' | 'error' */
    variant?: 'loading' | 'empty' | 'error'
    /** emoji（empty/error 时显示；不传则按 variant 用默认） */
    icon?: string
    /** 主标题 */
    title: string
    /** 副标题/提示 */
    hint?: string
    /** 主操作按钮文案（不传则不渲染） */
    action?: string
    /** 紧凑模式：缩小留白，适合内嵌在 section 内 */
    compact?: boolean
  }>(),
  { variant: 'empty', compact: false, icon: undefined, hint: undefined, action: undefined }
)

defineEmits<{
  (e: 'action'): void
}>()

const isLoading = computed(() => props.variant === 'loading')
const isError = computed(() => props.variant === 'error')
const glyph = computed(() => props.icon ?? (isError.value ? '⚠️' : '📭'))
</script>

<template>
  <div class="empty-state" :class="{ compact }">
    <!-- 加载中：骨架屏 -->
    <el-skeleton v-if="isLoading" :rows="3" animated class="skeleton" />

    <!-- 空 / 错误 -->
    <el-empty v-else :description="title" :image-size="compact ? 56 : 76">
      <template #image>
        <span class="glyph" :class="{ danger: isError }">{{ glyph }}</span>
      </template>

      <p v-if="hint" class="hint">{{ hint }}</p>
      <el-button v-if="action" type="primary" plain size="default" @click="$emit('action')">
        {{ action }}
      </el-button>
    </el-empty>
  </div>
</template>

<style scoped>
.empty-state {
  padding: 48px 24px;
  width: 100%;
}

.empty-state.compact {
  padding: 20px 12px;
}

.skeleton {
  max-width: 420px;
  margin: 0 auto;
}

.glyph {
  font-size: 56px;
  line-height: 1;
  opacity: 0.75;
}

.compact .glyph {
  font-size: 38px;
}

.glyph.danger {
  opacity: 1;
}

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--muted-foreground);
  max-width: 360px;
  line-height: 1.6;
}
</style>
