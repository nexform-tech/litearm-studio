/**
 * 全局测试环境 —— 只调**时间预算**，不动任何断言。
 *
 * 为什么需要它：整套用例在并行负载下跑时，红的是"等得不够久"而不是"功能坏了"。
 * 具体两处（2026-10-06 实测，同一台机器上单独跑全过、并行跑随机失败，
 * 且把改动 stash 掉的干净分支同样失败）：
 *
 * - `findBy*` / `waitFor` 的默认上限是 **1 秒**（RTL 的 `asyncUtilTimeout`）。
 *   本仓大量是 jsdom + React 19 的重组件，设置页首次渲染要等一串 mock 的 promise
 *   落地；1 秒在负载下会被超。
 * - vitest 的单条用例上限默认 **5 秒**，见 `vitest.config.ts` 的 `testTimeout`。
 *
 * ⚠ 这里**没有**放宽任何判据：条件与期望值一个都没改，只是允许同一个条件多等一会儿。
 *   真正的挂死仍会在上限处失败。
 */
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

configure({ asyncUtilTimeout: 5000 })

// vitest 没开 globals，RTL 的自动 cleanup 不会注册。不手动挂的话，上一个用例的 DOM
// 会留在 document 里 —— 历史上已经因此让「J1」的计数在用例之间叠加过。
afterEach(cleanup)
