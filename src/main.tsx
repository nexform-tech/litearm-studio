import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './styles/index.css'
import './i18n'
import { AppShell } from './layout/AppShell'
import { LogsPage, SettingsPage, SoloConsole } from './routes'
import { telemetryRecorder } from './features/telemetry/telemetryRecorder'
import { logStore } from './lib/log/logStore'
import { armClient } from './lib/arm/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ThemedToaster } from './components/ThemedToaster'
import { initTheme } from './lib/theme'

// 主题跟随「用户选择 → 系统偏好」。index.html 的内联脚本已经在首帧前
// 设过 class，这里再按同一规则算一次，保证 dev/web 版本行为一致。
initTheme()

// 上位机一打开就连本机 daemon，并启动两条**与所在页面无关**的记录通道：
// - 遥测记录器：跟随机械臂连接把采样写进 IndexedDB；
// - 日志流：把 daemon 的 `log` 帧收进内存 + 缓存（权威历史是 daemon 的 JSONL 文件）。
armClient.connect()
telemetryRecorder.start()
logStore.start()

// React 19 dev 构建会对每次 commit 调 performance.measure() 且从不清理，
// 这是 dev 模式内存无限上涨的直接原因（生产构建无此代码，不受影响）。
// dev 下定期清空账本，保持内存平稳；该分支在生产构建中会被 tree-shaking 掉。
if (import.meta.env.DEV) {
  setInterval(() => performance.clearMeasures(), 10_000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <ThemedToaster />
        <Suspense
          fallback={
            <div className="flex h-screen w-screen items-center justify-center bg-muted text-sm text-muted-foreground">
              LiteArm Studio
            </div>
          }
        >
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/control" replace />} />
              <Route path="/control" element={<SoloConsole />} />
              {/* 旧路径兼容重定向 */}
              <Route path="/solo" element={<Navigate to="/control" replace />} />
              <Route path="/log" element={<LogsPage />} />
              <Route path="/telemetry" element={<Navigate to="/log" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/control" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
