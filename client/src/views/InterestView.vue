<script setup lang="ts">
/**
 * 我的兴趣画像
 *
 * 这一页存在的理由不是「展示数据」，而是**让推荐可以被纠正**。
 * 推荐流里每条内容都写着「为什么推给你」，但理由再清楚，
 * 用户也改不了任何东西 —— 那和黑盒没区别。
 *
 * 所以这里给三件事：
 * 1. 你关心什么（话题 / 作者的权重条）
 * 2. 系统从你身上看到了什么行为信号（各行为的条数）
 * 3. 你屏蔽过什么，并且**可以撤销**
 *
 * 第 3 条最关键：屏蔽是单向操作时，用户会越用越窄且不敢回来。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { feedApi, type InterestProfile } from '@/api/feed'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()

const profile = ref<InterestProfile | null>(null)
const loading = ref(false)
const errorMsg = ref('')
/** 正在撤销屏蔽的笔记 id，用来单独禁用那一条的按钮 */
const clearing = ref<number | null>(null)

/** 权重条的长度按最大值归一，而不是按绝对刻度 */
const topicMax = computed(() => Math.max(1, ...(profile.value?.topics ?? []).map((t) => t.weight)))
const authorMax = computed(() =>
  Math.max(1, ...(profile.value?.authors ?? []).map((a) => a.weight))
)

/** 行为信号的展示名和解释。顺序 = 从强到弱，和打分表一致 */
const SIGNALS: { key: keyof InterestProfile['signalCounts']; label: string; hint: string }[] = [
  { key: 'favorite', label: '收藏', hint: '权重最高：收藏是主动想留下' },
  { key: 'comment', label: '评论', hint: '要打字，是很强的表达欲' },
  { key: 'follow', label: '关注', hint: '一次性决定，比点赞更明确' },
  { key: 'like', label: '点赞', hint: '可能只是顺手' },
  { key: 'view', label: '浏览', hint: '被动信号，权重最低' }
]

const signalMax = computed(() =>
  Math.max(1, ...SIGNALS.map((s) => profile.value?.signalCounts[s.key] ?? 0))
)

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    profile.value = await feedApi.profile()
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '画像加载失败'
  } finally {
    loading.value = false
  }
}

/** 撤销屏蔽。成功后本地直接改掉，不必重拉整页 —— 整页重拉会让权重条闪一下 */
async function unmute(postId: number) {
  clearing.value = postId
  try {
    await feedApi.clearFeedback(postId)
    if (profile.value) {
      profile.value = {
        ...profile.value,
        muted: profile.value.muted.filter((m) => m.postId !== postId),
        mutedCount: Math.max(0, profile.value.mutedCount - 1)
      }
    }
    ElMessage.success('已取消屏蔽，之后会重新推荐')
  } catch {
    ElMessage.error('操作失败，请重试')
  } finally {
    clearing.value = null
  }
}

onMounted(() => {
  // 未登录时后端会返回 isGuest 的空画像。这里不跳登录页 ——
  // 「游客看什么」本身也是个答案（冷启动只按新鲜度和热度排），
  // 跳走就变成「不登录什么都不给看」，反而更不诚实。
  void load()
})
</script>

<template>
  <div class="interest">
    <header class="page-header">
      <h1 class="page-title">我的兴趣画像</h1>
      <p class="page-subtitle">推荐流按这里的权重排序。屏蔽过的内容也会列在下面，可以随时撤销。</p>
    </header>

    <EmptyState v-if="loading" variant="loading" title="正在算画像..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="load"
    />

    <template v-else-if="profile">
      <!-- 游客：明确说清楚「为什么你现在看不到任何画像」 -->
      <el-card v-if="profile.isGuest" class="block">
        <div class="guest">
          <p class="guest-title">登录后才能形成兴趣画像</p>
          <p class="guest-sub">现在看到的是「冷启动排序」：只看新鲜度和热度，不带任何个人偏好。</p>
          <el-button
            type="primary"
            @click="router.push({ name: 'login', query: { redirect: '/interest' } })"
          >
            去登录
          </el-button>
        </div>
      </el-card>

      <template v-else>
        <!-- 1. 你关心什么 -->
        <el-card class="block">
          <template #header>
            <div class="card-head">
              <span>你常看的话题</span>
              <span class="card-hint">条形长度 = 相对权重，不是占比</span>
            </div>
          </template>

          <div v-if="profile.topics.length === 0" class="empty-line">
            还没有足够的行为。多逛逛、点几个赞，这里就会有内容。
          </div>
          <ul v-else class="bars">
            <li v-for="t in profile.topics" :key="t.tag" class="bar-row">
              <span class="bar-label"># {{ t.tag }}</span>
              <span class="bar-track">
                <span class="bar-fill" :style="{ width: `${(t.weight / topicMax) * 100}%` }" />
              </span>
              <span class="bar-value">{{ t.weight }}</span>
            </li>
          </ul>
        </el-card>

        <el-card class="block">
          <template #header>
            <div class="card-head">
              <span>你常看的作者</span>
              <span class="card-hint">共关注 {{ profile.followedCount }} 位</span>
            </div>
          </template>

          <div v-if="profile.authors.length === 0" class="empty-line">还没有形成作者偏好。</div>
          <ul v-else class="bars">
            <li v-for="a in profile.authors" :key="a.authorId" class="bar-row">
              <router-link :to="`/profile/${a.authorId}`" class="bar-label author">
                {{ a.nickname }}
              </router-link>
              <span class="bar-track">
                <span class="bar-fill" :style="{ width: `${(a.weight / authorMax) * 100}%` }" />
              </span>
              <span class="bar-value">{{ a.weight }}</span>
            </li>
          </ul>
        </el-card>

        <!-- 2. 系统看到了什么信号 -->
        <el-card class="block">
          <template #header>
            <div class="card-head">
              <span>系统看到的你的行为</span>
              <span class="card-hint">行为越强，对排序的影响越大</span>
            </div>
          </template>

          <ul class="bars">
            <li v-for="s in SIGNALS" :key="s.key" class="bar-row">
              <span class="bar-label">{{ s.label }}</span>
              <span class="bar-track">
                <span
                  class="bar-fill"
                  :style="{ width: `${((profile.signalCounts[s.key] ?? 0) / signalMax) * 100}%` }"
                />
              </span>
              <span class="bar-value">{{ profile.signalCounts[s.key] ?? 0 }}</span>
              <span class="bar-hint">{{ s.hint }}</span>
            </li>
          </ul>
        </el-card>

        <!-- 3. 屏蔽管理：唯一能改变推荐的操作，必须显眼且可撤销 -->
        <el-card class="block">
          <template #header>
            <div class="card-head">
              <span>已屏蔽</span>
              <span class="card-hint">
                {{ profile.mutedCount }} 篇笔记 · {{ profile.mutedAuthorCount }} 位作者
              </span>
            </div>
          </template>

          <div v-if="profile.muted.length === 0" class="empty-line">
            还没有屏蔽任何内容。在推荐流里点卡片右上角的 × 就能屏蔽。
          </div>
          <ul v-else class="muted-list">
            <li v-for="m in profile.muted" :key="m.postId" class="muted-row">
              <div class="muted-info">
                <router-link :to="`/post/${m.postId}`" class="muted-title">
                  {{ m.topicTag ? `# ${m.topicTag}` : '未分类' }}
                </router-link>
                <span class="muted-author">{{ m.authorNickname }}</span>
              </div>
              <el-button
                size="small"
                plain
                :loading="clearing === m.postId"
                @click="unmute(m.postId)"
              >
                取消屏蔽
              </el-button>
            </li>
          </ul>
        </el-card>

        <p class="foot-note">
          画像是每次打开推荐流时按你的实时行为现算的，没有存第二份数据 ——
          所以你刚点完赞，下一次推荐就已经变了。
        </p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.interest {
  max-width: 860px;
  margin: 0 auto;
}

.page-header {
  padding: 4px 0 20px;
}

.page-title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  color: var(--foreground);
}

.page-subtitle {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--muted-foreground);
}

.block {
  margin-bottom: 16px;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
}

.card-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted-foreground);
}

.empty-line {
  padding: 10px 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

/* ===== 权重条 ===== */
.bars {
  margin: 0;
  padding: 0;
  list-style: none;
}

.bar-row {
  display: grid;
  grid-template-columns: 96px 1fr 52px;
  align-items: center;
  gap: 12px;
  padding: 7px 0;
}

.bar-label {
  font-size: 14px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

a.bar-label.author {
  color: var(--foreground);
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-out-expo);
}

a.bar-label.author:hover {
  color: var(--accent);
}

.bar-track {
  height: 8px;
  border-radius: 999px;
  background: var(--muted);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width var(--dur-standard) var(--ease-out-expo);
}

.bar-value {
  font-size: 13px;
  color: var(--muted-foreground);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bar-hint {
  grid-column: 2 / -1;
  font-size: 12px;
  color: var(--muted-foreground);
  opacity: 0.75;
}

/* ===== 屏蔽列表 ===== */
.muted-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.muted-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-color, var(--muted));
}

.muted-row:last-child {
  border-bottom: none;
}

.muted-info {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.muted-title {
  color: var(--foreground);
  font-size: 14px;
  text-decoration: none;
}

.muted-title:hover {
  color: var(--accent);
}

.muted-author {
  font-size: 13px;
  color: var(--muted-foreground);
}

/* ===== 游客态 ===== */
.guest {
  padding: 8px 0;
}

.guest-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--foreground);
}

.guest-sub {
  margin: 8px 0 16px;
  font-size: 14px;
  color: var(--muted-foreground);
}

.foot-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted-foreground);
  opacity: 0.8;
}
</style>
