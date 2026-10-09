import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadInBrowser, exportFile, exportThroughDaemon } from './export'

/**
 * 这一份钉的是**导出按钮的四种结局各自落到哪条路**, 不是排版。
 *
 * 背景 (issue #104 / #100): 页面自己只能做浏览器下载, 而在桌面版里那一下的落点由
 * pywebview 后端各自决定 (GTK 静默写进下载目录、WebView2 直接取消)。所以正常路径是
 * `POST /api/export`, 把字节交给本地程序去弹对话框、写文件并回答结果; 只有"这里没有
 * 本地程序"时才回退到浏览器下载。
 */
const NAME = 'litearm-logs-2026.jsonl'

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

function okJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:probe-1')
  revokeObjectURL = vi.fn()
  // jsdom 没有实现这两个 (真浏览器才有)。
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('导出交给本地程序保存', () => {
  it('把字节 POST 给 /api/export, 并带回它说的路径', async () => {
    const fetchMock = vi.fn(async () => okJson({ ok: true, saved: true, path: '/home/u/Downloads/x.jsonl' }))
    vi.stubGlobal('fetch', fetchMock)
    const blob = new Blob(['a\n'])

    const outcome = await exportThroughDaemon(blob, NAME)

    expect(outcome).toEqual({ kind: 'saved', path: '/home/u/Downloads/x.jsonl' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    // 文件名走查询串 (要编码), 体就是那份字节 —— 不再经过页面自己的 anchor。
    expect(url).toBe(`/api/export?name=${encodeURIComponent(NAME)}`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(blob)
  })

  it('操作员取消时说"取消", 不做任何别的事', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ ok: true, saved: false, reason: 'cancelled' })))

    expect(await exportFile(new Blob(['a']), NAME)).toEqual({ kind: 'cancelled' })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('本地程序存失败时如实返回原因, 不假装存好了', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ ok: false, error: 'write-failed', detail: 'No space left on device' })))

    expect(await exportFile(new Blob(['a']), NAME))
      .toEqual({ kind: 'failed', detail: 'No space left on device' })
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

describe('没有本地程序时回退到浏览器下载', () => {
  it('无界面运行的 daemon 会明说 no-window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ ok: true, saved: false, reason: 'no-window' })))

    expect(await exportFile(new Blob(['a']), NAME)).toEqual({ kind: 'browser' })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('连不上本地程序 (纯浏览器) 也回退', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    expect(await exportFile(new Blob(['a']), NAME)).toEqual({ kind: 'browser' })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('答话的不是本地程序 (静态站返回 HTML) 也回退', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    } as unknown as Response)))

    expect(await exportFile(new Blob(['a']), NAME)).toEqual({ kind: 'browser' })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('本地程序不在时开发服务器回的那一页也算"没有本地程序"', async () => {
    // vite 代理连不上 daemon 时回的是它自己的 500 页 —— 那不是我们的形状, 不是失败。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response)))

    expect(await exportFile(new Blob(['a']), NAME)).toEqual({ kind: 'browser' })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })
})

describe('浏览器下载的时序', () => {
  /** 上一次导出留下的对象 URL 是**模块级**状态, 先清干净再量这一次的时序。 */
  function drainPendingUrl() {
    window.dispatchEvent(new Event('pagehide'))
    revokeObjectURL.mockClear()
  }

  it('用我们的文件名点一个 <a download>, 并且不立刻撤销对象 URL', () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
    drainPendingUrl()
    clicked.length = 0

    downloadInBrowser(new Blob(['a']), NAME)

    expect(clicked).toHaveLength(1)
    expect(clicked[0].download).toBe(NAME)
    expect(clicked[0].getAttribute('href')).toBe('blob:probe-1')
    // ⚠ 宿主里的保存对话框是**异步**的: 对话框开着的时候 blob 还得在, 所以这里不撤销。
    expect(revokeObjectURL).not.toHaveBeenCalled()
    // 点完不留痕迹。
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })

  it('下一次导出时才回收上一个对象 URL', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    drainPendingUrl()

    downloadInBrowser(new Blob(['a']), NAME)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    downloadInBrowser(new Blob(['b']), NAME)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:probe-1')
  })

  it('页面卸载时把最后那份 blob 也回收掉', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    drainPendingUrl()
    downloadInBrowser(new Blob(['a']), NAME)

    window.dispatchEvent(new Event('pagehide'))

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:probe-1')
  })
})
