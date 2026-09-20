import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  // dev 时把上传图片的相对 URL /uploads/* 反代到 Express 后端（3000）。
  // server 返回的 url 字段是相对路径 (/uploads/xxx.png)，如果不在这里配，
  // 浏览器请求会落到 Vite SPA fallback 拿到 text/html，<img> 解码失败。
  // 生产环境是单源，nginx/同源静态服务直接处理，无需此配置。
  server: {
    proxy: {
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})