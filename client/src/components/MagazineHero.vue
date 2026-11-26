<script setup lang="ts">
/**
 * 杂志报头 + 封面故事 + 本期精选（2026-11-25 方向 A「主编精选」）
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

/** 封面故事：feed 第一条有图的笔记（纯文字帖当封面没有视觉冲击） */
const hero = computed(() => props.posts.find((p) => p.imageUrls?.length) ?? null)
/** 本期精选：封面之后的三条 */
const picks = computed(() => {
  // 只取有图的：无图帖当精选会变成破图 alt 文字（线上视频帖就没有 imageUrls）
  const withCover = props.posts.filter((p) => p.imageUrls?.length)
  if (!hero.value) return withCover.slice(0, 3)
  return withCover.filter((p) => p.id !== hero.value!.id).slice(0, 3)
})

/**
 * 封面轮播：封面故事 + 本期精选 = 4 张，左右切换，文字跟着图走。
 * slides 必须由 hero + picks 派生，不另存一份数据 —— 换频道/换一批后
 * feed 变了，轮播内容自动跟着变，不会出现「图和文字对不上」。
 */
const active = ref(0)
const paused = ref(false)
const reducedMotion = ref(false)
const slides = computed(() => (hero.value ? [hero.value, ...picks.value] : []))
const current = computed(() => slides.value[active.value] ?? hero.value)

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

/** 点精选卡：先让轮播跳到对应那张，再进详情 */
function openPick(post: Post, index: number) {
  goTo(index + 1)
  open(post)
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
  <header v-if="hero" class="mag">
    <!-- 刊头 -->
    <div class="masthead">
      <div class="brand">拾<small>A LIFE JOURNAL</small></div>
      <div class="issue">
        生活提案 · 第 <b>{{ issueNo }}</b> 期<br />
        {{ today }} · {{ channelLabel || '为你推荐' }}
      </div>
    </div>

    <!-- 封面故事轮播：4 张图轮着上，右侧文字跟着切 -->
    <section
      class="cover-story"
      tabindex="0"
      :aria-label="`封面故事轮播，第 ${active + 1} / ${slides.length} 张`"
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
        <div v-if="slides.length > 1" class="dots" role="tablist" aria-label="封面故事切换">
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
        <div class="kicker">封面故事 · {{ current.topicTag || '生活' }}</div>
        <h1>{{ split(current).title }}</h1>
        <p class="lead">{{ split(current).excerpt }}</p>
        <!-- 署名用杂志的「文 / 某某」，不出现点赞数——那是社区硬符号，会破功 -->
        <div class="byline">文 / {{ current.author?.nickname || '社区用户' }}</div>
      </div>
    </section>

    <!-- 本期精选 -->
    <section v-if="picks.length" class="picks">
      <div class="section-head"><b>本期精选</b></div>
      <div class="pick-grid">
        <article v-for="(p, i) in picks" :key="p.id" class="pick">
          <div class="pick-num">0{{ i + 1 }}</div>
          <button
            type="button"
            class="pick-figure"
            :aria-label="`阅读：${split(p).title}`"
            @click="openPick(p, i)"
          >
            <img :src="cover(p)" :alt="split(p).title" />
          </button>
          <div class="pick-meta">
            <span>{{ p.topicTag || '生活' }}</span>
            <span
              >{{ new Date(p.createdAt).getMonth() + 1 }}月{{
                new Date(p.createdAt).getDate()
              }}日</span
            >
          </div>
          <h3>{{ split(p).title }}</h3>
          <div class="pick-by">文 / {{ p.author?.nickname || '社区用户' }}</div>
        </article>
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

/* ===== 刊头 ===== */
.masthead {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 22px 4px 14px;
  border-bottom: 3px double var(--mag-ink);
}
.brand {
  font-family: var(--mag-serif);
  font-size: 52px;
  line-height: 1;
  letter-spacing: -2px;
  color: var(--red);
}
.brand small {
  display: block;
  font-family: var(--mag-serif);
  font-size: 11px;
  letter-spacing: 4px;
  margin-top: 8px;
  color: var(--mag-sub);
}
.issue {
  font-family: var(--mag-serif);
  font-size: 12px;
  color: var(--mag-sub);
  text-align: right;
  line-height: 1.7;
}
.issue b {
  color: var(--red);
  font-size: 15px;
}

/* ===== 封面故事 ===== */
.cover-story {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  /* 加大图文间距，接近杂志跨页的呼吸感 */
  gap: 68px;
  align-items: center;
  padding: 30px 4px;
}
.cover-figure,
.pick-figure {
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
.cover-figure img,
.pick-figure img {
  /* scoped 下必须显式写全：全局 img 规则穿不进来，
     object-fit 掉回 fill 会把 320x480 的竖图拉进横框，左右留灰边 */
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition: transform 0.4s var(--ease-out-expo, ease);
}
.cover-figure:hover img,
.pick-figure:hover img {
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

/* ===== 本期精选 ===== */
.section-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 4px 20px;
}
.section-head b {
  font-family: var(--mag-serif);
  font-size: 24px;
  color: var(--mag-ink);
}
.section-head::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}
.pick-grid {
  display: grid;
  /* minmax(0,1fr) 而不是裸 1fr：1fr 的最小尺寸是 auto，
     卡片里的长标题/作者行会把列撑到内容宽度，第三张直接跑出屏幕。
     实测撑到 480px/列（应为 375px），溢出 292px。 */
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 26px;
  min-width: 0;
}
.pick {
  position: relative;
  min-width: 0;
  border-top: 2px solid var(--mag-ink);
  padding-top: 22px;
}
.pick-num {
  position: absolute;
  top: 6px;
  right: 0;
  font-family: var(--mag-serif);
  font-size: 14px;
  color: var(--red);
}
.pick-figure {
  height: 210px;
  border-radius: var(--radius-sm);
  margin-bottom: 14px;
}
.pick-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--red);
  letter-spacing: 1px;
  margin-bottom: 9px;
}
.pick h3 {
  font-family: var(--mag-serif);
  font-size: 20px;
  line-height: 1.4;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pick-by {
  font-size: 11px;
  color: var(--mag-sub);
}

/* 深色主题：辅助文字提亮一档，避免「大标题很亮、期号发灰」的层次混乱；
   刊头双线用中描边，纯白在深底上太抢。 */
:global(.dark) .masthead {
  border-bottom-color: var(--border-strong);
}
:global(.dark) .issue,
:global(.dark) .brand small,
:global(.dark) .pick-by {
  color: var(--text-1);
  opacity: 0.82;
}
:global(.dark) .kicker,
:global(.dark) .pick-meta {
  color: var(--accent);
  opacity: 1;
}
/* 深色下近黑的封面图加一圈浅描边，避免融进背景 */
:global(.dark) .pick-figure {
  outline: 1px solid var(--border-soft);
}

/* 窄屏：封面故事改竖排，精选两列 */
@media (max-width: 900px) {
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
  .pick-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }
}
</style>
