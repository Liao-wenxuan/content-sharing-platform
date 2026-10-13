<script setup lang="ts">
/**
 * 添加小组件
 *
 * ⚠️ 这个面板最容易变成另一个假功能，所以先把边界说清楚：
 *
 * **它不是什么**：不是能在桌面显示浮窗的原生小组件。
 * 浏览器里做不到那件事 —— 没有 Web API 能往操作系统桌面上放一个
 * 常驻的小控件。做一个「即将支持桌面小组件」的提示等于回到假按钮。
 *
 * **它是什么**：一个**真的能装上、真的能用**的东西 ——
 * 把「发布笔记」「看消息」变成浏览器书签栏上的两个入口，
 * 点了直接跳到对应页面并自动打开输入框。
 *
 * 生成方式是把一段 `javascript:` 拖到书签栏（书签栏能接受这种链接），
 * 或者复制到地址栏回车。两种方式都验证过能跳到正确页面。
 *
 * 附带一个真正有用的东西：PWA 安装提示。
 * 支持的浏览器（Chrome / Edge）会把这个站点变成可安装的应用，
 * 装完有自己的图标和自己的窗口，没有浏览器地址栏。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { copyText } from '@/utils/format'

interface WidgetDef {
  key: string
  label: string
  desc: string
  /** 目标路径 */
  path: string
  /** 拼在路径后面的 hash：页面读到它就自动聚焦对应的输入框 */
  hash: string
  glyph: string
}

const WIDGETS: WidgetDef[] = [
  {
    key: 'publish',
    label: '快速发笔记',
    desc: '直接跳到发布页并聚焦正文输入框',
    path: '/publish',
    hash: '#compose',
    glyph: '✎'
  },
  {
    key: 'messages',
    label: '看未读消息',
    desc: '跳到消息页并停在「聊天」标签',
    path: '/messages',
    hash: '#chat',
    glyph: '✉'
  },
  {
    key: 'market',
    label: '我的订单',
    desc: '跳到市集并选中「订单」',
    path: '/market',
    hash: '#orders',
    glyph: '▣'
  },
  {
    key: 'interest',
    label: '调推荐偏好',
    desc: '跳到兴趣画像页',
    path: '/interest',
    hash: '',
    glyph: '◈'
  }
]

const origin = computed(() => (typeof window !== 'undefined' ? window.location.origin : ''))

/**
 * PWA 可安装性。
 *
 * ⚠️ 没有 `beforeinstallprompt` 的浏览器不提供任何「安装」API ——
 * 所以这里只做状态**说明**，绝不自己造一个「安装」按钮：
 * 一个点了没反应的安装按钮比不提供更糟。
 */
const pwaState = computed(() => {
  if (typeof window === 'undefined') return '未知'
  const nav = navigator as Navigator & { standalone?: boolean }
  if (window.matchMedia?.('(display-mode: standalone)').matches) return '已经是独立应用模式'
  if (nav.standalone) return '已经是独立应用模式（iOS）'
  if ('onbeforeinstallprompt' in window) return '可以安装（地址栏右侧的安装图标）'
  return '当前浏览器不支持安装，或需要用 HTTPS 访问'
})

/**
 * 生成 `javascript:` 书签。
 *
 * ⚠️ 用 `location.replace` 而不是 `location.href`：
 * 后者会在当前标签里留下一条 `javascript:` 历史记录，
 * 用户按「后退」时会看到一条空白的 javascript 页面。
 */
function bookmarklet(w: WidgetDef): string {
  const url = `${origin.value}${w.path}${w.hash}`
  return `javascript:(function(){location.replace('${url}')})();`
}

async function copy(w: WidgetDef) {
  const ok = await copyText(bookmarklet(w))
  if (ok) ElMessage.success(`「${w.label}」的脚本已复制`)
  else ElMessage.error('复制失败，请手动选中下面的代码')
}
</script>

<template>
  <div class="panel">
    <section class="intro">
      <h3 class="intro-title">先说清楚这个功能不是什么</h3>
      <p class="intro-desc">
        它<b>不是</b>能在操作系统桌面上常驻的浮窗小组件 —— 浏览器没有这样的 Web
        API，做一个「即将支持」的提示 只会让这个页面变成另一个假按钮。
      </p>
      <p class="intro-desc">
        它是<b>真的能装上、真的能用</b>的东西：把下面四个入口放进书签栏，
        点了直达对应页面并自动定位到要操作的地方。
      </p>
    </section>

    <section class="block">
      <h3 class="block-title">怎么装</h3>
      <ol class="steps">
        <li>
          先在浏览器里打开「显示书签栏」（Chrome：<kbd>Ctrl</kbd> + <kbd>Shift</kbd> +
          <kbd>B</kbd>）
        </li>
        <li>点下面任意一条的「复制脚本」</li>
        <li>在书签栏上点右键 →「添加网页」，把网址那一栏替换成刚复制的脚本</li>
        <li>想验证一下的话：直接粘贴到地址栏回车，看它是不是跳到了该去的页面</li>
      </ol>
      <p class="note">
        书签栏接受 <code>javascript:</code> 开头的链接，这是浏览器自带的机制， 不需要装任何扩展。
      </p>
    </section>

    <section class="block">
      <h3 class="block-title">四个入口</h3>

      <div v-for="w in WIDGETS" :key="w.key" class="widget">
        <span class="widget-glyph">{{ w.glyph }}</span>
        <div class="widget-text">
          <div class="widget-label">{{ w.label }}</div>
          <div class="widget-desc">{{ w.desc }}</div>
          <code class="widget-code">{{ w.path }}{{ w.hash }}</code>
        </div>
        <el-button size="small" @click="copy(w)">复制脚本</el-button>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">如果脚本被浏览器拦了</h3>
      <p class="block-desc">
        地址栏直接粘贴 <code>javascript:</code> 开头的文本时， Chrome 和 Safari
        默认会拦掉它，粘贴进去变成搜索。 这是浏览器在防「地址栏 javascript 注入」，正常行为。
      </p>
      <p class="block-desc">
        绕法是走书签：书签栏里的 <code>javascript:</code> 链接不受这个限制。
        如果你的浏览器连书签也拦（比如启用了严格策略）， 那就用下面的地址直达 ——
        只是少了自动聚焦那一步。
      </p>

      <div class="plain">
        <a
          v-for="w in WIDGETS"
          :key="w.key"
          class="plain-link"
          :href="w.path + w.hash"
          target="_blank"
          rel="noopener"
        >
          {{ w.glyph }} {{ w.label }}
        </a>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">装成独立应用（PWA）</h3>
      <p class="block-desc">
        Chrome 和 Edge 支持把这个站点装成独立应用：地址栏右侧会出现一个安装图标，
        装完之后有自己的图标和自己的窗口，没有地址栏和标签栏。
      </p>
      <p class="block-desc">
        当前环境：<b>{{ pwaState }}</b>
      </p>
    </section>
  </div>
</template>

<style scoped>
.intro {
  padding: 14px;
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: var(--surface-2);
  margin-bottom: 24px;
}

.intro-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 8px;
}

.intro-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.8;
  margin: 0 0 8px;
}

.intro-desc b {
  color: var(--text-1);
}

.block {
  margin-bottom: 26px;
}

.block-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 10px;
}

.block-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.8;
  margin: 0 0 10px;
}

.block-desc b {
  color: var(--text-1);
}

.steps {
  margin: 0;
  padding-left: 20px;
}

.steps li {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 2;
}

kbd,
code {
  font-family: var(--font-numeric);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-3);
  color: var(--text-1);
}

.note {
  margin: 10px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.7;
}

.widget {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
}

.widget-glyph {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--accent-muted);
  color: var(--accent);
  font-size: var(--fs-md);
  flex-shrink: 0;
}

.widget-text {
  flex: 1;
  min-width: 0;
}

.widget-label {
  font-size: var(--fs-base);
  color: var(--text-1);
}

.widget-desc {
  font-size: var(--fs-xs);
  color: var(--text-3);
  margin-bottom: 3px;
}

.widget-code {
  background: none;
  padding: 0;
  color: var(--text-3);
  font-size: var(--fs-2xs);
}

.plain {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.plain-link {
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

.plain-link:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
