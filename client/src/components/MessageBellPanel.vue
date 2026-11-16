<script setup lang="ts">
/**
 * 顶栏铃铛的下拉预览面板。
 *
 * 为什么要有它：原来铃铛的 click 只是 router.push('/messages')，
 * 人已经站在 /messages 上时这是一次「重复导航」，Vue Router 会静默忽略 ——
 * 肉眼看就是「点了没反应」。消息页本身又是空的，更像坏了。
 *
 * 下拉面板把「点铃铛」变成任何页面都有可见反馈的动作：
 * 不管当前在哪，都能立刻看到最近通知、未读私信，并且有地方可去。
 * 数据只在面板展开时拉，不影响首屏，也不碰 useNotifications 的单例列表
 * （消息页切分类会改那份 list，两边共用会互相串味）。
 */
import { NOTIFY_TEXT, type NotificationItem } from '@/api/notifications'
import { useRelativeTime } from '@/composables/useRelativeTime'

defineProps<{
  items: NotificationItem[]
  loading: boolean
  /** 拉取失败：不能显示「还没有新消息」——那是撒谎，用户会以为真没人互动 */
  error: boolean
  notifyUnread: number
  chatUnread: number
}>()

const emit = defineEmits<{
  (e: 'open-item', item: NotificationItem): void
  (e: 'mark-read'): void
  (e: 'open-all'): void
  (e: 'open-chat'): void
}>()

const { formatTime } = useRelativeTime()

function initial(name?: string) {
  return name?.[0]?.toUpperCase() || '?'
}
</script>

<template>
  <div class="bell-panel">
    <header class="bell-head">
      <span class="bell-title">消息</span>
      <button v-if="notifyUnread > 0" type="button" class="bell-read" @click="emit('mark-read')">
        全部已读
      </button>
    </header>

    <div class="bell-summary">
      <span
        ><b>{{ notifyUnread }}</b> 条未读通知</span
      >
      <span
        ><b>{{ chatUnread }}</b> 条未读私信</span
      >
    </div>

    <div v-if="loading && !items.length" class="bell-state">加载中…</div>

    <!-- 拉失败 ≠ 没有消息。说清楚是网络问题，并把「去消息页」留在下面 -->
    <div v-else-if="error && !items.length" class="bell-state bell-empty">
      <p>消息暂时加载不出来</p>
      <span>可能是网络慢了，点下面的「查看全部消息」再试一次</span>
    </div>

    <ul v-else-if="items.length" class="bell-list">
      <li v-for="item in items" :key="item.id">
        <button
          type="button"
          class="bell-item"
          :class="{ unread: !item.read }"
          @click="emit('open-item', item)"
        >
          <span class="bell-avatar" aria-hidden="true">
            <img v-if="item.actor.avatar" :src="item.actor.avatar" alt="" />
            <template v-else>{{ initial(item.actor.nickname) }}</template>
          </span>
          <span class="bell-item-body">
            <span class="bell-item-text">
              <b>{{ item.actor.nickname }}</b> {{ NOTIFY_TEXT[item.type] }}
              <span v-if="item.content">：{{ item.content }}</span>
            </span>
            <span class="bell-item-time">{{ formatTime(item.createdAt) }}</span>
          </span>
          <span class="bell-dot" :class="{ on: !item.read }" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <div v-else class="bell-state bell-empty">
      <p>还没有新消息</p>
      <span>有人赞你、关注你或给你发私信时会出现在这里</span>
    </div>

    <footer class="bell-foot">
      <button type="button" class="bell-foot-main" @click="emit('open-all')">查看全部消息</button>
      <button type="button" @click="emit('open-chat')">
        去聊天<span v-if="chatUnread > 0">（{{ chatUnread }}）</span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.bell-panel {
  width: 320px;
  max-width: calc(100vw - 32px);
  font-family: inherit;
  color: var(--foreground);
}

.bell-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.bell-title {
  font-size: var(--fs-md);
  font-weight: 700;
}

.bell-read {
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: var(--accent);
  font-family: inherit;
  font-size: var(--fs-xs);
  cursor: pointer;
}

.bell-read:hover {
  text-decoration: underline;
}

.bell-summary {
  display: flex;
  gap: 16px;
  padding: 10px 0 8px;
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
}

.bell-summary b {
  margin-right: 2px;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.bell-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 300px;
  overflow-y: auto;
}

.bell-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 9px 4px;
  border: none;
  border-top: 1px solid var(--border);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.bell-item:hover {
  background: var(--surface-2);
}

.bell-avatar {
  flex: 0 0 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: var(--fs-xs);
  font-weight: 700;
}

.bell-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bell-item-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.bell-item-text {
  font-size: var(--fs-sm);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.bell-item-text b {
  font-weight: 600;
}

.bell-item-time {
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
}

.bell-dot {
  flex: 0 0 7px;
  width: 7px;
  height: 7px;
  margin-top: 10px;
  border-radius: var(--radius-full);
  background: transparent;
}

.bell-dot.on {
  background: var(--accent);
}

.bell-state {
  padding: 18px 4px;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
}

.bell-empty p {
  margin: 0 0 6px;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--foreground);
}

.bell-empty span {
  font-size: var(--fs-xs);
}

.bell-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.bell-foot button {
  padding: 5px 8px;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  font-family: inherit;
  font-size: var(--fs-xs);
  cursor: pointer;
}

.bell-foot button:hover {
  color: var(--accent);
}

.bell-foot .bell-foot-main {
  color: var(--accent);
  font-weight: 600;
}
</style>
