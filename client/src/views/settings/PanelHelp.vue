<script setup lang="ts">
/**
 * 帮助与客服
 *
 * 之前是一个死按钮。现在它做两件真的事：
 * ① 一份**能真的回答问题**的 FAQ（不是「请联系客服」那种废话）
 * ② 一个「提交问题」的入口：把内容整理成一段可复制的文本，
 *    指向 GitHub Issues —— 那是这个项目真实的客服渠道
 *
 * ⚠️ 没有做「在线客服」和「提交工单」表单：
 * 那是需要后端持久化 + 邮件通知的完整功能，
 * 在没有实现之前做成能点的按钮只会回到假按钮。
 * 指向真实的 issue 通道是诚实且可用的做法。
 */
import { ref } from 'vue'
import { ElMessage } from '@/utils/element'
import { FAQS, FEATURE_GROUPS } from './labels'
import { copyText } from '@/utils/format'
import { REPO_URL } from '@/composables/useStorageStats'

const openFaq = ref<number | null>(0)

/** 当前页面路径。写进 issue 模板里，用户不用自己补 */
const currentPath = ref(typeof window !== 'undefined' ? window.location.pathname : '/')

async function copyDiagnostic() {
  // 把排查所需的信息一次性整理好，用户只需要贴到 issue 里
  const info = [
    '## 环境',
    '',
    `- 路径：${currentPath.value}`,
    `- 浏览器：${navigator.userAgent}`,
    `- 视口：${window.innerWidth}×${window.innerHeight}`,
    `- 主题：${document.documentElement.classList.contains('dark') ? '深色' : '浅色'}`,
    `- 时间：${new Date().toISOString()}`,
    '',
    '## 现象',
    '',
    '（在这里描述）',
    '',
    '## 期望',
    '',
    '（在这里描述）'
  ].join('\n')

  const url = `${REPO_URL}/issues/new?body=${encodeURIComponent(info)}`
  const ok = await copyText(url)
  if (ok) ElMessage.success('已复制 issue 模板，打开 GitHub 后粘贴即可')
  else ElMessage.error('复制失败，请手动打开 Issues 页面')
}
</script>

<template>
  <div class="panel">
    <section class="block">
      <h3 class="block-title">常见问题</h3>
      <p class="block-desc">
        下面每一条都是这个项目里**真的**会遇到的情况， 而不是「请重启试试」那种不解决问题的话。
      </p>

      <div class="faq-list">
        <div v-for="(f, i) in FAQS" :key="i" class="faq">
          <button
            class="faq-q"
            :aria-expanded="openFaq === i"
            @click="openFaq = openFaq === i ? null : i"
          >
            <span>{{ f.q }}</span>
            <span class="faq-mark">{{ openFaq === i ? '−' : '+' }}</span>
          </button>
          <p v-if="openFaq === i" class="faq-a">{{ f.a }}</p>
        </div>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">这个站点做到了什么</h3>
      <p class="block-desc">按模块列一下，方便你确认某个功能是不是真的存在。</p>

      <div v-for="g in FEATURE_GROUPS" :key="g.title" class="feat">
        <div class="feat-title">{{ g.title }}</div>
        <ul class="feat-list">
          <li v-for="(it, i) in g.items" :key="i">{{ it }}</li>
        </ul>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">反馈问题</h3>
      <p class="block-desc">
        这个项目没有在线客服和工单系统 —— 做那两个需要后端持久化和邮件通知，没做就不做成能点的按钮。
        真实的反馈渠道是
        <a :href="`${REPO_URL}/issues`" target="_blank" rel="noopener" class="link">GitHub Issues</a
        >。
      </p>
      <el-button size="small" @click="copyDiagnostic">复制一份排查信息模板</el-button>
      <p class="note">
        会把当前路径、浏览器、视口和主题一起整理成 Markdown， 加上问题描述之后直接粘到 issue
        里就行。
      </p>
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
  line-height: 1.8;
  margin: 0 0 14px;
}

.faq-list {
  border-top: 1px solid var(--border-soft);
}

.faq {
  border-bottom: 1px solid var(--border-soft);
}

.faq-q {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 0;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  font-size: var(--fs-sm);
  color: var(--text-1);
  font-family: inherit;
}

.faq-q:hover {
  color: var(--accent);
}

.faq-mark {
  color: var(--text-3);
  font-size: var(--fs-md);
  flex-shrink: 0;
}

.faq-a {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.85;
  margin: 0 0 14px;
}

.feat {
  margin-bottom: 16px;
}

.feat-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 5px;
}

.feat-list {
  margin: 0;
  padding-left: 18px;
}

.feat-list li {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.9;
}

.link {
  color: var(--accent);
}

.note {
  margin: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.7;
}
</style>
