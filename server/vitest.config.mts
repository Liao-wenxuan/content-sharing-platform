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
  },
})
