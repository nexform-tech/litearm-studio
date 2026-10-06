import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // 只调预算，不动判据 —— 理由见该文件头的说明。
    setupFiles: ['./src/test/setup.ts'],
    // 单条用例的上限。默认 5 秒对这里最重的两条不够：一条要往 fake-indexeddb 写 2100
    // 条采样再翻 10 页，另一条要等一个 3 秒轮询周期。并行跑时它们会被超，而单独跑全过。
    // 真正的挂死仍会在 20 秒处失败。
    testTimeout: 20000,
    // 不要让 worker 数跟着核数无限涨。实测（14 核、机器上还有别的进程时）默认并发会让
    // jsdom + React 的计时用例随机超时；压到 4 之后同一台机器上连续全绿，代价是整套
    // 从约 35s 变成约 56s。第三方 CI runner 只有 2–4 vCPU，这个上限对它们本来就不生效。
    maxWorkers: 4,
  },
})
