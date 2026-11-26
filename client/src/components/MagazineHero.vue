<script setup lang="ts">
/**
 * 推荐轮播（2026-11-26 改：删掉本期精选静态卡与杂志报头，
 * 首页顶部只留「顶栏 + 频道栏」两层，轮播直接作为内容第一屏）
 *
 * 只在「推荐」频道使用。穿搭 / 美食 / 彩妆 / 影视等主题频道一律平铺内容卡，
 * 不套轮播 —— 频道是用户主动圈的主题，进来看的是「全」，不是「精选」。
 *
 * 为什么单独成组件：
 *   HomeView 已经管了三路 feed（推荐 / 关注 / 频道）+ 分页 + 空态，
 *   再把轮播塞进去会撑爆。这里只做「首屏视觉锤」这一件事，
 *   数据由 HomeView 从真实 feed 传进来，不自己请求、不造数据。
 *
 * 内容全部来自真实笔记：取前 4 条有图的。
 * 点任意一张都跳真实详情页 —— 不是静态 demo 的假链接。
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import type { Post } from '@/api/posts'

const props = defineProps<{
  posts: Post[]
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

function cover(post: Post) {
  return post.imageThumbs?.[0] || post.imageUrls?.[0] || ''
}
</script>

<template>
  <header v-if="slides.length" class="mag">
    <!-- 推荐轮播：4 张图轮着上，右侧文字跟着切。没有报头——
         首页顶部只保留「顶栏 + 频道栏」两层，内容直接从这个轮播开始 -->
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

/* ===== 推荐轮播 =====
 * 报头已删除：顶部只留「顶栏 + 频道栏」两层，轮播直接开场。
 * 上下各留 22px，和频道栏的 16px 间距连起来约 38px，不贴边也不空。
 */
.cover-story {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  /* 加大图文间距，接近杂志跨页的呼吸感 */
  gap: 68px;
  align-items: center;
  padding: 22px 4px;
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

/* 深色主题：kicker 用强调色提亮一档，避免深底上发灰 */
:global(.dark) .kicker {
  color: var(--accent);
  opacity: 1;
}

/* 窄屏：推荐轮播改竖排 */
@media (max-width: 900px) {
  .cover-story {
    grid-template-columns: 1fr;
    gap: 20px;
    padding: 18px 4px;
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
