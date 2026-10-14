import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

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
      resolvers: [ElementPlusResolver({ importStyle: 'css' })]
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
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
