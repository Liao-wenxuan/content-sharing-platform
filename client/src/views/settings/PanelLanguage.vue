<script setup lang="ts">
/**
 * 多语言和翻译
 *
 * 这一栏之前是死按钮。现在它做两件**真的**事：
 *
 * ① 内容语言偏好：影响搜索和推荐流能看到什么
 * ② 浏览器翻译提示：给外文内容加一个「用浏览器翻译」的提示条
 *
 * ⚠️ 界面上**没有**「界面语言」下拉框。
 * 这个项目的界面文案全中文，做一个只有两个选项（中文 / English）
 * 而 English 根本没接的下拉框，就是另一种假按钮 ——
 * 用户切过去会发现什么都没变，那比不给更糟。
 *
 * 真要做多语言界面，正确的前置条件是：
 * ① 抽出全部文案（约 200+ 条）② 引入 i18n 运行时 ③ 逐条翻译并维护
 * 这不是「加一个下拉框」的工作量，所以这里写明现状而不是假装支持。
 */
import { computed } from 'vue'
import { useUserSettings } from '@/composables/useUserSettings'

const { settings, patch } = useUserSettings()

const LANGUAGES = [
  { code: 'zh', label: '简体中文', native: '简体中文' },
  { code: 'en', label: '英语', native: 'English' },
  { code: 'ja', label: '日语', native: '日本語' },
  { code: 'ko', label: '韩语', native: '한국어' }
] as const

/** 「内容语言」存在 blockedTags 之外的位置：用 tag 前缀约定，不新增字段 */
const contentLangs = computed(() => settings.value.blockedTags.filter((t) => t.startsWith('lang:')))

function isPicked(code: string) {
  return !contentLangs.value.includes(`lang:${code}`)
}

function toggleLang(code: string, want: boolean) {
  const marker = `lang:${code}`
  const rest = settings.value.blockedTags.filter((t) => !t.startsWith('lang:'))
  patch({
    blockedTags: want ? rest : [...rest, marker]
  })
}
</script>

<template>
  <div class="panel">
    <section class="block">
      <h3 class="block-title">界面语言</h3>
      <div class="current">
        <span class="current-label">当前</span>
        <span class="current-value">简体中文</span>
      </div>
      <p class="block-desc">
        这个项目的界面文案目前只有中文。
        <b>没有做界面语言切换</b>，因为那需要先抽出全部文案、引入 i18n 运行时、 再逐条翻译并长期维护
        —— 不是「加一个下拉框」的工作量。 放一个只有中文的选项在这里，或者放两个选项但切了没反应，
        都是另一种形式的假按钮。
      </p>
    </section>

    <section class="block">
      <h3 class="block-title">内容语言</h3>
      <p class="block-desc">
        用来决定搜索和推荐流里优先给你看哪种语言的内容。
        取消勾选某个语言不会删掉已有的笔记，只是不再优先推给你。
      </p>

      <div class="langs">
        <label v-for="l in LANGUAGES" :key="l.code" class="lang">
          <el-checkbox
            :model-value="isPicked(l.code)"
            @update:model-value="(v: any) => toggleLang(l.code, v)"
          />
          <span class="lang-native">{{ l.native }}</span>
          <span class="lang-label">{{ l.label }}</span>
        </label>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">浏览器翻译</h3>
      <div class="row">
        <div class="row-text">
          <span class="row-label">外文内容显示翻译提示条</span>
          <span class="row-desc">
            提示里给一个「用浏览器翻译」的链接。翻译本身由浏览器完成，我们不接翻译服务。
          </span>
        </div>
        <el-switch
          :model-value="settings.browserTranslateHint"
          @update:model-value="(v: any) => patch({ browserTranslateHint: v })"
        />
      </div>
      <p class="note">
        这样做的原因：接一个翻译 API 意味着要把你的内容发给第三方 ——
        那是隐私设置里的重大决定，不能默认开启。 交给浏览器则由用户自己决定要不要触发。
      </p>
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
  line-height: 1.8;
  margin: 0 0 14px;
}

.block-desc b {
  color: var(--text-1);
  font-weight: 600;
}

.current {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
}

.current-label {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.current-value {
  font-size: var(--fs-base);
  color: var(--text-1);
}

.langs {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lang {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.lang-native {
  font-size: var(--fs-base);
  color: var(--text-1);
}

.lang-label {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 12px 0;
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
  line-height: 1.6;
}

.note {
  margin: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.7;
}
</style>
