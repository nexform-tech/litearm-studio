import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from './dialog'

/**
 * 这一份钉的是**对话框的宽度约束**，不是外观 — issue #103。
 *
 * 缺陷的形状：`DialogContent` 是 `display: grid`，但没有定列。隐式列按 `auto` 定尺，
 * WebKit 会把它算到 `max-width` 那一边 —— 实测 (WebKitGTK 2.52.5)：312px 的对话框里
 * 列宽 **384.5px**，`scrollWidth 411 > clientWidth 312`。右边那一列于是被对话框自己的
 * `overflow` 裁掉：上升/家目录按钮、底部的取消键、每一行右侧的圆角全都不见了。操作员
 * 看到的是"弹窗是纯白、连返回都没有"。Chromium 恰好算得下，所以只有在 webview 里才
 * 看得见 —— 这也是为什么它躲过了所有在浏览器里做的检查。
 *
 * ⚠ jsdom 没有排版引擎，量不出"有没有被裁掉"。所以这里钉的是那条**判据本身**：给这一
 * 列定尺的 class 必须在。删掉它，这条测试就会红。
 */
describe('DialogContent', () => {
  it('constrains its single grid column so a WebKit auto column cannot overflow', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Pick a calibration file</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const content = screen.getByRole('dialog')
    // `grid-cols-1` 展开是 `repeat(1, minmax(0, 1fr))` —— 那个 `minmax(0, …)` 就是全部意义。
    expect(content.className).toContain('grid-cols-1')
    expect(content.className).toContain('grid')
  })

  it('lets a call site keep its own width limits', () => {
    render(
      <Dialog open>
        <DialogContent className="max-h-[85vh] max-w-lg">
          <DialogTitle>Pick a calibration file</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const content = screen.getByRole('dialog')
    expect(content.className).toContain('grid-cols-1')
    expect(content.className).toContain('max-w-lg')
  })
})
