/**
 * 导出文件的落点 —— 日志 JSONL 与遥测 CSV 两个导出按钮共用这一条路。
 *
 * 谁读这个文件: 改导出行为的人, 以及要回答"按了导出之后文件去哪了"的人。
 *
 * **为什么不是 `Blob` + `<a download>` 就完事。** 那一下在浏览器里是对的: 文件进浏览器
 * 的下载目录, 不问也不报。可桌面版里页面跑在 pywebview 的 webview 里, 落点由宿主后端
 * 各自决定 —— GTK 静默写进 XDG 下载目录 (没有那个目录就写进 `$HOME`), WebView2 干脆
 * 把下载取消。页面既选不了地方, 也问不到结果, 表现就是"按了没反应"(issue #104)。
 *
 * 所以字节要交回本地程序 (`POST /api/export`): 它弹原生保存对话框、它写文件、它回答
 * 存到了哪里。没有本地程序时 (纯浏览器 / dev 服务器 / 无界面运行) 回退到浏览器下载,
 * 那条路在浏览器里本来就是对的。
 */

/** 一次导出的结局。`browser` 不是失败, 是"这里没有本地程序, 已经改用浏览器下载"。 */
export type ExportOutcome =
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'browser' }
  | { kind: 'failed'; detail: string }

/** 还没有被撤销的上一个对象 URL —— 见 `downloadInBrowser` 里的时序说明。 */
let liveUrl: string | null = null

function releaseLiveUrl() {
  if (liveUrl === null) return
  URL.revokeObjectURL(liveUrl)
  liveUrl = null
}

/**
 * 浏览器下载 —— 没有本地程序时的落点, 也是页面自己唯一能做到的那件事。
 *
 * ⚠ **不在 `click()` 之后立刻撤销对象 URL。** 浏览器里立刻撤销是安全的 (下载已经拿到
 * 那份 blob), 但宿主里的保存对话框是**异步**的: 对话框开着的时候 blob 还得在。留到
 * 下一次导出或页面卸载再撤销, 代价只有一份 blob 的内存。实测 (WebKitGTK 2.52.5,
 * 5 MB 载荷, 目标路径延迟 2 秒才设定): 立刻撤销也照样写出完整文件 —— 所以这一条是
 * 保险, 不是已复现的缺陷。
 */
export function downloadInBrowser(blob: Blob, filename: string): void {
  releaseLiveUrl()
  const url = URL.createObjectURL(blob)
  liveUrl = url
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', releaseLiveUrl)
}

/** 把字节交给本地程序保存, 并回答它把文件放到了哪里。 */
export async function exportThroughDaemon(blob: Blob, filename: string): Promise<ExportOutcome> {
  let response: Response
  try {
    response = await fetch(`/api/export?name=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    })
  } catch {
    // 连不上本地程序 —— 纯浏览器运行, 不是错误。
    return { kind: 'browser' }
  }
  // 不是本地程序在答话 (开发服务器/静态站返回了 HTML) 时 `json()` 会抛, 同样回退。
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) return { kind: 'browser' }
  if (payload.saved === true && typeof payload.path === 'string') {
    return { kind: 'saved', path: payload.path }
  }
  if (payload.ok === true && payload.reason === 'cancelled') return { kind: 'cancelled' }
  if (payload.ok === true && payload.reason === 'no-window') return { kind: 'browser' }
  if (payload.ok === false && typeof payload.error === 'string') {
    // 本地程序明确拒绝了 (名字无效 / 太大 / 写不进去): 照实说, 不要再假装成浏览器下载。
    const detail = typeof payload.detail === 'string' && payload.detail
      ? payload.detail
      : payload.error
    return { kind: 'failed', detail }
  }
  // 别的形状 —— 例如开发服务器在 daemon 不在时回的那一页。这不是错误, 是"这里没有
  // 本地程序", 与连不上时同一条路。
  return { kind: 'browser' }
}

/**
 * 导出一次: 先请本地程序保存, 它不在 (或没有窗口) 才回退到浏览器下载。
 *
 * 取消**什么都不做** —— 操作员已经说了不要, 再弹一条提示只会添乱。失败则如实返回,
 * 由调用方去说。
 */
export async function exportFile(blob: Blob, filename: string): Promise<ExportOutcome> {
  const outcome = await exportThroughDaemon(blob, filename)
  if (outcome.kind === 'browser') {
    downloadInBrowser(blob, filename)
  }
  return outcome
}
