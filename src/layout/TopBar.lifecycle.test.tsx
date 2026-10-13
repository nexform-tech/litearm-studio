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

    // 断开: 真客户端会**先等 daemon 确认**（带 id 的请求, #82）。⚠ 会话结束、**链路不关**
    // —— 那条 WebSocket 是与本地守护进程唯一的命令通道, 会话只是它的用途之一。
    act(() => fireEvent.click(disconnectButton()))
    const discFrame = ws.lastFrame('disconnect')!
    expect(typeof discFrame.id).toBe('number') // 没有 id 就没有"确认"可言
    await act(async () => {
      ws.receive({ t: 'res', id: discFrame.id, ok: true, v: { stopped: true } })
    })
    expect(armClient.conn).toBeNull()
    // 「断开」也要把那条拒绝提示收掉 (它描述的是上一条链路的事)。
    expect(armClient.connectError).toBeNull()
    expect(screen.queryByTestId('topbar-error')).toBeNull()
    expect(ws.readyState).toBe(FakeWebSocket.OPEN)

    // 打开下拉会触发一次重新枚举: 断开之后这次枚举仍然真的走得到 daemon (旧实现把链路
    // 一起关掉, 这条命令当场被拒 —— 而那正是操作员要换口的时候)。
    act(() => fireEvent.click(screen.getByTestId('topbar-port')))
    await waitFor(
      () => expect(ws.frames().filter((f) => f.m === 'list_ports')).toHaveLength(2),
      { timeout: 3000 },
    )
    const reListed = ws.frames().filter((f) => f.m === 'list_ports').at(-1)!
    await act(async () => {
      ws.receive({ t: 'res', id: reListed.id, ok: true, v: ['/dev/ttyACM0', '/dev/ttyACM1'] })
    })
    expect(screen.getByRole('option', { name: '/dev/ttyACM0' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '/dev/ttyACM1' })).toBeTruthy()

    // 选另一个口再连: 同一条链路上补发一条带**新选的口**的 connect 帧 —— 链路既没关,
    // 也不需要重开。
    act(() => fireEvent.click(screen.getByRole('option', { name: '/dev/ttyACM0' })))
    act(() => fireEvent.click(connectButton()))

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.lastFrame('connect')).toMatchObject({
      t: 'connect',
      port: '/dev/ttyACM0',
    })
  })
})
