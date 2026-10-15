<script setup lang="ts">
/**
 * 发现页（对标小红书 explore 布局）
 *
 * 与上一版的差别：
 * - 去掉「发现」大标题 + 副标题：首页直接以频道栏起头，把纵向空间让给瀑布流
 * - 去掉第二层分类胶囊：合并成一层频道栏（居中 + 红色短下划线，对齐小红书）
 * - 内容列从 1080px 放宽到 1560px，栅格 4 列 → 6 列
 * - 卡片改成「图优先」：封面图（圆角、无边框）+ 两行标题 + 作者/点赞行
 * - 无图笔记也保留等高占位块，栅格不再参差不齐
 * - 瀑布流抽成 PostMasonry 组件，和搜索页共用
 * - 关注流：同一个页面切成 ?channel=follow（侧栏「关注」入口）
 *   关注流不显示内容频道栏 —— 订阅流按时间排，再按话题筛一遍没有意义
 */
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import { postsApi, type Post } from '@/api/posts'
import { useHomeTabsStore } from '@/stores/homeTabs'
import { useAuthStore } from '@/stores/auth'
import { useFeed } from '@/composables/useFeed'
import { useUserSettings } from '@/composables/useUserSettings'
import PostMasonry from '@/components/PostMasonry.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const homeTabs = useHomeTabsStore()
const auth = useAuthStore()
const userSettings = useUserSettings()

/** 关注流 = 发现页的 channel=follow 视图 */
const isFollowFeed = computed(() => route.query.channel === 'follow')

/**
 * 「推荐」频道走个性化推荐流，其余频道仍是时间倒序。
 *
 * 刻意不把推荐铺到所有频道上：小红书的频道是**用户主动圈定的主题**，
 * 在「美食」频道里塞一篇你收藏过的健身笔记，用户会认为频道坏了。
 * 只有「推荐」这个频道本身没有主题约束，才是画像该起作用的地方。
 */
const isRecommended = computed(() => !isFollowFeed.value && homeTabs.category === 'recommend')

/**
 * 推荐流的装饰（理由 + 不感兴趣）只在登录态出现。
 *
 * 游客也走推荐流，但那是**冷启动**：没有任何画像，
 * 每条理由只可能是「刚刚发布」或「最近很火」——
 * 同一句话在整屏重复十二遍，零信息量，只是噪声。
 * 而「不感兴趣」对游客更糟：点了会拿到 401 或者被弹去登录页，
 * 一个点下去只会把人踢走的按钮，不如不给。
 */
const showFeedMeta = computed(() => isRecommended.value && auth.isLoggedIn)

const feed = useFeed(() => homeTabs.category)

const posts = ref<Post[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const page = ref(1)
const hasMore = ref(false)

// 当前这一屏到底渲染哪一路数据。三个来源（推荐 / 关注 / 其它频道）
// 在模板里混着写 if 会让「加载态」出现三种真相，合成一个 computed 才收得住。
const visiblePosts = computed(() => (isRecommended.value ? feed.posts.value : posts.value))
const visibleLoading = computed(() => (isRecommended.value ? feed.loading.value : loading.value))
const visibleError = computed(() => (isRecommended.value ? feed.errorMsg.value : errorMsg.value))
const visibleLoadingMore = computed(() =>
  isRecommended.value ? feed.loadingMore.value : loadingMore.value
)
const visibleHasMore = computed(() => (isRecommended.value ? feed.hasMore.value : hasMore.value))

// 频道（对齐小红书首页频道栏）
const channels = [
  { key: 'recommend', label: '推荐' },
  { key: 'outfit', label: '穿搭' },
  { key: 'food', label: '美食' },
  { key: 'beauty', label: '彩妆' },
  { key: 'movie', label: '影视' },
  { key: 'workplace', label: '职场' },
  { key: 'emotion', label: '情感' },
  { key: 'home', label: '家居' },
  { key: 'game', label: '游戏' },
  { key: 'travel', label: '旅行' },
  { key: 'fitness', label: '健身' },
  { key: 'video', label: '视频' }
]

async function loadFeed(reset: boolean) {
  // 推荐流走自己的会话，不能进这条时间序的加载路径
  if (isRecommended.value) return feed.reload()

  if (reset) {
    page.value = 1
    posts.value = []
  }

  loading.value = reset
  loadingMore.value = !reset
  errorMsg.value = ''

  try {
    const data = await postsApi.getFeed({
      page: page.value,
      pageSize: 12,
      // 关注流只传 channel，不传 category：订阅流按时间排，再按话题筛没有意义
      ...(isFollowFeed.value ? { channel: 'follow' } : { category: homeTabs.category })
    })
    posts.value.push(...data.list)
    hasMore.value = data.pagination.hasMore
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function reload() {
  return loadFeed(true)
}

async function loadMore() {
  if (isRecommended.value) return feed.loadMore()
  if (loadingMore.value || !hasMore.value) return
  page.value++
  await loadFeed(false)
}

/**
 * 不感兴趣。
 *
 * 必须先拦未登录：反馈是**按用户**存进服务端的，
 * 游客点了会拿到 401 然后回滚 —— 白白闪一下，比直接引导登录差得多。
 */
function onDismiss(postId: number) {
  if (!auth.isLoggedIn) {
    ElMessage.info('登录后才能调整推荐')
    router.push({ name: 'login', query: { redirect: route.fullPath } })
    return
  }
  void feed.dismiss(postId)
}

onMounted(() => {
  /*
   * ⚠️ 两个请求**并行**，不要 await 落点处理再拉数据。
   *
   * 串行的写法（`await applyDefaultLanding(); loadFeed(true)`）看起来更清楚，
   * 但它让首屏数据**白等一次偏好请求**。偏好是从服务端拉的，
   * 弱网下那是几百毫秒到几秒 —— 用户看到的是一个空页面然后突然有内容。
   *
   * 落点逻辑本身会决定要不要重定向到关注流，而 `loadFeed` 读的是
   * `isFollowFeed`（computed），重定向发生时 Vue 会重新渲染并
   * 由 watch 触发重新加载 —— 不需要在这里等。
   */
  void applyDefaultLanding()
  loadFeed(true)
})

/**
 * 按偏好设置「打开首页时落在哪」。
 *
 * ⚠️ 两条必须守住的规则：
 *
 * ① **只在 URL 上没有 channel 时才重定向**。
 *    用户手动点过「关注」之后带着 `?channel=follow` 回来，那是他的选择，
 *    不能再被偏好覆盖 —— 否则点了关注、刷新一下又跳回推荐，他会以为坏了。
 *
 * ② **用 replace 不是 push**。
 *    push 会往历史里塞一条，用户按「后退」会退回到「同一个首页的另一个频道」，
 *    看起来像卡住了。
 *
 * ③ 关注流要求登录，未登录时按推荐处理 —— 不然会落到一个空页面。
 */
async function applyDefaultLanding() {
  if (route.query.channel) return

  const { settings, load } = userSettings
  await load()

  if (!settings.value.allowRecommendedFeed) {
    // 关掉了推荐流：能登录就落关注流，游客只能落普通频道流
    if (auth.isLoggedIn) {
      router.replace({ path: '/', query: { channel: 'follow' } })
      return
    }
  } else if (settings.value.defaultFeed === 'follow' && auth.isLoggedIn) {
    router.replace({ path: '/', query: { channel: 'follow' } })
    return
  }

  // defaultChannel 只在「推荐」这个频道之外有意义：
  // 落点本来就是推荐流时再切频道属于自相矛盾
  if (
    settings.value.defaultFeed === 'category' &&
    settings.value.defaultChannel !== 'recommend' &&
    homeTabs.category === 'recommend'
  ) {
    homeTabs.setCategory(settings.value.defaultChannel)
  }
}

// 频道切换：只影响发现流，关注流下频道栏根本不渲染
watch(
  () => homeTabs.category,
  () => {
    if (!isFollowFeed.value) loadFeed(true)
  }
)

// 发现 ⇄ 关注 切换：两边是独立的数据源，必须整页重载
watch(isFollowFeed, () => loadFeed(true))
</script>

<template>
  <div class="explore">
    <!-- 频道栏：居中 + 红色短下划线。关注流不显示（订阅流按时间排，不按话题筛） -->
    <el-tabs v-if="!isFollowFeed" v-model="homeTabs.category" class="channel-tabs">
      <el-tab-pane v-for="ch in channels" :key="ch.key" :label="ch.label" :name="ch.key" />
    </el-tabs>

    <div v-else class="follow-head">
      <h1 class="follow-title">关注</h1>
      <p class="follow-sub">你关注的人发布的新笔记</p>
    </div>

    <EmptyState
      v-if="visibleLoading && visiblePosts.length === 0"
      variant="loading"
      title="正在加载笔记..."
    />

    <EmptyState
      v-else-if="visibleError"
      variant="error"
      :title="visibleError"
      action="重试"
      @action="reload"
    />

    <template v-else>
      <!-- 关注流空态要给出下一步：没登录就登录，已登录就去发现页找人关注 -->
      <el-empty
        v-if="visiblePosts.length === 0"
        :description="
          isFollowFeed
            ? auth.isLoggedIn
              ? '你关注的人还没有发过笔记'
              : '登录后查看你关注的人的更新'
            : isRecommended
              ? '还没有可以推荐的内容'
              : '这个频道还没有内容'
        "
      >
        <el-button v-if="!isFollowFeed" type="primary" @click="router.push('/publish')">
          去发第一篇
        </el-button>
        <el-button
          v-else-if="!auth.isLoggedIn"
          type="primary"
          @click="router.push({ name: 'login', query: { redirect: route.fullPath } })"
        >
          立即登录
        </el-button>
        <el-button v-else type="primary" plain @click="router.push('/')"> 去发现页看看 </el-button>
      </el-empty>

      <!-- 推荐理由 + 不感兴趣只在登录后的推荐流出现 -->
      <PostMasonry
        v-else
        :posts="visiblePosts"
        :reasons="showFeedMeta ? feed.reasons.value : undefined"
        :dismissable="showFeedMeta"
        @dismiss="onDismiss"
      />

      <div v-if="visiblePosts.length > 0" class="pager">
        <template v-if="visibleHasMore">
          <el-button :loading="visibleLoadingMore" @click="loadMore">加载更多</el-button>
          <!-- 「换一批」必须新建会话而不是重新拉第一页 -->
          <el-button v-if="isRecommended" plain :loading="visibleLoading" @click="feed.reshuffle()">
            换一批
          </el-button>
        </template>
        <span v-else class="no-more">— 已经到底了 —</span>
      </div>

      <!-- 推荐流的解释入口：让人知道「推荐」不是随机的，也能改 -->
      <div v-if="isRecommended && visiblePosts.length > 0" class="feed-note">
        <router-link to="/interest" class="feed-note-link">这些推荐是怎么来的？</router-link>
      </div>
    </template>
  </div>
</template>

<style scoped>
.explore {
  /* 首页比内页宽：小红书 explore 在 1920 下是 6 列 */
  max-width: var(--content-max-width-wide);
  margin: 0 auto;
}

/* ===== 频道栏 ===== */
.channel-tabs :deep(.el-tabs__header) {
  display: flex;
  justify-content: center;
  margin-bottom: 22px;
}

.channel-tabs :deep(.el-tabs__nav-wrap),
.channel-tabs :deep(.el-tabs__nav-scroll) {
  display: flex;
  justify-content: center;
}

.channel-tabs :deep(.el-tabs__nav) {
  border-bottom: none;
}

.channel-tabs :deep(.el-tabs__item) {
  position: relative;
  height: 44px;
  padding: 0 4px;
  margin: 0 20px;
  font-size: var(--fs-md);
  color: var(--foreground);
  opacity: 0.62;
}

.channel-tabs :deep(.el-tabs__item:hover) {
  opacity: 0.9;
}

.channel-tabs :deep(.el-tabs__item.is-active) {
  color: var(--foreground);
  opacity: 1;
  font-weight: 600;
}

/* 官方整宽下划线换成小红书式的居中短红条 */
.channel-tabs :deep(.el-tabs__active-bar) {
  display: none;
}

.channel-tabs :deep(.el-tabs__item.is-active::after) {
  content: '';
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: 18px;
  height: 3px;
  border-radius: 2px;
  background: var(--el-color-primary);
}

/* ===== 关注流标题 ===== */
.follow-head {
  padding: 4px 0 22px;
  text-align: center;
}

.follow-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--foreground);
}

.follow-sub {
  margin: 6px 0 0;
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
}

/* ===== 分页 ===== */
.pager {
  display: flex;
  justify-content: center;
  padding: 36px 0 12px;
}

.no-more {
  color: var(--muted-foreground);
  font-size: var(--fs-sm);
}

/* ===== 推荐流的解释入口 ===== */
.feed-note {
  display: flex;
  justify-content: center;
  padding: 10px 0 30px;
}

.feed-note-link {
  color: var(--muted-foreground);
  font-size: var(--fs-sm);
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-out-expo);
}

.feed-note-link:hover {
  color: var(--accent);
}
</style>
