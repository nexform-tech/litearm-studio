import { lazy } from 'react'

// 路由级按需加载：three.js / chart.js 等重量级依赖只随对应页面下载，
// 避免全部塞进首屏主包。独立成模块以便 main.tsx 保持快速刷新友好。
export const SoloConsole = lazy(() => import('./features/solo/SoloConsole').then((m) => ({ default: m.SoloConsole })))
export const LogsPage = lazy(() => import('./features/telemetry/LogsPage').then((m) => ({ default: m.LogsPage })))
export const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })))
