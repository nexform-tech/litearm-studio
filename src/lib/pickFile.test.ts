import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickFileThroughDaemon } from './pickFile'

/**
 * 这一份钉的是**"浏览…"的三种结局各自落到哪条路**, 不是排版。
 *
 * 背景 (与 `lib/export.ts` 同源): 页面跑在 pywebview 的 webview 里, 自己铺不开一个稳当
 * 的目录浏览器, 也给不出标定文件的**主机路径**。所以正常路径是 `POST /api/pick-file`,
 * 由本地程序弹原生打开对话框、把选中的路径回给我们; 只有"这里没有本地程序"时才如实说
 * 选不了。
 */

function okJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('选文件交给本地程序弹对话框', () => {
  it('把起始目录 POST 给 /api/pick-file, 并带回它给的路径', async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ ok: true, picked: true, path: '/home/u/.litegrip/can0_calibration.json' }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await pickFileThroughDaemon('/home/u/.litegrip')

    expect(outcome).toEqual({ kind: 'picked', path: '/home/u/.litegrip/can0_calibration.json' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/pick-file?dir=${encodeURIComponent('/home/u/.litegrip')}`)
    expect(init.method).toBe('POST')
  })

  it('没有起始目录时也发得出去 (dir 为空串)', async () => {
    const fetchMock = vi.fn(async () => okJson({ ok: true, picked: true, path: '/tmp/x.json' }))
    vi.stubGlobal('fetch', fetchMock)

    await pickFileThroughDaemon()

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/pick-file?dir=')
  })

  it('操作员取消 = 一个字都不说', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      okJson({ ok: true, picked: false, reason: 'cancelled' })))
    expect(await pickFileThroughDaemon()).toEqual({ kind: 'cancelled' })
  })

  it('无界面运行的 no-window 也算"这里没有本地程序"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      okJson({ ok: true, picked: false, reason: 'no-window' })))
    expect(await pickFileThroughDaemon()).toEqual({ kind: 'unavailable' })
  })

  it('连不上本地程序 = 没有本地程序, 不是错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    expect(await pickFileThroughDaemon()).toEqual({ kind: 'unavailable' })
  })

  it('答话的不是本地程序 (开发服务器回了一页 HTML) 也按没有本地程序处理', async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('not json')
      },
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => response))
    expect(await pickFileThroughDaemon()).toEqual({ kind: 'unavailable' })
  })
})
