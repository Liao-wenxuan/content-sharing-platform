<script setup lang="ts">
/**
 * 外观与主题
 *
 * 设置页原来只有一个「深色模式」开关 —— 二态，且和顶栏按钮一样
 * 只写 localStorage，刷新后会被偏好层按回去。服务端 `themeMode`
 * 明明有 'system' 这一档，界面上却没有任何地方能选它。
 *
 * 这里把三档都摆出来，全部走 useTheme.setMode() 同一条链：
 * 立即生效 → 写 localStorage → 通知偏好层存进账号。
 *
 * 用原生 radio 而不是 el-radio：三档各自带一块配色预览和两行说明，
 * 套进 EP 的 label 结构要连写三层 :deep() 才能摆平，
 * 而原生 input+label 天然有正确的分组语义、键盘操作和读屏播报。
 */
import { computed } from 'vue'
import { useTheme, type ThemeMode } from '@/composables/useTheme'

const { mode, isDark, systemDark, setMode } = useTheme()

const OPTIONS: { value: ThemeMode; label: string; desc: string }[] = [
  { value: 'system', label: '跟随系统', desc: '随设备的外观设置自动切换' },
  { value: 'dark', label: '深色', desc: '低亮度环境更省眼' },
  { value: 'light', label: '浅色', desc: '白天和强光下更清晰' }
]

const current = computed(() => {
  const resolved = isDark.value ? '深色' : '浅色'
  if (mode.value === 'system') return `跟随系统 · 当前是${resolved}`
  return `${resolved}（手动选择）`
})

function pick(next: ThemeMode) {
  setMode(next)
}
</script>

<template>
  <div class="panel">
    <section class="block">
      <h3 class="block-title">主题模式</h3>
      <p class="block-desc">选完立刻生效，不用刷新，也不会影响你已发布的内容。</p>

      <fieldset class="mode-list">
        <legend class="sr-only">主题模式</legend>
        <label
          v-for="o in OPTIONS"
          :key="o.value"
          class="mode-option"
          :class="{ 'is-active': mode === o.value }"
        >
          <input
            class="sr-only"
            type="radio"
            name="theme-mode"
            :value="o.value"
            :checked="mode === o.value"
            @change="pick(o.value)"
          />
          <span class="mode-preview" :class="`is-${o.value}`" aria-hidden="true">
            <i class="line"></i><i class="line short"></i>
          </span>
          <span class="mode-text">
            <span class="mode-label">{{ o.label }}</span>
            <span class="mode-desc">{{ o.desc }}</span>
          </span>
          <span class="mode-check" aria-hidden="true">✓</span>
        </label>
      </fieldset>

      <p class="current" aria-live="polite">当前：{{ current }}</p>
      <p v-if="mode === 'system'" class="system-note">
        系统当前偏好为「{{ systemDark ? '深色' : '浅色' }}」。改设备的外观设置，这里会跟着变。
      </p>
    </section>

    <section class="block">
      <h3 class="block-title">保存在哪</h3>
      <ul class="notes">
        <li>登录后，这项偏好会跟着账号走，换设备也一致。</li>
        <li>游客只保存在这台设备上，清理浏览器数据后会回到默认深色。</li>
        <li>顶栏的月亮 / 太阳图标是这里的快捷切换，两边永远是同一个值。</li>
      </ul>
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
  margin: 0 0 16px;
}

/* 视觉隐藏，但不能 display:none —— 那样 radio 就退出 tab 顺序和读屏树了 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.mode-list {
  border: 0;
  padding: 0;
  margin: 0;
}

.mode-option {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo);
}

.mode-option:hover {
  background: var(--surface-2);
}

.mode-option.is-active {
  border-color: var(--accent);
  background: var(--surface-2);
}

/* 键盘聚焦时给整行一个可见焦点，而不是那个 1px 的隐藏 radio */
.mode-option:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 预览用固定色：它要表示的是「深色长什么样」，不能随当前主题一起变，
   否则在深色设置页里三块预览会变成同一个颜色 */
.mode-preview {
  position: relative;
  width: 68px;
  height: 46px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  padding: 10px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}

.mode-preview.is-dark {
  background: #1b1b1e;
}

.mode-preview.is-light {
  background: #faf9f7;
}

.mode-preview.is-system {
  background: linear-gradient(90deg, #1b1b1e 0 50%, #faf9f7 50% 100%);
}

.mode-preview .line {
  display: block;
  height: 4px;
  width: 100%;
  border-radius: 2px;
  background: rgb(128 128 128 / 45%);
}

.mode-preview .line.short {
  width: 62%;
}

.mode-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mode-label {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-1);
}

.mode-desc {
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.5;
}

.mode-check {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--accent);
  font-weight: 700;
  visibility: hidden;
}

.mode-option.is-active .mode-check {
  visibility: visible;
}

.current {
  margin: 4px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.system-note {
  margin: 8px 0 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-2);
}

.notes {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-sm);
  line-height: 1.9;
  color: var(--text-2);
}
</style>
