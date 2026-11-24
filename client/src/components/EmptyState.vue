<!--
From Uiverse.io by mobinkakei - https://uiverse.io/mobinkakei/grumpy-turtle-41
MIT License, Copyright (c) mobinkakei (Mobeen)
-->
<script setup lang="ts">
/**
 * 通用空状态 / 加载中 / 错误占位
 *
 * loading → 三点弹跳 loader（来自 Uiverse.io / mobinkakei，见文件头版权注释）。
 *   为适配本项目做了三处改动，动画本身原样保留：
 *   1. 类名加 sg-loader- 前缀——wrapper/circle/shadow 太通用，会撞项目样式
 *   2. 圆点 #fff → var(--foreground)：浅色主题下白点会消失
 *   3. 阴影 rgba(0,0,0,.9) → var(--foreground) + 低透明度：黑影在深色底上本就不可见
 * empty / error → ElEmpty，emoji 走 `#image` 插槽自定义
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
    <!--
      加载中：三点弹跳 loader（Uiverse.io / mobinkakei）
      role="status" + aria-label：读屏会念出「正在加载笔记...」，
      而不是对着三个装饰圆点沉默。
    -->
    <div v-if="isLoading" class="sg-loader-wrap" role="status" :aria-label="title">
      <div class="sg-loader-inner">
        <div class="sg-loader-circle"></div>
        <div class="sg-loader-circle"></div>
        <div class="sg-loader-circle"></div>
        <div class="sg-loader-shadow"></div>
        <div class="sg-loader-shadow"></div>
        <div class="sg-loader-shadow"></div>
      </div>
      <p class="sg-loader-caption">{{ title }}</p>
    </div>

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

/* ===== 三点弹跳 loader（From Uiverse.io by mobinkakei）=====
 * 尺寸、时长、错峰延迟全部沿用原组件；只换了配色来源以适配双主题。
 * reduced-motion 由 motion.css 的全局兜底接管，这里不重复写。
 */
.sg-loader-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.sg-loader-inner {
  width: 200px;
  height: 60px;
  position: relative;
  z-index: 1;
}

.sg-loader-circle {
  width: 20px;
  height: 20px;
  position: absolute;
  border-radius: 50%;
  /* 原组件是 #fff；用 --foreground 后深色主题仍是白点，浅色主题自动转深色 */
  background-color: var(--foreground);
  left: 15%;
  transform-origin: 50%;
  animation: sg-circle-bounce 0.5s alternate infinite ease;
}

@keyframes sg-circle-bounce {
  0% {
    top: 60px;
    height: 5px;
    border-radius: 50px 50px 25px 25px;
    transform: scaleX(1.7);
  }
  40% {
    height: 20px;
    border-radius: 50%;
    transform: scaleX(1);
  }
  100% {
    top: 0%;
  }
}

.sg-loader-circle:nth-child(2) {
  left: 45%;
  animation-delay: 0.2s;
}

.sg-loader-circle:nth-child(3) {
  left: auto;
  right: 15%;
  animation-delay: 0.3s;
}

.sg-loader-shadow {
  width: 20px;
  height: 4px;
  border-radius: 50%;
  /* 原组件是 rgba(0,0,0,.9) + blur(1px)：黑影在深色底上几乎看不见。
     改成跟随前景色 + 低透明度，两个主题都看得见，且不引入新颜色。 */
  background-color: var(--foreground);
  opacity: 0.22;
  position: absolute;
  top: 62px;
  transform-origin: 50%;
  z-index: -1;
  left: 15%;
  filter: blur(1px);
  animation: sg-shadow-pulse 0.5s alternate infinite ease;
}

@keyframes sg-shadow-pulse {
  0% {
    transform: scaleX(1.5);
  }
  40% {
    transform: scaleX(1);
    opacity: 0.15;
  }
  100% {
    transform: scaleX(0.2);
    opacity: 0.08;
  }
}

.sg-loader-shadow:nth-child(4) {
  left: 45%;
  animation-delay: 0.2s;
}

.sg-loader-shadow:nth-child(5) {
  left: auto;
  right: 15%;
  animation-delay: 0.3s;
}

.sg-loader-caption {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
  line-height: 1.6;
}

.empty-state.compact .sg-loader-inner {
  transform: scale(0.7);
  margin: -10px 0 -18px;
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
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
  max-width: 360px;
  line-height: 1.6;
}
</style>
