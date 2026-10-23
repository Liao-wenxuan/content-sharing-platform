import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 串行跑：避免 in-memory db 跨文件相互污染（每个文件用各自的内存 db）
    fileParallelism: false,
    // 测试前强制设 NODE_ENV=test，让 rate-limit / error handler 走测试分支
    setupFiles: ['./tests/setup-env.ts'],
    // 测试超时：bcrypt 哈希 10 rounds 默认 ~100ms，留足余量
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      // 显式列出范围，而不是让 vitest 报「被 import 过的文件」。
      // 后者的意思是「测试碰过什么就统计什么」——
      // 少 import 一个文件，它就从报告里消失了，数字只会越来越好看。
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // 门槛是「回归线」不是「目标线」：跌破说明新代码没被测到，该补测试了。
      // 数字取实测值（77.36 / 67.27 / 88.57 / 80.92）下方约 2 个点 ——
      // 留得住正常波动，掉得下去就会被 CI 拦下来。
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 87,
        lines: 78
      }
    }
  },
})
