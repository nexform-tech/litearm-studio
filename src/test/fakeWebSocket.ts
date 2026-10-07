/**
 * 测试用的最小假 WebSocket —— 手动控制 open/message/close。
 *
 * 给 `client.test.ts` 与端到端那条生命周期用例共用: 前者钉单条协议行为, 后者用**真的**
 * `ArmClient` + 真的 `useArmPorts`/`TopBar` 走一遍"页面加载自动连 → 断开 → 换口连接"。
 * 两处都要求同一份 `sent`/`frames()` 观察面, 复制一份必然漂移。
 */
export class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  // ── 测试助手 ──
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({} as Event)
  }

  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  lastFrame(m?: string): Record<string, unknown> | undefined {
    const frames = this.frames()
    for (let i = frames.length - 1; i >= 0; i--) {
      if (!m || frames[i].t === m) return frames[i]
    }
    return undefined
  }
}
