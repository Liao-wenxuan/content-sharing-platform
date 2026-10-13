<script setup lang="ts">
/**
 * 内容偏好：屏蔽的话题 + 关于多语言的现状说明
 *
 * 这一栏之前是死按钮。现在做两件**真的**事：
 * ① 屏蔽话题的管理 —— 这个筛选真的在 PostMasonry 里执行
 * ② 说明「为什么没有界面语言切换」和「为什么没有翻译开关」
 *
 * ⚠️ 界面上**没有**「界面语言」下拉框，也没有「自动翻译」开关。
 * 两者都是「切了但什么都不变」的选项：
 *
 * - 界面全中文，做一个只有中文（和没接的 English）的下拉框，
 *   用户切过去会发现什么都没变
 * - 项目零外文内容，做一个翻译开关没有任何东西可翻译
 *
 * 真要做多语言界面，正确的前置条件是：
 * ① 抽出全部文案（约 200+ 条）② 引入 i18n 运行时 ③ 逐条翻译并维护
 * 这不是「加一个下拉框」的工作量，所以这里写明现状而不是假装支持。
 *
 * **诚实地说「没做」比勉强地说「做了」有用。**
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useUserSettings } from '@/composables/useUserSettings'

const { settings, patch } = useUserSettings()

/** 输入框。新增屏蔽词时用 */
const tagInput = ref('')

/** 真正生效的屏蔽词 —— 排除掉历史上用 lang: 前缀存的标记 */
const plainTags = computed(() =>
  settings.value.blockedTags.filter((t) => t && !t.startsWith('lang:'))
)

function addTag() {
  const tag = tagInput.value.trim()
  if (!tag) return
  if (tag.length > 20) {
    ElMessage.error('话题名不能超过 20 个字')
    return
  }
  if (plainTags.value.some((t) => t.toLowerCase() === tag.toLowerCase())) {
    ElMessage.info('这个话题已经在屏蔽列表里了')
    tagInput.value = ''
    return
  }
  // 顺带清掉历史的 lang: 标记 —— 它们不生效，留着只会让人以为「内容语言」这个设置有用
  patch({ blockedTags: [...plainTags.value, tag] })
  tagInput.value = ''
}

function removeTag(tag: string) {
  patch({ blockedTags: plainTags.value.filter((t) => t !== tag) })
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
      <h3 class="block-title">屏蔽的话题</h3>
      <p class="block-desc">
        被屏蔽的话题不会出现在首页、搜索结果和你的推荐流里。 这个筛选在「分列之前」执行 ——
        先过滤再排版， 否则瀑布流会按「其实没渲染的卡片」算列高，底部会留一大块空白。
      </p>

      <el-input
        v-model="tagInput"
        placeholder="输入话题名，回车添加"
        class="tag-input"
        :disabled="tagInput.length >= 20"
        @keyup.enter="addTag"
      />

      <div
        v-if="settings.blockedTags.filter((t) => !t.startsWith('lang:')).length > 0"
        class="chips"
      >
        <el-tag
          v-for="tag in plainTags"
          :key="tag"
          closable
          size="small"
          effect="plain"
          @close="removeTag(tag)"
        >
          {{ tag }}
        </el-tag>
      </div>
      <p v-else class="empty-hint">还没有屏蔽任何话题。</p>
    </section>

    <section class="block">
      <h3 class="block-title">浏览器翻译</h3>
      <p class="block-desc">
        <b>这个项目现在没有接翻译功能。</b>
        界面和内容都是中文，没有需要翻译的外文，所以也不做「翻译开关」——
        那会是一个切了但什么都不变的选项。
      </p>
      <p class="note">
        如果将来接入，正确的做法是<b>交给浏览器</b>而不是自建翻译服务： 接一个翻译 API
        意味着把你的内容发给第三方， 那是隐私设置里的重大决定，不能默认开启。
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
