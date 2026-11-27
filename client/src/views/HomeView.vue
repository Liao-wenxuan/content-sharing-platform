<script setup lang="ts">
/**
 * 发现页（2026-11-25 方向 A「主编精选」杂志骨架）
 *
 * 首屏结构：4 图推荐轮播 → 完整内容卡片流（**仅「推荐」频道**）。
 * 轮播由 MagazineHero 组件从真实 feed 数据生成（不造数据），
 * 后面仍是原样无限浏览的瀑布流 —— 轮播是首屏视觉锤，不替代 feed。
 * 顶部只保留「顶栏 + 频道栏」两层，不再单独加杂志报头。
 *
 * 其余频道（穿搭 / 美食 / 彩妆 / 影视 …）不套轮播：它们是用户自己圈定的
 * 主题，进频道就是要「一屏平铺看全」，再压一个占半屏的封面故事只会
 * 把内容挤到折叠线以下。频道页统一平铺，也和彩妆 / 影视现有的样子一致。
 *
 * 保留的全部交互：频道切换、推荐流（换一批/不感兴趣）、关注流、
 * 分页加载更多、空态与错误态。关注流不显示杂志骨架（订阅流按时间排，
 * 给它套「编辑推荐」等于把时间序伪装成编辑挑选，语义就乱了）。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from '@/utils/element'
import { useRoute, useRouter } from 'vue-router'
import { postsApi, type Post } from '@/api/posts'
import { useHomeTabsStore } from '@/stores/homeTabs'
import { useAuthStore } from '@/stores/auth'
import { useFeed } from '@/composables/useFeed'
import { useUserSettings } from '@/composables/useUserSettings'
import PostMasonry from '@/components/PostMasonry.vue'
import MagazineHero from '@/components/MagazineHero.vue'
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

/**
 * 轮播推荐占用的笔记（有图帖的前 4 条）。
 * 瀑布流必须跳过这几条，否则首屏一滚就看到同一篇笔记出现两次。
 * 取法必须和 MagazineHero 内部的 slides 一致：有图帖前 4 条。
 *
 * 只有「推荐」频道套轮播骨架（见下方模板注释），其余频道一律平铺，
 * 所以也只有推荐频道需要让位，别的频道少让 4 条否则会凭空丢笔记。
 */
const magazineIds = computed(() => {
  if (!isRecommended.value) return new Set<number>()
  // 和 MagazineHero.slides 完全一致：只取有图的，否则会显示破图
  const list = visiblePosts.value.filter((p) => p.imageUrls?.length)
  const hero = list[0]
  if (!hero) return new Set<number>()
  const used = list.slice(0, 4)
  return new Set(used.map((p) => p.id))
})
/** 瀑布流主体：剔掉杂志已展示的笔记 */
const masonryPosts = computed(() => visiblePosts.value.filter((p) => !magazineIds.value.has(p.id)))

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

/** 内容少的频道到底后推荐的相邻频道，取当前频道之外的前 4 个 */
const suggestChannels = computed(() =>
  channels.filter((c) => c.key !== homeTabs.category && c.key !== 'video').slice(0, 4)
)

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
      pageSize: 30,
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
    <!-- 频道栏：居中 + 强调色短下划线。关注流不显示（订阅流按时间排，不按话题筛） -->
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

      <template v-else>
        <!--
          轮播只给「推荐」：这是推荐位的视觉锤。
          穿搭 / 美食 / 彩妆 / 影视等频道直接平铺内容卡，不套轮播
          （频道是用户主动圈的主题，进来看的是「全」，不是「精选」）。
        -->
        <MagazineHero v-if="isRecommended" :posts="visiblePosts" />

        <!-- 推荐理由 + 不感兴趣只在登录后的推荐流出现 -->
        <PostMasonry
          :posts="masonryPosts"
          :reasons="showFeedMeta ? feed.reasons.value : undefined"
          :dismissable="showFeedMeta"
          :uniform-ratio="6"
          :max-cols="3"
          :editorial="true"
          @dismiss="onDismiss"
        />
      </template>

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

      <!--
        主题频道内容少时（彩妆 2 条 / 影视 2 条），一屏就到底，下面大片空白。
        给几个别的频道入口，把「没内容了」变成「换个地方看看」。
        推荐流/关注流不显示：它们有自己的「换一批」和关注引导。
      -->
      <div
        v-if="!isFollowFeed && !isRecommended && visiblePosts.length > 0 && !visibleHasMore"
        class="channel-suggest"
      >
        <p class="suggest-label">这个频道看完了，试试别的</p>
        <div class="suggest-links">
          <button
            v-for="ch in suggestChannels"
            :key="ch.key"
            type="button"
            class="suggest-chip"
            @click="homeTabs.setCategory(ch.key)"
          >
            {{ ch.label }}
          </button>
        </div>
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
/*
 * 这里**不能**把 nav-wrap / nav-scroll 改成 flex 居中。
 * Element Plus 靠这两个容器做横向滚动：频道有 12 个，nav 实测 952px，
 * 390px 视口下靠 ‹ › 箭头翻页。改成 flex:center 后整个 nav 被居中，
 * 选中的第一项「推荐」被推到 -261px，而 scrollLeft 仍是 0 ——
 * 用户既看不到自己在哪个频道，也滚不回去（窄屏下等于「分类栏是坏的」）。
 * 只有宽屏（nav 放得下）才需要居中，且只作用在 header 上。
 */
.channel-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

@media (min-width: 1100px) {
  .channel-tabs :deep(.el-tabs__header) {
    display: flex;
    justify-content: center;
  }
}

.channel-tabs :deep(.el-tabs__nav) {
  border-bottom: none;
}

/*
 * 频道项改成「导航胶囊」：选中态给一张极淡的强调底面 + 强调色短下划线。
 * 用 color 分层级而不是 opacity —— 后者会把底面一起淡化，选中态的面就立不起来。
 * 只改 item 自身，不动 nav-wrap / nav-scroll 的横向滚动结构。
 */
.channel-tabs :deep(.el-tabs__item) {
  position: relative;
  height: 38px;
  line-height: 38px;
  padding: 0 16px;
  margin: 0 6px;
  border-radius: var(--radius-full);
  font-size: var(--fs-base);
  color: var(--text-2);
  transition:
    color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo);
}

/*
 * Element Plus 对 tab 列表里「第一个 .el-tabs__item」单独清掉了 padding-left
 * （内部选择器优先级高于通用的 .el-tabs__item）。注意 active-bar 不是 tab，
 * 所以 :first-child 匹配不到它，必须用 id 精准命中这个首 tab。
 * 结果：推荐胶囊左边贴字、右边留白 16px，文字中心比胶囊中心左偏 8px，
 * 短绿线（left:50% 按胶囊居中）跟着歪。补回左 padding 让文字真正在胶囊居中。
 */
.channel-tabs :deep(#tab-recommend) {
  padding-left: 16px;
}

.channel-tabs :deep(.el-tabs__item:hover) {
  color: var(--foreground);
}

.channel-tabs :deep(.el-tabs__item.is-active) {
  color: var(--foreground);
  font-weight: 600;
  background: var(--channel-active-bg);
}

/* 官方整宽下划线换成居中短条，颜色走 --el-color-primary（即强调色） */
.channel-tabs :deep(.el-tabs__active-bar) {
  display: none;
}

.channel-tabs :deep(.el-tabs__item.is-active::after) {
  content: '';
  position: absolute;
  bottom: 5px;
  left: 50%;
  transform: translateX(-50%);
  width: 16px;
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

/* ===== 频道到底后的引导 ===== */
.channel-suggest {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 8px 0 40px;
}
.suggest-label {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
}
.suggest-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
.suggest-chip {
  padding: 7px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--surface-1);
  color: var(--text-1);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    color var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}
.suggest-chip:hover,
.suggest-chip:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  transform: translateY(-2px);
}
</style>
