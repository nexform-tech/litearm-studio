import type { TelemetrySample } from './telemetryDb'

function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * 导出时每一段数组占多少列 —— 逐段记，不折算成一个"轴数"。
 *
 * ⚠ 宽度不能只看一条样本：一次会话是**断线 30s 内重连就延续**的（见
 * `telemetryRecorder`），其间换过台架（7J → 1J）就会让同一个文件里出现两种宽度的行。
 * 表头只写一次，所以它的宽度必须是**整段会话里每一段的上限**，行再按同一组宽度铺开
 * （窄的留白）—— 这样 `errs`/`faults` 才不会串到别人的标题下面去。
 */
export type CsvWidths = { q: number; dq: number; tau: number; temps: number }

/** 导出前的初值：0 表示这一段一列都还没有。 */
export const EMPTY_CSV_WIDTHS: CsvWidths = { q: 0, dq: 0, tau: 0, temps: 0 }

/** 把一条样本并进列宽：逐段取最大值。 */
export function mergeCsvWidths(acc: CsvWidths, sample: TelemetrySample): CsvWidths {
  return {
    q: Math.max(acc.q, sample.q.length),
    dq: Math.max(acc.dq, sample.dq.length),
    tau: Math.max(acc.tau, sample.tau.length),
    temps: Math.max(acc.temps, (sample.temps ?? []).length),
  }
}

/**
 * 表头 —— 每段列数从**这组宽度**来，而宽度是从同一次导出的那批样本身上量的。
 *
 * ⚠ 这里曾经是 `telemetryCsvHeader(nJoints = 7)`，而唯一的调用点**没传参**。表头因此
 * 恒为 7 轴，行却按设备实际的轴数写（见 `telemetryCsvRow`）。少轴的台架上两者对不上
 * 号 —— `errs` 那一列会落到 `dq1` 的标题下面，之后每一列都错位，而表面上看只是一份
 * "列名很多"的正常 CSV。
 */
export function telemetryCsvHeader(widths: CsvWidths): string[] {
  const cols = ['ts', 'state']
  for (let i = 0; i < widths.q; i++) cols.push(`q${i + 1}`)
  for (let i = 0; i < widths.dq; i++) cols.push(`dq${i + 1}`)
  for (let i = 0; i < widths.tau; i++) cols.push(`tau${i + 1}`)
  for (let i = 0; i < widths.temps; i++) cols.push(`mos${i + 1}`)
  for (let i = 0; i < widths.temps; i++) cols.push(`coil${i + 1}`)
  cols.push('errs', 'faults')
  return cols
}

export function telemetryCsvRow(sample: TelemetrySample, widths: CsvWidths): string[] {
  const row: Array<string | number | null> = [sample.ts, sample.state]
  pushSection(row, sample.q, widths.q)
  pushSection(row, sample.dq, widths.dq)
  pushSection(row, sample.tau, widths.tau)
  pushSection(row, (sample.temps ?? []).map((t) => t?.mosTemp ?? 0), widths.temps)
  pushSection(row, (sample.temps ?? []).map((t) => t?.coilTemp ?? 0), widths.temps)
  row.push(JSON.stringify(sample.errs))
  row.push(JSON.stringify(sample.faults))
  return row.map(csvField)
}

/**
 * 一段值铺到 `width` 列：这条样本自己不够长的部分留空。
 *
 * ⚠ 留空，不是让后面的段整体左移 —— 少了轴的样本里，`errs`/`faults` 仍要落在自己的
 * 标题下；"这一轴这一帧没有值"与"文件串列了"是两件完全不同的事。
 */
function pushSection(
  row: Array<string | number | null>,
  values: Array<string | number | null>,
  width: number,
): void {
  for (let i = 0; i < width; i++) row.push(i < values.length ? values[i] : '')
}
