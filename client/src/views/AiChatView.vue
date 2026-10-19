<script setup lang="ts">
/**
 * 站内 AI 对话页。
 *
 * 三件事决定了这个页面的样子：
 *
 * 1. **来源先于答案**。服务端先推 sources 再推 delta，所以引用卡片
 *    在答案还在打字的时候就已经在了 —— 答案不是没有出处的断言。
 *
 * 2. **三类来源分开**。笔记 / 话题 / 用户是三种东西，塞在一起看很乱，
 *    而且能点回的地方不一样（笔记详情 / 话题页 / 个人主页）。
 *
 * 3. **打字效果是真的流式**。不是把整段文字用 CSS 逐字显示 ——
 *    那是假流式；这里是每收到一段 delta 就追加一次。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MagicStick, Position } from '@element-plus/icons-vue'
import { streamAiChat, type AiSources } from '../api/ai'

type SourceTab = 'post' | 'topic' | 'user'

interface Turn {
  id: number
  role: 'user' | 'assistant'
  text: string
  sources?: AiSources
  streaming?: boolean
}

const route = useRoute()
const router = useRouter()

const turns = ref<Turn[]>([])
const question = ref('')
const busy = ref(false)
const sourceTab = ref<SourceTab>('post')
const listRef = ref<HTMLElement | null>(null)

let abort: AbortController | null = null
let seq = 0

async function scrollToBottom() {
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function ask(raw: string) {
  const text = raw.trim()
  if (!text || busy.value) return

  question.value = ''
  const userTurn: Turn = { id: ++seq, role: 'user', text }
  const botTurn: Turn = { id: ++seq, role: 'assistant', text: '', streaming: true }
  turns.value.push(userTurn, botTurn)
  busy.value = true
  sourceTab.value = 'post'
  await scrollToBottom()

  abort = new AbortController()
  await streamAiChat(
    text,
    {
      onSources: (s) => {
        botTurn.sources = s
        void scrollToBottom()
      },
      onDelta: (t) => {
        botTurn.text += t
        void scrollToBottom()
      },
      onDone: () => {
        botTurn.streaming = false
        busy.value = false
        void scrollToBottom()
      },
      onError: (m) => {
        botTurn.text = m
        botTurn.streaming = false
        busy.value = false
      }
    },
    abort.signal
  )
}

/** 换一组问题：清空当前对话，把新的问题塞进地址栏（这样刷新能复现） */
function restart() {
  abort?.abort()
  abort = null
  turns.value = []
  busy.value = false
  const q = String(route.query.q ?? '')
  if (q) void ask(q)
}

function goPost(id: number) {
  router.push(`/post/${id}`)
}
function goTopic(tag: string) {
  router.push(`/topic/${encodeURIComponent(tag)}`)
}
function goUser(id: number) {
  router.push(`/profile/${id}`)
}

function formatDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : value.slice(0, 10)
}

/**
 * 页面「准备好了」的信号。
 *
 * 为什么需要它：a11y 审计扫页面时统一只等 700ms，
 * 而这个页面的答案是**流式**吐出来的 —— 700ms 之后可能还在打字，
 * 扫到的是半成品（动画中的对比度、还没渲染完的来源）。
 *
 * 所以页面自己报状态，审计脚本等这个属性变成 true 再扫。
 * 这比「让审计脚本猜该等多久」可靠得多。
 */
const ready = computed(() => turns.value.some((t) => t.role === 'assistant' && !t.streaming))

onMounted(() => {
  const q = String(route.query.q ?? '')
  if (q) void ask(q)
})

onBeforeUnmount(() => {
  abort?.abort()
})
</script>

<template>
  <div class="ai-view" :data-ai-ready="ready ? 'true' : 'false'">
    <header class="page-header">
      <h1 class="page-title">站内 AI</h1>
      <p class="page-subtitle">只答站内有的，每条结论都能点回原帖核对</p>
    </header>

    <div ref="listRef" class="turn-list" role="log" aria-live="polite">
      <!-- 空态 -->
      <div v-if="turns.length === 0" class="ai-empty">
        <el-icon class="ai-empty-icon"><component :is="MagicStick" /></el-icon>
        <p class="ai-empty-title">想了解些什么？</p>
        <p class="ai-empty-hint">
          问点站内的内容，比如「通勤穿搭怎么搭」「低卡快手菜」。<br />
          答案只来自站内真实笔记，找不到就会直说没有。
        </p>
      </div>

      <div v-for="turn in turns" :key="turn.id" class="turn">
        <!-- 用户的问题 -->
        <div v-if="turn.role === 'user'" class="turn-user">
          <div class="bubble-user">{{ turn.text }}</div>
        </div>

        <!-- 机器人的回答 -->
        <div v-else class="turn-bot">
          <div class="bot-head">
            <el-icon class="bot-icon"><component :is="MagicStick" /></el-icon>
            <span class="bot-name">站内助手</span>
            <span v-if="turn.streaming" class="bot-typing">正在检索…</span>
          </div>

          <div class="bot-text" :class="{ typing: turn.streaming }">{{ turn.text }}</div>

          <!-- 来源 -->
          <div v-if="turn.sources" class="sources">
            <div class="sources-head">
              <span class="sources-title">来源</span>
              <div class="sources-tabs">
                <button
                  type="button"
                  class="tab-btn"
                  :class="{ active: sourceTab === 'post' }"
                  @click="sourceTab = 'post'"
                >
                  笔记 {{ turn.sources.posts.length }}
                </button>
                <button
                  type="button"
                  class="tab-btn"
                  :class="{ active: sourceTab === 'topic' }"
                  @click="sourceTab = 'topic'"
                >
                  话题 {{ turn.sources.topics.length }}
                </button>
                <button
                  type="button"
                  class="tab-btn"
                  :class="{ active: sourceTab === 'user' }"
                  @click="sourceTab = 'user'"
                >
                  用户 {{ turn.sources.users.length }}
                </button>
              </div>
            </div>

            <!-- 笔记 -->
            <ul v-if="sourceTab === 'post'" class="source-list">
              <li v-for="(p, i) in turn.sources.posts" :key="p.id" class="source-item">
                <button type="button" class="source-btn" @click="goPost(p.id)">
                  <span class="source-ref">[{{ i + 1 }}]</span>
                  <span class="source-body">
                    <span class="source-text">{{ p.content }}</span>
                    <span class="source-meta">
                      @{{ p.authorNickname }}
                      <template v-if="p.topicTag"> · #{{ p.topicTag }}</template>
                      · {{ formatDate(p.createdAt) }} · {{ p.likeCount }} 赞 /
                      {{ p.commentCount }} 评论
                    </span>
                  </span>
                  <el-icon class="source-arrow"><component :is="Position" /></el-icon>
                </button>
              </li>
              <li v-if="turn.sources.posts.length === 0" class="source-empty">
                这次没检索到相关笔记
              </li>
            </ul>

            <!-- 话题 -->
            <ul v-else-if="sourceTab === 'topic'" class="source-list">
              <li v-for="t in turn.sources.topics" :key="t.name" class="source-item">
                <button type="button" class="source-btn" @click="goTopic(t.name)">
                  <span class="source-ref">#</span>
                  <span class="source-body">
                    <span class="source-text">{{ t.name }}</span>
                    <span class="source-meta">{{ t.postCount }} 条笔记 · {{ t.likeCount }} 赞</span>
                  </span>
                  <el-icon class="source-arrow"><component :is="Position" /></el-icon>
                </button>
              </li>
              <li v-if="turn.sources.topics.length === 0" class="source-empty">没有相关话题</li>
            </ul>

            <!-- 用户 -->
            <ul v-else class="source-list">
              <li v-for="u in turn.sources.users" :key="u.id" class="source-item">
                <button type="button" class="source-btn" @click="goUser(u.id)">
                  <el-avatar :size="28" :src="u.avatar || undefined">
                    {{ u.nickname.slice(0, 1) }}
                  </el-avatar>
                  <span class="source-body">
                    <span class="source-text">{{ u.nickname }}</span>
                    <span class="source-meta"
                      >{{ u.postCount }} 条相关笔记 · {{ u.likeCount }} 赞</span
                    >
                  </span>
                  <el-icon class="source-arrow"><component :is="Position" /></el-icon>
                </button>
              </li>
              <li v-if="turn.sources.users.length === 0" class="source-empty">没有相关作者</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- 提问框 -->
    <div class="composer">
      <el-input
        v-model="question"
        class="composer-input"
        placeholder="接着问，或者换个问题"
        :prefix-icon="MagicStick"
        :disabled="busy"
        @keyup.enter="ask(question)"
      />
      <el-button
        type="primary"
        class="composer-send"
        :loading="busy"
        :disabled="!question.trim()"
        @click="ask(question)"
      >
        问
      </el-button>
      <el-button v-if="turns.length" link class="composer-restart" @click="restart">
        重新开始
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.ai-view {
  max-width: var(--content-max-width);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - var(--sp-10));
}

.page-header {
  margin-bottom: var(--sp-4);
}

.page-title {
  margin: 0;
  font-size: var(--fs-display);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-1);
}

.page-subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-base);
  color: var(--text-2);
}

.turn-list {
  flex: 1;
  overflow-y: auto;
  padding-bottom: var(--sp-4);
}

/* ===== 空态 ===== */
.ai-empty {
  text-align: center;
  padding: 10vh 24px 6vh;
}

.ai-empty-icon {
  font-size: 32px;
  color: var(--text-3);
}

.ai-empty-title {
  margin: var(--sp-4) 0 var(--sp-2);
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--text-1);
}

.ai-empty-hint {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.8;
  color: var(--text-3);
}

/* ===== 对话 ===== */
.turn {
  margin-bottom: var(--sp-5);
}

.turn-user {
  display: flex;
  justify-content: flex-end;
}

.bubble-user {
  max-width: 620px;
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  font-size: var(--fs-base);
  line-height: 1.6;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}

.turn-bot {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  padding: var(--sp-4);
  background: var(--surface-1);
}

.bot-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.bot-icon {
  color: var(--accent);
  font-size: var(--fs-md);
}

.bot-name {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-1);
}

.bot-typing {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.bot-text {
  font-size: var(--fs-base);
  line-height: 1.75;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 打字中：最后一行有一个微弱的光标 */
.bot-text.typing::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: caret 1s steps(2, start) infinite;
}

@keyframes caret {
  50% {
    opacity: 0;
  }
}

/* ===== 来源 ===== */
.sources {
  margin-top: var(--sp-4);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border-soft);
}

.sources-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}

.sources-title {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.sources-tabs {
  display: flex;
  gap: var(--sp-2);
}

.tab-btn {
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: var(--fs-xs);
  padding: 2px 10px;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out-expo),
    border-color var(--dur-fast) var(--ease-out-expo);
}

.tab-btn:hover {
  color: var(--text-1);
}

.tab-btn.active {
  color: var(--accent);
  border-color: var(--accent);
}

.tab-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.source-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

/*
 * <li> 只提供列表语义，真正可点、可聚焦的是里面的 <button>。
 * 之前点击挂在 <li> 上 —— 键盘用户根本够不到这些来源卡片
 * （a11y 静态检查报的就是这个）。
 */
.source-item {
  list-style: none;
}

.source-btn {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out-expo);
}

.source-btn:hover {
  background: var(--surface-2);
}

.source-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.source-ref {
  font-size: var(--fs-xs);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.source-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.source-text {
  font-size: var(--fs-sm);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.source-meta {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.source-arrow {
  color: var(--text-3);
  font-size: var(--fs-sm);
  flex-shrink: 0;
}

.source-empty {
  font-size: var(--fs-xs);
  color: var(--text-3);
  padding: var(--sp-2) 0;
}

/* ===== 提问框 ===== */
.composer {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) 0;
  background: var(--background);
  border-top: 1px solid var(--border-soft);
}

.composer-input {
  flex: 1;
}

.composer-send {
  flex-shrink: 0;
}

.composer-restart {
  flex-shrink: 0;
  font-size: var(--fs-xs);
}
</style>
