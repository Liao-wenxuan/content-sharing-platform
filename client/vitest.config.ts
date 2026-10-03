import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/**
 * 前端单测配置
 *
 * 和 vite.config.ts 分开而不是合并：生产构建不需要 test 字段，
 * 而且 vitest 需要 jsdom 环境和 @ 别名，分开更清楚。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    globals: false,
    // 组件测试要挂载 DOM（mount），纯函数测试也统一放 jsdom，省得分环境
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // 串行：部分用例会写 localStorage，串行避免相互影响
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // 只统计真正值得测的产物：工具函数、composable、组件。
      // main.ts / 样式 / 类型声明进覆盖率只会把数字做低，没有任何信息量。
      include: ['src/utils/**', 'src/composables/**', 'src/components/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // 门槛是「回归线」不是「目标线」：跌破说明新代码没被测到，该补测试了
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60
      }
    }
  }
})
