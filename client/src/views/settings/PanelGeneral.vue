<script setup lang="ts">
/**
 * 通用设置：首页落点 / 图片行为 / 密度与字号
 *
 * 全部走 `useUserSettings`，改完立刻生效并防抖保存 ——
 * 这一页不该有「保存」按钮：14 个开关让用户自己记得点保存是不现实的。
 */
import { useUserSettings } from '@/composables/useUserSettings'
import { CHANNELS } from '@/api/settings'

const { settings, update } = useUserSettings()

const FEED_OPTIONS = [
  { value: 'recommend', label: '推荐流', desc: '按兴趣个性化排序' },
  { value: 'follow', label: '关注流', desc: '只看订阅的内容' },
  { value: 'category', label: '频道流', desc: '按内容频道浏览' }
] as const

const DENSITY_OPTIONS = [
  { value: 'compact', label: '紧凑', desc: '一屏多两条' },
  { value: 'normal', label: '标准' },
  { value: 'comfortable', label: '宽松', desc: '行距更大' }
] as const

const FONT_OPTIONS = [
  { value: 100, label: '100%' },
  { value: 110, label: '110%' },
  { value: 125, label: '125%' }
] as const
</script>

<template>
  <div class="panel">
    <section class="block">
      <h3 class="block-title">打开首页时</h3>
      <p class="block-desc">决定你按下回车后第一眼看到的是什么。</p>

      <el-radio-group
        :model-value="settings.defaultFeed"
        class="stack"
        @update:model-value="(v: any) => update('defaultFeed', v)"
      >
        <el-radio v-for="o in FEED_OPTIONS" :key="o.value" :value="o.value" class="radio">
          <span class="radio-label">{{ o.label }}</span>
          <span class="radio-desc">{{ o.desc }}</span>
        </el-radio>
      </el-radio-group>

      <div class="sub">
        <span class="sub-label">默认频道</span>
        <el-select
          :model-value="settings.defaultChannel"
          class="sub-select"
          aria-label="默认频道"
          @update:model-value="(v: any) => update('defaultChannel', v)"
        >
          <el-option v-for="c in CHANNELS" :key="c.key" :label="c.label" :value="c.key" />
        </el-select>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">图片</h3>

      <div class="row">
        <div class="row-text">
          <span class="row-label">封面加载时先显示占位色</span>
          <span class="row-desc">
            关掉之后封面区域会留一块空白直到图片到达。
            图片本身已经做了淡入过渡，关掉只影响**淡入之前**那一段的底色
          </span>
        </div>
        <el-switch
          :model-value="settings.coverBlurPlaceholder"
          aria-label="封面加载时先显示占位色"
          @update:model-value="(v: any) => update('coverBlurPlaceholder', v)"
        />
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">界面密度</h3>
      <p class="block-desc">紧凑模式在同一屏里能多看两条笔记。</p>

      <el-radio-group
        :model-value="settings.density"
        @update:model-value="(v: any) => update('density', v)"
      >
        <el-radio-button v-for="o in DENSITY_OPTIONS" :key="o.value" :value="o.value">
          {{ o.label }}
        </el-radio-button>
      </el-radio-group>
    </section>

    <section class="block">
      <h3 class="block-title">字号</h3>
      <p class="block-desc">整站字号缩放，改完立刻生效（不需要刷新）。</p>

      <el-radio-group
        :model-value="settings.fontScale"
        @update:model-value="(v: any) => update('fontScale', v)"
      >
        <el-radio-button v-for="o in FONT_OPTIONS" :key="o.value" :value="o.value">
          {{ o.label }}
        </el-radio-button>
      </el-radio-group>
    </section>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 28px;
}

.block-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 6px;
}

.block-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.7;
  margin: 0 0 14px;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.radio {
  height: auto;
  margin-right: 0;
}

.radio :deep(.el-radio__label) {
  display: flex;
  flex-direction: column;
  line-height: 1.5;
}

.radio-label {
  font-size: var(--fs-base);
  color: var(--text-1);
}

.radio-desc {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.sub {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.sub-label {
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.sub-select {
  width: 160px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 12px 0;
  border-bottom: 1px solid var(--border-soft);
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-label {
  font-size: var(--fs-base);
  color: var(--text-1);
}

.row-desc {
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.5;
}
</style>
