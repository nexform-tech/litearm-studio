import type { TelemetrySample } from './telemetryDb'

function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * 表头 —— 每段列数**从这一条样本身上读**，不从一个假定值来。
 *
 * ⚠ 这里曾经是 `telemetryCsvHeader(nJoints = 7)`，而唯一的调用点**没传参**。表头因此
 * 恒为 7 轴，行却按设备实际的轴数写（见 `telemetryCsvRow`：它按各数组自己的长度铺开）。
 * 少轴的台架上两者对不上号 —— `errs` 那一列会落到 `dq1` 的标题下面，之后每一列都错位，
 * 而表面上看只是一份"列名很多"的正常 CSV。
 *
 * 所以判据只能是**同一份数据**：表头与行都由 `sample` 决定，就不存在两处各写一遍
 * 然后悄悄漂开的可能。逐段取长度而不是取一个"轴数"，连 `temps` 缺失也能对上。
 */
export function telemetryCsvHeader(sample: TelemetrySample): string[] {
  const cols = ['ts', 'state']
  for (let i = 0; i < sample.q.length; i++) cols.push(`q${i + 1}`)
  for (let i = 0; i < sample.dq.length; i++) cols.push(`dq${i + 1}`)
  for (let i = 0; i < sample.tau.length; i++) cols.push(`tau${i + 1}`)
  const temps = sample.temps ?? []
  for (let i = 0; i < temps.length; i++) cols.push(`mos${i + 1}`)
  for (let i = 0; i < temps.length; i++) cols.push(`coil${i + 1}`)
  cols.push('errs', 'faults')
  return cols
}

export function telemetryCsvRow(sample: TelemetrySample): string[] {
  const row: Array<string | number | null> = [sample.ts, sample.state]
  row.push(...sample.q)
  row.push(...sample.dq)
  row.push(...sample.tau)
  row.push(...(sample.temps ?? []).map((t) => t?.mosTemp ?? 0))
  row.push(...(sample.temps ?? []).map((t) => t?.coilTemp ?? 0))
  row.push(JSON.stringify(sample.errs))
  row.push(JSON.stringify(sample.faults))
  return row.map(csvField)
}
