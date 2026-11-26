<script setup lang="ts">
/**
 * 杂志报头 + 推荐轮播（2026-11-26 改：删掉本期精选静态卡，
 * 页面只保留「轮播推荐 + 下面正常内容卡」两种风格）
 *
 * 只在「推荐」频道使用。穿搭 / 美食 / 彩妆 / 影视等主题频道一律平铺内容卡，
 * 不套轮播 —— 频道是用户主动圈的主题，进来看的是「全」，不是「精选」。
 *
 * 为什么单独成组件：
 *   HomeView 已经管了三路 feed（推荐 / 关注 / 频道）+ 分页 + 空态，
 *   再把杂志骨架塞进去会撑爆。这里只做「首屏视觉锤」这一件事，
 *   数据由 HomeView 从真实 feed 传进来，不自己请求、不造数据。
 *
 * 内容全部来自真实笔记：封面取第一条，精选取接下来三条。
 * 点任意一张都跳真实详情页 —— 不是静态 demo 的假链接。
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import type { Post } from '@/api/posts'

const props = defineProps<{
  posts: Post[]
  /** 当前频道名，显示在报头的「本期主题」 */
  channelLabel?: string
}>()

const router = useRouter()

/**
 * 推荐轮播：feed 前 4 条有图的笔记，左右切换，文字跟着图走。
 * 2026-11-26 按用户要求改成「只有轮播推荐 + 下面正常内容卡」两种风格，
 * 删掉了原来和轮播内容重复的「本期精选」静态卡区。
 *
 * slides 从 posts 实时派生，不另存一份数据 —— 换频道/换一批后自动跟着变。
 * 只取有图的：无图帖当封面会变成破图 alt 文字（线上视频帖就没有 imageUrls）。
 */
const slides = computed(() => props.posts.filter((p) => p.imageUrls?.length).slice(0, 4))
/** 当前展示的那张；列表为空时退化成 undefined，模板用 v-if 挡住 */
const current = computed(() => slides.value[active.value] ?? slides.value[0])
const active = ref(0)
const paused = ref(false)
const reducedMotion = ref(false)

/** 换频道后 slides 变短，把越界的 index 拉回来 */
watch(slides, (list) => {
  if (active.value >= list.length) active.value = 0
})
function go(delta: number) {
  if (slides.value.length < 2) return
  active.value = (active.value + delta + slides.value.length) % slides.value.length
}
function goTo(i: number) {
  if (i >= 0 && i < slides.value.length) active.value = i
}

let timer: ReturnType<typeof setInterval> | null = null
function stopAuto() {
  if (timer) clearInterval(timer)
  timer = null
}
function startAuto() {
  stopAuto()
  if (reducedMotion.value || slides.value.length < 2) return
  timer = setInterval(() => {
    if (!paused.value && !document.hidden) go(1)
  }, 5000)
}
onMounted(() => {
  // matchMedia 在真实浏览器里一定有；jsdom/老环境没有时退化为「不减少动效」，
  // 不能因此抛错把整个组件树带崩（HomeView 的测试就栽在这）。
  reducedMotion.value =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  startAuto()
})
onBeforeUnmount(stopAuto)

/** 键盘左右键：轮播区获得焦点时才响应，不抢全局方向键 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    go(-1)
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    go(1)
  }
}

/** 标题取第一行，正文取剩下的（真实笔记是「标题\n\n正文」结构） */
function split(post: Post) {
  const parts = String(post.content || '').split('\n')
  return { title: parts[0].trim(), excerpt: parts.slice(1).join(' ').trim().slice(0, 90) }
}

function open(post: Post) {
  router.push(`/post/${post.id}`)
}

/** 期号：用當天在一年中的第几周，稳定不需要后端 */
const issueNo = computed(() => {
  const now = new Date()
  const start = new Date(now.getFullYear(), 0, 1)
  return String(
    Math.ceil(((now.getTime() - start.getTime()) / 86400000 + start.getDay()) / 7)
  ).padStart(2, '0')
})
const today = computed(() => {
  const d = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${week}`
})

function cover(post: Post) {
  return post.imageThumbs?.[0] || post.imageUrls?.[0] || ''
}
</script>

<template>
  <header v-if="slides.length" class="mag">
    <!-- 刊头：压成单行（品牌 + 期号/日期），高度约 110px → 50px，
         把首屏空间让给轮播图，而不是一片空白 -->
    <div class="masthead">
      <div class="brand">拾<small>A LIFE JOURNAL</small></div>
      <div class="issue">
        第 <b>{{ issueNo }}</b> 期 · <span class="date">{{ today }} · </span
        >{{ channelLabel || '为你推荐' }}
      </div>
    </div>

    <!-- 推荐轮播：4 张图轮着上，右侧文字跟着切 -->
    <section
      class="cover-story"
      tabindex="0"
      :aria-label="`推荐轮播，第 ${active + 1} / ${slides.length} 张`"
      @mouseenter="paused = true"
      @mouseleave="paused = false"
      @focusin="paused = true"
      @focusout="paused = false"
      @keydown="onKeydown"
    >
      <div class="cover-stage">
        <button
          type="button"
          class="cover-figure"
          :aria-label="`阅读：${split(current).title}`"
          @click="open(current)"
        >
          <!-- key 绑 post.id：切换时强制重建 img，过渡动画才有「换页」感 -->
          <img :key="current.id" :src="cover(current)" :alt="split(current).title" />
        </button>

        <!-- 左右箭头：细线圆钮，hover 才实化，不抢图的视觉权重 -->
        <template v-if="slides.length > 1">
          <button type="button" class="nav-arrow nav-prev" aria-label="上一张" @click="go(-1)">
            <span aria-hidden="true">‹</span>
          </button>
          <button type="button" class="nav-arrow nav-next" aria-label="下一张" @click="go(1)">
            <span aria-hidden="true">›</span>
          </button>
        </template>

        <!-- 指示条：杂志目录感的小横条，不是圆点 -->
        <div v-if="slides.length > 1" class="dots" role="tablist" aria-label="推荐内容切换">
          <button
            v-for="(_, i) in slides"
            :key="i"
            type="button"
            role="tab"
            class="dot"
            :class="{ 'is-active': i === active }"
            :aria-label="`第 ${i + 1} 张：${split(slides[i]).title}`"
            :aria-selected="i === active"
            @click="goTo(i)"
          />
        </div>
      </div>

      <div class="cover-copy" :key="current.id">
        <div class="kicker">本期推荐 · {{ current.topicTag || '生活' }}</div>
        <h1>{{ split(current).title }}</h1>
        <p class="lead">{{ split(current).excerpt }}</p>
        <!-- 署名用杂志的「文 / 某某」，不出现点赞数——那是社区硬符号，会破功 -->
        <div class="byline">文 / {{ current.author?.nickname || '社区用户' }}</div>
      </div>
    </section>
  </header>
</template>

<style scoped>
/* 字体：杂志的骨架靠衬线标题立住，正文仍用系统无衬线保证可读 */
.mag {
  --mag-serif: Georgia, 'Songti SC', 'Noto Serif CJK SC', serif;
  --mag-paper: var(--background);
  --mag-ink: var(--foreground);
  --mag-sub: var(--text-2);
  --red: var(--accent);
  --line: var(--border);
  margin-bottom: 34px;
}

/* ===== 刊头 =====
 * 单行紧凑版：品牌与期号/日期同一行，上下留白收到最小。
 * 原来 52px 品牌 + 两行期号 + 36px 上下 padding = 110px 高，
 * 首屏最贵的一屏被一块「只有 logo 和日期」的空白吃掉，
 * 用户反馈「这一部分高度太高」。现在约 50px，杂志感还在，地方让给轮播。
 */
.masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 4px 10px;
  border-bottom: 3px double var(--mag-ink);
}
.brand {
  font-family: var(--mag-serif);
  font-size: 34px;
  line-height: 1;
  letter-spacing: -1px;
  color: var(--red);
  flex-shrink: 0;
}
.brand small {
  display: inline;
  font-family: var(--mag-serif);
  font-size: 10px;
  letter-spacing: 2px;
  margin-left: 10px;
  color: var(--mag-sub);
}
.issue {
  font-family: var(--mag-serif);
  font-size: 12px;
  color: var(--mag-sub);
  text-align: right;
  line-height: 1.5;
  white-space: nowrap;
}
.issue b {
  color: var(--red);
  font-size: 13px;
}

/* ===== 推荐轮播 ===== */
.cover-story {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  /* 加大图文间距，接近杂志跨页的呼吸感 */
  gap: 68px;
  align-items: center;
  padding: 30px 4px;
}
.cover-figure {
  display: block;
  width: 100%;
  padding: 0;
  border: none;
  background: var(--surface-2);
  cursor: pointer;
  overflow: hidden;
}
/* 轮播舞台：图 + 箭头 + 指示条共用定位祖先 */
.cover-stage {
  position: relative;
  min-width: 0;
}
.cover-figure {
  height: 430px;
  /* 印刷跨页感：封面图收成小圆角，接近纸的直角 */
  border-radius: 3px;
}

/* 切换淡入：只动 opacity，不碰 layout。reduced-motion 下由全局兜底关掉 */
.cover-figure img,
.cover-copy {
  animation: mag-fade 0.45s var(--ease-out-expo, ease);
}
@keyframes mag-fade {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 细线箭头：静止态留 0.35 透明度当「这里能切」的信号，
   hover 图区才实化 —— 完全隐藏的话首次访问的用户根本不知道能滑 */
.nav-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.28);
  color: #fff;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.35;
  transition:
    opacity 0.2s ease,
    background-color 0.2s ease;
}
.cover-stage:hover .nav-arrow,
.nav-arrow:focus-visible {
  opacity: 1;
}
.nav-arrow:hover {
  background: rgba(0, 0, 0, 0.5);
}
.nav-prev {
  left: 14px;
}
.nav-next {
  right: 14px;
}

/* 指示条：小横条，激活态变砖红并加宽 —— 杂志目录感 */
.dots {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 14px;
  display: flex;
  justify-content: center;
  gap: 7px;
}
.dot {
  width: 16px;
  height: 3px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.45);
  cursor: pointer;
  transition:
    width 0.25s var(--ease-out-expo, ease),
    background-color 0.2s ease;
}
.dot.is-active {
  width: 28px;
  background: var(--red);
}
.cover-figure img {
  /* scoped 下必须显式写全：全局 img 规则穿不进来，
     object-fit 掉回 fill 会把 320x480 的竖图拉进横框，左右留灰边 */
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition: transform 0.4s var(--ease-out-expo, ease);
}
.cover-figure:hover img {
  transform: scale(1.04);
}
.kicker {
  font-family: var(--mag-serif);
  font-size: 12px;
  letter-spacing: 3px;
  color: var(--red);
  margin-bottom: 16px;
}
.cover-copy h1 {
  font-family: var(--mag-serif);
  font-size: 40px;
  line-height: 1.3;
  letter-spacing: -1px;
  margin-bottom: 18px;
}
.lead {
  font-size: 15px;
  line-height: 1.85;
  color: var(--mag-ink);
  opacity: 0.78;
  margin-bottom: 22px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.byline {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--mag-sub);
  border-top: 1px solid var(--line);
  padding-top: 14px;
}
/* 杂志署名：衬线小字横排，没有头像胶囊、没有点赞数 */
.byline {
  font-family: var(--mag-serif);
  font-size: 13px;
  letter-spacing: 1px;
  color: var(--mag-ink);
  opacity: 0.72;
}

/* 深色主题：辅助文字提亮一档，避免「大标题很亮、期号发灰」的层次混乱；
   刊头双线用中描边，纯白在深底上太抢。 */
:global(.dark) .masthead {
  border-bottom-color: var(--border-strong);
}
:global(.dark) .issue,
:global(.dark) .brand small {
  color: var(--text-1);
  opacity: 0.82;
}
:global(.dark) .kicker {
  color: var(--accent);
  opacity: 1;
}

/* 窄屏：推荐轮播改竖排 */
@media (max-width: 900px) {
  /* 刊头再收一档：期号一行放不下就换行，不能顶出横向滚动 */
  .masthead {
    gap: 10px;
    padding: 0 4px 8px;
  }
  .brand {
    font-size: 26px;
  }
  .brand small {
    font-size: 8px;
    letter-spacing: 1.5px;
    margin-left: 6px;
  }
  .issue {
    font-size: 10px;
    white-space: normal;
    max-width: 62%;
  }
  /* 窄屏放不下「期号 + 完整日期 + 频道」，日期让位：
     保留期号和频道名，一行读完，报头才收得住 */
  .issue .date {
    display: none;
  }
  .cover-story {
    grid-template-columns: 1fr;
    gap: 20px;
    padding: 22px 4px;
  }
  .cover-figure {
    height: 260px;
  }
  /* 触屏没有 hover，箭头常驻 */
  .nav-arrow {
    opacity: 0.85;
    width: 34px;
    height: 34px;
    font-size: 22px;
  }
  .cover-copy h1 {
    font-size: 30px;
  }
}
</style>
