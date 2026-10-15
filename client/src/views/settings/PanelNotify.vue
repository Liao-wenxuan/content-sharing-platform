<script setup lang="ts">
/**
 * 通知设置
 *
 * 这一栏接的是**已经存在但没入口**的能力：
 * `GET/PUT /api/notifications/preferences` 早就实现了，
 * 之前只能从消息页里的偏好入口进，设置页上却是一个死按钮。
 *
 * ⚠️ 与「通用设置」不同，这里的保存是**立刻发请求**的，
 * 不走 useUserSettings 的防抖 —— 因为它用的是另一个后端接口
 * （notify_prefs 那一列），两套存储不能混。
 * 而且通知偏好只有三个开关，防抖带来的收益很小，
 * 但「点了没反应」的风险是实打实的。
 */
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { notificationsApi, type NotifyPrefs, type NotifyCategory } from '@/api/notifications'

const prefs = ref<NotifyPrefs>({ likes: true, follows: true, mentions: true })
const loading = ref(true)
const savingKey = ref<string | null>(null)
const errorMsg = ref('')

const GROUPS: { key: NotifyCategory; label: string; desc: string; detail: string }[] = [
  {
    key: 'likes',
    label: '赞和收藏',
    desc: '别人给你的笔记点赞或收藏',
    detail: '关掉之后这类通知不再生成，已经存在的通知仍然留在列表里。'
  },
  {
    key: 'follows',
    label: '新增关注',
    desc: '有人关注了你',
    detail: '通常这是最想看到的一类，建议保持开启。'
  },
  {
    key: 'mentions',
    label: '评论和 @',
    desc: '有人评论你的笔记，或在评论里提到你',
    detail: '@ 提及只匹配评论正文里的 @昵称。'
  }
]

onMounted(async () => {
  try {
    const res = await notificationsApi.preferences()
    prefs.value = res.prefs
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.message || '读取通知偏好失败'
  } finally {
    loading.value = false
  }
})

async function toggle(key: NotifyCategory, value: boolean) {
  const previous = prefs.value[key]
  // 先改本地再发请求：开关的反馈必须是立刻的，
  // 等往返 200ms 才动会让用户以为没点上，很可能再点一次
  prefs.value = { ...prefs.value, [key]: value }
  savingKey.value = key

  try {
    const res = await notificationsApi.savePreferences({ [key]: value })
    // 用服务端回传的覆盖：它可能顺手修正了别的字段
    prefs.value = res.prefs
  } catch (e: any) {
    // 失败必须回滚到原值 —— 界面显示「已关闭」但没存上，
    // 用户刷新后会看到它变回开启，然后开始怀疑这个开关坏了
    prefs.value = { ...prefs.value, [key]: previous }
    ElMessage.error(e?.response?.data?.message || '保存失败，请重试')
  } finally {
    savingKey.value = null
  }
}
</script>

<template>
  <div class="panel">
    <el-alert v-if="errorMsg" type="error" :title="errorMsg" :closable="false" show-icon />

    <div v-loading="loading" class="list">
      <div v-for="g in GROUPS" :key="g.key" class="row">
        <div class="row-text">
          <span class="row-label">{{ g.label }}</span>
          <span class="row-desc">{{ g.desc }}</span>
          <span class="row-detail">{{ g.detail }}</span>
        </div>
        <el-switch
          :model-value="prefs[g.key]"
          :loading="savingKey === g.key"
          :aria-label="g.label"
          @update:model-value="(v: any) => toggle(g.key, v)"
        />
      </div>
    </div>

    <p class="foot-note">
      这里改的是「之后还生不生成」。已经收到的通知不会因为关掉开关而消失 ——
      它们是你已经收到的事实，删掉才是篡改记录。
    </p>
  </div>
</template>

<style scoped>
.list {
  min-height: 120px;
}

.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 14px 0;
  border-bottom: 1px solid var(--border-soft);
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.row-label {
  font-size: var(--fs-base);
  color: var(--text-1);
  font-weight: 500;
}

.row-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.row-detail {
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.6;
}

.foot-note {
  margin: 18px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.7;
}
</style>
