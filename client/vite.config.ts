import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const EP_COMPONENTS_DIR = fileURLToPath(
  new URL('./node_modules/element-plus/es/components', import.meta.url)
)

/** PascalCase -> kebab-case，和 element-plus 自己的目录命名一致 */
const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()

/**
 * 子组件没有自己的目录，由父组件的 index.mjs 一起导出。
 * 只列我们真正用到的；不在表里的名字一律先按 kebab-case 猜目录，猜错时
 * 会因为文件不存在而静默回落到总桶 —— 所以这张表错了构建不会报错，
 * 只会让体积悄悄涨回去（见 scripts/analyze-bundle.mjs 的总桶检查）。
 */
const EP_PARENT_DIR: Record<string, string> = {
  ElCheckboxGroup: 'checkbox',
  ElDescriptionsItem: 'descriptions',
  ElDropdownDivider: 'dropdown',
  ElDropdownItem: 'dropdown',
  ElDropdownMenu: 'dropdown',
  ElFormItem: 'form',
  ElMenuItem: 'menu',
  ElMenuItemGroup: 'menu',
  ElRadioButton: 'radio',
  ElRadioGroup: 'radio',
  ElRadioLabel: 'radio',
  ElSubMenu: 'menu',
  ElTabPane: 'tabs',
  ElOption: 'select',
  ElOptionGroup: 'select'
}

/** 组件名 -> element-plus/es/components/<dir>/index；目录不存在则返回 undefined */
function epComponentPath(name: string): string | undefined {
  const dir = EP_PARENT_DIR[name] ?? kebab(name.replace(/^El/, ''))
  return existsSync(join(EP_COMPONENTS_DIR, dir, 'index.mjs'))
    ? `element-plus/es/components/${dir}/index`
    : undefined
}

/**
 * ElementPlusResolver 的深路径版。
 *
 * 原版把组件解析到 `from: 'element-plus/es'` —— 那是整个库的总桶。
 * CSS 是按组件 import 的（sideEffects 里带 components/<name>/style/css），
 * 所以样式看起来「按需」，JS 却不是：任何一个用 el-* 的 SFC 都会
 * 把总桶拉进自己的依赖图，而总桶 re-export 了全部 98 个组件。
 * 实测入口 chunk 因此带上了 date-picker / table-v2 / transfer / tree-select
 * 这些本项目根本没用的组件，以及它们的 dayjs、@popperjs/core、
 * @ctrl/tinycolor、@vueuse/core、lodash-es。
 *
 * 这里只改 `from`，name 和 sideEffects 原样保留 —— CSS 的按需行为不受影响。
 * 图标（ElXxxIcon）和指令分支本来就不走总桶，原样返回。
 */
const ElementPlusDeepResolver = ElementPlusResolver({ importStyle: 'css' }).map((resolver) =>
  resolver.type === 'component'
    ? {
        ...resolver,
        resolve: async (name: string) => {
          const resolved = await resolver.resolve?.(name)
          if (!resolved || resolved.from !== 'element-plus/es') return resolved
          const path = epComponentPath(resolved.name ?? name)
          return path ? { ...resolved, from: path } : resolved
        }
      }
    : resolver
)

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需引入：
    // 模板里写 <el-button> 就能直接用，组件和它的 CSS 都会自动 import，
    // 不需要 app.use(ElementPlus) 全量注册。
    // 生成的 components.d.ts 让 vue-tsc 也能认识这些组件。
    Components({
      dts: 'src/components.d.ts',
      resolvers: [ElementPlusDeepResolver]
    }),
    {
      // 只在分析时开：SG_DUMP_GRAPH=1 SG_GRAPH_OUT=<path> npm --prefix client run build
      // 把 Rollup 的模块导入图倒出来，scripts/analyze-bundle.mjs --why <包名> 用它
      // 回答「这个包为什么会进首屏」。平时不产生任何开销，产物也不入库。
      name: 'sg-dump-module-graph',
      apply: 'build',
      generateBundle() {
        if (!process.env.SG_DUMP_GRAPH) return
        const out = process.env.SG_GRAPH_OUT
        if (!out) throw new Error('SG_DUMP_GRAPH=1 需要同时给 SG_GRAPH_OUT=<输出路径>')
        const ids = [...this.getModuleIds()]
        const edges: [string, string][] = []
        for (const id of ids) {
          const info = this.getModuleInfo(id)
          if (!info) continue
          for (const imp of info.importedIds) edges.push([id, imp])
        }
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, JSON.stringify(edges))
        this.warn(`module graph: ${ids.length} modules, ${edges.length} edges`)
      }
    }
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  /**
   * 依赖预构建的扫描入口：把**所有**源文件都算进去，一次发现完。
   *
   * 背景：深路径导入有 30 多个（element-plus/es/components/<name>），
   * 而 vite 默认「边跑边发现」—— 每发现一批新依赖就重新预构建，
   * 并且**触发一次整页 reload**。症状是 CI 里 e2e 随机失败：
   *
   *     page.waitForURL: Timeout ... navigated to ".../post/4"  ← 同一个 URL 两次
   *
   * 本地永远看不到（依赖早缓存好了），CI 的 dev server 永远是冷的。
   *
   * 只跑一遍路由做预热是不够的：设置页那些 el-drawer 里的组件
   * （switch / input-number / descriptions…）**要打开抽屉才会加载**，
   * 于是它们会在套件跑到一半时才被发现、才触发 reload ——
   * 实测预热把 10 次里的 8 次提前付掉了，剩下 2 次仍然砸在测试中间。
   *
   * 把入口列全，扫描器一次看完全部 import，就只有一轮预构建。
   * 这比手写 optimizeDeps.include 三十多个组件名好：
   * 那个方案多一份「新增组件忘了加」的债，而漏掉一个的症状
   * 恰好就是这次要消灭的整页 reload。
   */
  optimizeDeps: {
    entries: ['index.html', 'src/**/*.vue', 'src/**/*.ts']
  },
  // dev 时把上传图片的相对 URL /uploads/* 反代给 Express 后端（3000），
  // server 返回的 url 字段是相对路径（/uploads/xxx.png），如果不在这里配，
  // 浏览器请求会落到 Vite SPA fallback 返 text/html，<img> 加载失败。
  // 生产环境是单源，nginx/同源静态服务直接处理，无需配置。
  server: {
    proxy: {
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    // sourcemap 默认不开：它会让产物体积翻几倍，
    // 而且 .map 文件是源码映射，不该跟着构建物一起上线。
    // 只在做体积归因时临时打开（scripts/analyze-bundle.mjs 会自动带上）：
    //   $env:SG_SOURCEMAP=1; npm run build
    sourcemap: process.env.SG_SOURCEMAP === '1',
    // 同理，归因时关掉 minify：压缩会重排和内联代码，
    // 让「这段字节属于谁」变得不直观。归因要的是构成，不是最小体积。
    minify: process.env.VITE_MINIFY === '0' ? false : 'esbuild',
    rollupOptions: {
      output: {
        // 刻意**不**把 element-plus 整体塞进一个 vendor chunk。
        //
        // 听着像优化，实际会让按需引入失效：unplugin-vue-components
        // 生成的每个 el-* 独立 chunk 都是因为 Rollup 只保留了用到的组件，
        // 一旦手动声明 manualChunks: ['element-plus']，这个包的所有导出
        // 都被标记为「被使用」，整库重新进包。归因显示 EP 只贡献了
        // 311KB（未压缩），按需引入是在正常工作的，不要动它。
        //
        // 这里只切「体量大、几乎不变、且绝不该和业务代码同生共死」的部分。
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          const path = id.replace(/\\/g, '/')
          // Vue 全家桶 + vue-router：框架本体，升级才变
          if (/node_modules\/(vue|@vue|vue-router)\//.test(path)) return 'vue'
          // 状态管理
          if (/node_modules\/(pinia|pinia-plugin-persistedstate)\//.test(path)) return 'pinia'
          // HTTP 客户端：与 EP 无交集，单独成块便于定位和替换
          if (path.includes('node_modules/axios/')) return 'axios'
        }
      }
    }
  }
})
