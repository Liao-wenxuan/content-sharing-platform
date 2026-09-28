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
  }
})
