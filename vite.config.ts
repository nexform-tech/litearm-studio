import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        // 手动拆 vendor：按依赖分组生成独立 chunk（react / router / i18n / ui /
        // charts / three / 兜底 vendor）。配合路由级与 3D 视口按需加载，让首屏
        // 主包只剩应用壳；vendor chunk 内容稳定，可长期缓存、并行加载。
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'router',
              test: /node_modules[\\/](?:react-router|history)[\\/]/,
              priority: 20,
            },
            {
              name: 'i18n',
              test: /node_modules[\\/](?:i18next|react-i18next)[\\/]/,
              priority: 20,
            },
            {
              name: 'charts',
              test: /node_modules[\\/](?:chart\.js|react-chartjs-2)[\\/]/,
              priority: 20,
            },
            {
              name: 'three',
              test: /node_modules[\\/](?:three|urdf-loader)[\\/]/,
              priority: 20,
            },
            {
              name: 'ui',
              test: /node_modules[\\/](?:lucide-react|sonner|radix-ui|@radix-ui|tailwind-merge|clsx|class-variance-authority)[\\/]/,
              priority: 15,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    watch: {
      // 构建缓存/产物目录不参与监听：Windows SDK 缓存含符号链接循环（ELOOP），
      // 且这些目录变更无需触发 HMR，避免 dev 服务被文件监听器搞崩。
      ignored: ['**/.git/**', '**/node_modules/**', '**/.build-*/**', '**/dist-*/**', '**/src-tauri/target/**'],
    },
  },
})
