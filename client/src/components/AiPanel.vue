<script setup lang="ts">
/**
 * 站内 AI 的展开面板（懒加载）。
 *
 * 形态照着内容社区常见的做法：点开是「想了解些什么」，
 * 底下两张快捷卡片（按你的兴趣 / 一个防口嗨的固定问法）。
 *
 * 为什么做成**居中遮罩**而不是挂在顶栏下面：
 * 顶栏已经有搜索建议面板了，两个面板叠在一起会互相打架 ——
 * 一个从输入框下方展开，一个从屏幕中间展开，视觉上不知道该看哪个。
 * 而且 AI 面板的内容比搜索建议多得多，需要更大的空间。
 *
 * 快捷问题是**懒加载**的：第一次打开才拉。
 * 顶栏是每个页面都在的东西，不该为了一个没人点开的入口多打一个请求。
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { MagicStick, Close } from '@element-plus/icons-vue'
import { fetchAiSuggest, type AiSuggestGroup } from '../api/ai'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'ask', question: string): void
}>()

const question = ref('')
const groups = ref<AiSuggestGroup[]>([])
const loading = ref(false)
const loaded = ref(false)
const inputRef = ref<{ focus: () => void } | null>(null)

/**
 * 面板自己的显隐状态。
 *
 * 为什么不让父组件直接 v-if 卸载：那样退场动画就没了 ——
 * 点 × 关闭时面板会「啪」一下消失。
 * 所以这里 v-if 的是 visible，动画播完才通知父组件卸载。
 */
const visible = ref(false)

onMounted(async () => {
  // 先等一帧再显示：初始就是 true 的话 transition 不会触发（没有前后状态差）
  await nextTick()
  visible.value = true
  await nextTick()
  inputRef.value?.focus()
  if (loaded.value) return
  loading.value = true
  try {
    groups.value = await fetchAiSuggest()
    loaded.value = true
  } catch {
    // 拉不到就当没有快捷问题 —— 这个面板不打开也能正常提问，
    // 不值得为它弹一个错误框
  } finally {
    loading.value = false
  }
})

function close() {
  visible.value = false
  // 退场动画播完再让父组件卸载
  setTimeout(() => emit('close'), 200)
}

/** 提问：把问题抛给入口，由它带着问题走路由 */
function ask(text?: string) {
  const q = (text ?? question.value).trim()
  if (!q) return
  emit('ask', q)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="ai-fade">
      <div v-if="visible" class="ai-overlay">
        <div class="ai-panel" role="dialog" aria-label="站内 AI 问答">
          <!--
            关闭靠这个显式按钮 + ESC，不靠「点遮罩空白处」。
            遮罩点击是鼠标便利，但它是**唯一**的键盘用户摸不到的出口 ——
            而它长得最像能点的样子，比缺一个按钮更糟。
          -->
          <button type="button" class="ai-close" aria-label="关闭" @click="close">
            <el-icon><Close /></el-icon>
          </button>
          <h2 class="ai-title">想了解些什么？</h2>

          <div class="ai-input-row">
            <el-input
              ref="inputRef"
              v-model="question"
              class="ai-input"
              placeholder="用你自己的话问站内的事"
              :prefix-icon="MagicStick"
              clearable
              @keyup.enter="ask()"
            />
            <el-button type="primary" class="ai-send" @click="ask()">问</el-button>
          </div>

          <p class="ai-hint">回答只来自站内真实笔记，每条都会标出处。</p>

          <div v-if="loading" class="ai-loading">正在准备推荐问题…</div>

          <div v-else class="ai-groups">
            <section v-for="g in groups" :key="g.id" class="ai-group">
              <div class="ai-group-title">{{ g.title }}</div>
              <div class="ai-group-desc">{{ g.desc }}</div>
              <button
                v-for="q in g.questions"
                :key="q.id"
                type="button"
                class="ai-question"
                @click="ask(q.text)"
              >
                {{ q.text }}
              </button>
            </section>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 24px 24px;
  background: rgb(0 0 0 / 55%);
}

.ai-panel {
  position: relative;
  width: 100%;
  max-width: 680px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-6);
}

.ai-close {
  position: absolute;
  top: var(--sp-3);
  right: var(--sp-3);
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out-expo);
}

.ai-close:hover {
  color: var(--text-1);
}

.ai-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.ai-title {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-1);
}

.ai-input-row {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
}

.ai-input {
  flex: 1;
}

.ai-send {
  flex-shrink: 0;
}

.ai-hint {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.ai-loading {
  margin-top: var(--sp-5);
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.ai-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--sp-4);
  margin-top: var(--sp-5);
}

.ai-group {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  padding: var(--sp-4);
}

.ai-group-title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-1);
}

.ai-group-desc {
  margin-top: 2px;
  margin-bottom: var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}

.ai-question {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1.6;
  padding: 4px 0;
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out-expo);
}

.ai-question:hover {
  color: var(--accent);
}

.ai-question:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

/* 面板是「出现」和「消失」两件事：进场慢一点看清，收起快一点不拖沓 */
.ai-fade-enter-active,
.ai-fade-leave-active {
  transition: opacity var(--dur-base) var(--ease-out-expo);
}

.ai-fade-enter-active .ai-panel,
.ai-fade-leave-active .ai-panel {
  transition: transform var(--dur-base) var(--ease-out-expo);
}

.ai-fade-enter-from,
.ai-fade-leave-to {
  opacity: 0;
}

.ai-fade-enter-from .ai-panel,
.ai-fade-leave-to .ai-panel {
  transform: translateY(-8px);
}
</style>
