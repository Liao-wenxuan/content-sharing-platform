<script setup lang="ts">
/**
 * 关于
 *
 * 之前是一个死按钮。现在它说三件**真实且可核对**的事：
 * ① 这个项目是什么、不是什么
 * ② 技术栈（每一条都能在仓库里找到对应文件）
 * ③ 数据存在哪、有多少条、有哪些已知限制
 *
 * 「已知限制」这一节是有意加的：只报喜的项目页等于没信息，
 * 而这些限制恰恰是这个项目最能说明「知道自己边界在哪」的地方。
 */
import { REPO_URL } from '@/composables/useStorageStats'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

const STACK = [
  {
    layer: '前端',
    items: [
      'Vue 3.5（Composition API）',
      'TypeScript 5.6',
      'Vite 6',
      'Element Plus 2.14',
      'Pinia（含持久化）',
      'Vue Router（19 条路由）'
    ]
  },
  {
    layer: '动效',
    items: [
      '纯 CSS transition / animation',
      'IntersectionObserver 滚动入场',
      'linear() 原生弹簧',
      '零动画库依赖'
    ]
  },
  {
    layer: '后端',
    items: [
      'Express 4',
      'SQLite（better-sqlite3）',
      '手写 SQL，无 ORM',
      'JWT 鉴权',
      'ws（手写 WebSocket 协议）'
    ]
  },
  {
    layer: '工程',
    items: [
      'Vitest + supertest',
      'Playwright 端到端',
      'ESLint + Prettier',
      'Husky + lint-staged + commitlint',
      'GitHub Actions 三 job'
    ]
  }
]

const LIMITS = [
  '搜索基于 SQL LIKE，十万级内容需要换 FTS5 或 ES',
  '没有接任何第三方登录、短信、邮件或支付渠道',
  '图片存在本地磁盘，没有对象存储和 CDN',
  'WebSocket 是单进程内存 hub，多实例部署需要外部 broker',
  '没有内容审核和举报机制 —— 这是公开社区最该有而目前没有的'
]
</script>

<template>
  <div class="panel">
    <section class="block">
      <h3 class="block-title">这是什么</h3>
      <p class="block-desc">
        一个内容社区的前后端项目。功能形态参考小红书 （发布图文、点赞收藏评论、关注、私信、市集），
        视觉层则是自建的工业 HUD 调性 —— 这两件事是分开的：像小红书指的是功能，不是界面。
      </p>
      <p class="block-desc">
        <b>它不是一个正在运营的产品。</b>没有真实用户、没有内容审核、
        没有客服和数据备份策略。它是一个用来展示工程能力的项目，
        所以下面写的每一个数字都应该能被你在仓库里核对到。
      </p>
    </section>

    <section class="block">
      <h3 class="block-title">技术栈</h3>
      <div v-for="s in STACK" :key="s.layer" class="stack-row">
        <span class="stack-layer">{{ s.layer }}</span>
        <ul class="stack-items">
          <li v-for="(it, i) in s.items" :key="i">{{ it }}</li>
        </ul>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">你的数据存在哪</h3>
      <ul class="facts">
        <li>
          当前账号<b>{{ auth.user?.nickname || '未登录' }}</b>
        </li>
        <li>数据库<b>服务端本地的 SQLite 文件</b></li>
        <li>图片<b>服务端本地的 uploads 目录</b></li>
        <li>备份<b>没有自动备份</b></li>
      </ul>
      <p class="note">
        「没有自动备份」这一条是有意写出来的。 隐私设置里的「导出我的数据」能帮你把内容拿出来，
        但它**不包含图片文件** —— 那只是恢复数据的一部分。
      </p>
    </section>

    <section class="block">
      <h3 class="block-title">已知限制</h3>
      <p class="block-desc">只报喜的项目页等于没信息。下面这些是这个项目现在做不到的事。</p>
      <ul class="limits">
        <li v-for="(l, i) in LIMITS" :key="i">{{ l }}</li>
      </ul>
    </section>

    <section class="block">
      <h3 class="block-title">源码</h3>
      <p class="block-desc">
        整个项目（前端、后端、测试、文档）都在这一个仓库里， 没有私有部分。MIT 协议。
      </p>
      <div class="links">
        <a :href="REPO_URL" target="_blank" rel="noopener" class="link-btn">仓库首页 ↗</a>
        <a
          :href="`${REPO_URL}/blob/main/docs/architecture.md`"
          target="_blank"
          rel="noopener"
          class="link-btn"
        >
          架构与数据模型 ↗
        </a>
        <a
          :href="`${REPO_URL}/blob/main/docs/interview.md`"
          target="_blank"
          rel="noopener"
          class="link-btn"
        >
          技术问答稿 ↗
        </a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 28px;
}

.block-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 6px;
}

.block-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.85;
  margin: 0 0 10px;
}

.block-desc b {
  color: var(--text-1);
}

.stack-row {
  display: flex;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-soft);
}

.stack-layer {
  font-size: var(--fs-xs);
  color: var(--accent);
  width: 48px;
  flex-shrink: 0;
  padding-top: 2px;
}

.stack-items {
  flex: 1;
  margin: 0;
  padding-left: 16px;
}

.stack-items li {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.85;
}

.facts {
  list-style: none;
  margin: 0;
  padding: 0;
}

.facts li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.facts b {
  color: var(--text-1);
  font-weight: 500;
  text-align: right;
}

.note {
  margin: 12px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.8;
}

.limits {
  margin: 0;
  padding-left: 18px;
}

.limits li {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.95;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.link-btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-sm);
  text-decoration: none;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    color var(--dur-fast) var(--ease-out-expo);
}

.link-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
