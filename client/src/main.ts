import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import router from './router'

// ===== Element Plus =====
// 组件本身由 unplugin-vue-components 按需自动引入（见 vite.config.ts），
// 这里只负责「全局 CSS 变量层」，顺序不能换：
//   base.css      → 官方浅色 :root 变量 + 基础 reset
//   dark/css-vars → html.dark 的深色变量覆盖
//   element-theme → 我们自己的 Flat + Outline 覆盖（必须最后，同特异度接管）
// 刻意不引 element-plus/dist/index.css：那是 360KB 全量样式，
// 按需模式下每个组件的样式由 resolver 单独 import，引全量会重复。
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/styles/element-theme.css'

// 设计系统 token —— 纯色 + 描边（Flat + Outline）
import './assets/styles/theme.css'

// Motion 层 —— 时长/缓动 token、键盘焦点、reduced-motion 兜底。
// 必须排在 theme.css 之后：它要读上面的 --accent / --interactive-border，
// 且 reduced-motion 的兜底规则优先级最高，放前面会被组件样式盖掉。
import './assets/styles/motion.css'

// 主题初始化：在 app.mount 之前同步落到 <html> 上，避免首屏主题闪烁。
// 默认深色已由 index.html 的 class="dark" 兜底，这里只处理用户改过的偏好。
const savedTheme = localStorage.getItem('theme')
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.classList.toggle('dark', savedTheme === 'dark')
}

const app = createApp(App)
app.use(createPinia().use(piniaPluginPersistedstate))
app.use(router)
app.mount('#app')
