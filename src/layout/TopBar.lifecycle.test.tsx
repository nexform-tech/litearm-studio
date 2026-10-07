/**
 * 端口下拉的**真实生命周期**用例 —— 不 mock `useArmPorts`/`ArmClient`, 只换掉 WebSocket。
 *
 * 为什么单独一个文件而不是 `TopBar.test.tsx`: 那个文件在模块层 `vi.mock('@/lib/arm')`
 * 掉了 `useArmPorts` 与 `connect` —— 恰好是这里要覆盖的两样; 而只测 hook 又覆盖不到
 * `TopBar` 的 `portOptions` 合并, 断口之后的临床表现 (下拉只剩一项) 正在那里。所以这里
 * 渲染**真的** `TopBar`, 用真的 `ArmClient` 走一遍操作员的真实工作流:
 * 页面加载自动连 → daemon 枚举出两个口 → 「断开」→ 选另一个口 → 「连接」。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { armClient } from '@/lib/arm'
import { FakeWebSocket } from '@/test/fakeWebSocket'
import { TopBar } from './TopBar'

beforeAll(() => {
  // Radix 的 Select 会量自己的宽度（`use-size`），指针交互还要 Pointer Capture ——
  // jsdom 两样都没有。
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  FakeWebSocket.instances = []
})

// 语言随测试环境的 navigator 走 (en/zh), 而「断开连接」在中文里**包含**「连接」——
// 按角色加名字取按钮会同时命中两个, 所以这里用顶栏自己给出的 id。
const connectButton = () => document.getElementById('topbar-connect-btn') as HTMLButtonElement
const disconnectButton = () => document.getElementById('topbar-disconnect-btn') as HTMLButtonElement

describe('TopBar port picker, real lifecycle', () => {
  it('keeps the last enumerated ports after 断开, and connects on the newly picked one', async () => {
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    )

    // 页面加载: `main.tsx` 自动发一条**无参** connect (自动发现连上了 ACM1, 不是操作员选的)。
    act(() => armClient.connect())
    const ws = FakeWebSocket.instances.at(-1)!
    act(() => ws.open())

    const connectFrame = ws.lastFrame('connect')!
    expect(typeof connectFrame.id).toBe('number')
    act(() => {
      ws.receive({ t: 'res', id: connectFrame.id, ok: true, v: { started: true } })
      ws.receive({ t: 'hello', daemon: '0.1.0', sdk: '2.1.0' })
      ws.receive({
        t: 'conn', status: 'connected', port: '/dev/ttyACM1',
        firmware: 'Litearm1.8.0-7J', n: 7, cart: true, error: null,
      })
    })
    expect(armClient.conn?.port).toBe('/dev/ttyACM1')

    // 挂载这一拍 socket 还没开, 第一次 `list_ports` 会被拒; 重试那一拍必须成功。
    await waitFor(
      () => expect(ws.frames().some((f) => f.m === 'list_ports')).toBe(true),
      { timeout: 3000 },
    )
    const listFrame = ws.frames().find((f) => f.m === 'list_ports')!
    // ⚠ 必须 await 这一拍: `listPorts()` 的 `.then` 是微任务, 同步 `act` 之后
    //   `setPorts` 还没落地 —— 那样断开时 hook 里根本没有列表可保留。
    await act(async () => {
      ws.receive({
        t: 'res', id: listFrame.id, ok: true,
        v: ['/dev/ttyACM0', '/dev/ttyACM1'],
      })
    })

    // 已连着时那次改口被 daemon 拒了 (另一个标签页发的同一条帧也会走到这里): 顶栏必须
    // **仍然**是绿色的「已连接」, 拒绝原因单独出现在错误槽里 —— 链路好好的时候说
    // 「连接失败」正是这个功能要消灭的那种谎话。
    act(() => armClient.connect('/dev/ttyACM0'))
    const refused = ws.lastFrame('connect')!
    await act(async () => {
      ws.receive({
        t: 'res', id: refused.id, ok: false,
        err: {
          kind: 'PortChangeWhileConnectedError',
          msg: '已连接 /dev/ttyACM1；换口请先断开 (本次请求的 /dev/ttyACM0 未生效)',
        },
      })
    })
    expect(armClient.status).toBe('connected')
    expect(armClient.lastError).toBeNull()
    expect(document.getElementById('topbar-connection-status')?.textContent).toMatch(/Connected|已连接/)
    expect(screen.getByTestId('topbar-error').textContent).toMatch(/断开|Disconnect/)

    // 断开: 真客户端会关掉那条共用 WebSocket —— 之后 `listPorts()` 一律被拒。
    act(() => fireEvent.click(disconnectButton()))
    expect(armClient.conn).toBeNull()
    // 「断开」也要把那条拒绝提示收掉 (它描述的是上一条链路的事)。
    expect(armClient.connectError).toBeNull()
    expect(screen.queryByTestId('topbar-error')).toBeNull()

    // 打开下拉会触发一次重新枚举。等过 5×400ms 的重试窗口: 旧实现在这里
    // `setPorts([])`, 于是下拉塌成只有「自动发现」一项。
    act(() => fireEvent.click(screen.getByTestId('topbar-port')))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2600))
    })
    expect(screen.getByRole('option', { name: '/dev/ttyACM0' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '/dev/ttyACM1' })).toBeTruthy()

    // 选另一个口再连: 新 socket 的 connect 帧必须带上**新选的口**, 而不是自动发现。
    act(() => fireEvent.click(screen.getByRole('option', { name: '/dev/ttyACM0' })))
    act(() => fireEvent.click(connectButton()))

    const reopened = FakeWebSocket.instances.at(-1)!
    expect(reopened).not.toBe(ws)
    act(() => reopened.open())
    expect(reopened.lastFrame('connect')).toMatchObject({
      t: 'connect',
      port: '/dev/ttyACM0',
    })
  })
})
