import { describe, expect, it } from 'vitest'
import { EMPTY_CSV_WIDTHS, mergeCsvWidths, telemetryCsvHeader, telemetryCsvRow } from './csv'
import type { TelemetrySample } from './telemetryDb'

/**
 * 导出 CSV 的表头与行必须**同宽、同序**。
 *
 * 这两件事以前各写各的：表头从一个写死的 7 轴来（调用点根本不传参），行按设备实际报的
 * 轴数来。少轴的台架上导出的文件列名与数据整体错位 —— `errs` 落到 `dq1` 底下，后面每个
 * 值都串到隔壁标题里，而文件本身看着完全正常。所以这里钉住的是"两者同源"。
 *
 * ⚠ "同源"不是"取自同一条样本"：会话是断线 30s 内重连就延续的，同一个文件里可能出现
 * 两种宽度的行。表头取整段会话的上限，行按同一组宽度铺开，才谈得上同宽。
 */

function sample(axes: number, options: { temps?: number } = {}): TelemetrySample {
  const n = axes
  const temps = options.temps ?? n
  return {
    sessionId: 1,
    ts: 1700000000000,
    state: 'ready',
    q: Array.from({ length: n }, (_, i) => 0.1 * (i + 1)),
    dq: Array.from({ length: n }, (_, i) => 0.01 * (i + 1)),
    tau: Array.from({ length: n }, (_, i) => 0.5 * (i + 1)),
    temps: Array.from({ length: temps }, (_, i) => ({ mosTemp: 40 + i, coilTemp: 35 + i })),
    errs: [0, 1],
    faults: [{ joint: 2, errCode: 9 }],
  }
}

/** 一次导出用的列宽：那批样本逐段取最大 —— 与 `exportSession` 的第一遍同一件事。 */
const widthsOf = (...samples: TelemetrySample[]) =>
  samples.reduce(mergeCsvWidths, EMPTY_CSV_WIDTHS)

/** 去掉 CSV 的引号包装（含逗号的值会被包起来），只看值本身。 */
const unquote = (v: string) =>
  v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/""/g, '"') : v

describe('telemetry CSV', () => {
  it('gives the header and the row the same width on a seven-axis bench', () => {
    const s = sample(7)
    const w = widthsOf(s)
    expect(telemetryCsvHeader(w)).toHaveLength(telemetryCsvRow(s, w).length)
  })

  it('gives the header and the row the same width on a three-axis bench', () => {
    // 少轴才是出错的那一档：旧实现的表头写死 7 轴，于是多出 4×5 个没有数据的标题。
    const s = sample(3)
    const w = widthsOf(s)
    const header = telemetryCsvHeader(w)
    const row = telemetryCsvRow(s, w)

    expect(header).toHaveLength(row.length)
    expect(header).toEqual([
      'ts', 'state',
      'q1', 'q2', 'q3',
      'dq1', 'dq2', 'dq3',
      'tau1', 'tau2', 'tau3',
      'mos1', 'mos2', 'mos3',
      'coil1', 'coil2', 'coil3',
      'errs', 'faults',
    ])
  })

  it('keeps every value under its own heading on a three-axis bench', () => {
    // 宽度相同还不够 —— 错位才是操作员真正看到的东西：`errs` 落在 `dq1` 底下。
    const s = sample(3)
    const w = widthsOf(s)
    const header = telemetryCsvHeader(w)
    const row = telemetryCsvRow(s, w)
    const at = (name: string) => unquote(row[header.indexOf(name)])

    expect(at('ts')).toBe('1700000000000')
    expect(at('state')).toBe('ready')
    expect(at('q3')).toBe('0.30000000000000004')
    expect(at('coil3')).toBe('37')
    expect(at('errs')).toBe('[0,1]')
    expect(at('faults')).toBe('[{"joint":2,"errCode":9}]')
  })

  it('keeps a narrow row aligned under a header sized by the widest sample', () => {
    // ⚠ 会话中途换台架（7J → 1J）：表头只写一次，取整段的上限；窄的行在自己的段后面
    //   留白，`errs`/`faults` 仍然落在自己的标题下 —— 而不是整体左移串到别人的列里。
    const wide = sample(7)
    const narrow = sample(3)
    const w = widthsOf(wide, narrow)
    const header = telemetryCsvHeader(w)
    expect(header).toContain('q7')

    const row = telemetryCsvRow(narrow, w)
    const at = (name: string) => unquote(row[header.indexOf(name)])
    expect(row).toHaveLength(header.length)
    expect(at('q3')).toBe('0.30000000000000004')
    expect(at('q4')).toBe('') // 这一帧没有第 4 轴 —— 留白，不是把 dq1 挪上来
    expect(at('tau7')).toBe('')
    expect(at('errs')).toBe('[0,1]')
    expect(at('faults')).toBe('[{"joint":2,"errCode":9}]')

    // 宽的同行铺满同一张表，尾部不出现多余的列。
    const wideRow = telemetryCsvRow(wide, w)
    expect(wideRow).toHaveLength(header.length)
    expect(wideRow[header.indexOf('errs')]).toBe('"[0,1]"')
  })

  it('matches a row whose temperature array is shorter than its axes', () => {
    // 逐段取长度的理由：`temps` 缺失或偏短时，取一个"轴数"仍然会对不上。
    const s = sample(7, { temps: 2 })
    const w = widthsOf(s)
    expect(telemetryCsvHeader(w)).toHaveLength(telemetryCsvRow(s, w).length)
  })

  it('says nothing about temperatures when the session has none', () => {
    const s = sample(7, { temps: 0 })
    const w = widthsOf(s)
    const header = telemetryCsvHeader(w)
    expect(header).not.toContain('mos1')
    expect(header).toHaveLength(telemetryCsvRow(s, w).length)
  })
})
