/**
 * 选一个**控制机上已经存在**的文件 —— 设置页"浏览…"按下之后发生的事。
 *
 * 谁读这个文件: 改标定导入的人, 以及要回答"为什么对话框是本地程序弹的"的人。
 *
 * **为什么不自己铺一个目录浏览器。** 标定文件的主机路径只有本机知道
 * (`gripper.import_calibration` 要的就是这个路径), 而页面跑在 pywebview 的 webview 里,
 * 自己列的目录既不可靠、也给不出一个稳当的选择 —— 与日志/遥测导出当初遇到的问题同源
 * (见 `lib/export.ts` 的说明)。所以这里和导出走同一条路: 把"问操作员"这件事交回本地
 * 程序 (`POST /api/pick-file`), 由它弹**原生打开对话框**, 我们只拿回一个路径。
 *
 * 没有本地程序时 (纯浏览器 / dev 服务器 / 无界面运行) 这条路走不通 —— 那种场景下本来
 * 也给不出主机路径, 于是如实回 `unavailable`, 由调用方去说。
 */

/** 一次选文件的结局。`unavailable` 不是失败, 是"这里没有本地程序能弹对话框"。 */
export type PickOutcome =
  | { kind: 'picked'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }

/**
 * 请本地程序弹原生打开对话框, 返回操作员挑中的路径。
 *
 * `initialDir` 是对话框从哪开始 (通常是当前所填路径的上级目录); 缺省由本地程序决定。
 */
export async function pickFileThroughDaemon(initialDir?: string): Promise<PickOutcome> {
  let response: Response
  try {
    response = await fetch(`/api/pick-file?dir=${encodeURIComponent(initialDir ?? '')}`, {
      method: 'POST',
    })
  } catch {
    // 连不上本地程序 —— 纯浏览器运行, 不是错误。
    return { kind: 'unavailable' }
  }
  // 不是本地程序在答话 (开发服务器/静态站返回了 HTML) 时 `json()` 会抛, 同样按"没有
  // 本地程序"处理。
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload || payload.ok !== true) return { kind: 'unavailable' }
  if (payload.picked === true && typeof payload.path === 'string') {
    return { kind: 'picked', path: payload.path }
  }
  // `no-window` (无界面运行) 与"别的形状"一样: 这里没有对话框可弹。
  if (payload.reason === 'no-window') return { kind: 'unavailable' }
  // 剩下的 `cancelled` 与未知 reason 都按"操作员没选"处理: 什么都不做。
  return { kind: 'cancelled' }
}
