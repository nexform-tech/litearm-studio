import type { TelemetrySample } from './telemetryDb'

function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function telemetryCsvHeader(nJoints = 7): string[] {
  const cols = ['ts', 'state']
  for (let i = 0; i < nJoints; i++) cols.push(`q${i + 1}`)
  for (let i = 0; i < nJoints; i++) cols.push(`dq${i + 1}`)
  for (let i = 0; i < nJoints; i++) cols.push(`tau${i + 1}`)
  for (let i = 0; i < nJoints; i++) cols.push(`mos${i + 1}`)
  for (let i = 0; i < nJoints; i++) cols.push(`coil${i + 1}`)
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
