/** 遥测保留上限（MB）的用户设置：范围 10–500MB，默认 10MB，localStorage 持久化。 */
export const RETENTION_MIN_MB = 10
export const RETENTION_MAX_MB = 500
export const RETENTION_DEFAULT_MB = 10
const RETENTION_MB_STORAGE_KEY = 'litearm-studio:telemetry-retention-mb'
const LEGACY_STORAGE_KEY = 'litearm-console:telemetry-retention-mb'

export function clampRetentionMb(mb: number): number {
  if (!Number.isFinite(mb)) return RETENTION_DEFAULT_MB
  return Math.min(RETENTION_MAX_MB, Math.max(RETENTION_MIN_MB, Math.round(mb)))
}

export function getRetentionMb(): number {
  try {
    const raw =
      window.localStorage.getItem(RETENTION_MB_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (raw === null) return RETENTION_DEFAULT_MB
    const n = Number(raw)
    if (!Number.isFinite(n)) return RETENTION_DEFAULT_MB
    return clampRetentionMb(n)
  } catch {
    return RETENTION_DEFAULT_MB
  }
}

export function setRetentionMb(mb: number): number {
  const clamped = clampRetentionMb(mb)
  try {
    window.localStorage.setItem(RETENTION_MB_STORAGE_KEY, String(clamped))
  } catch {
    // 忽略写入失败（隐私模式/配额不足），仅本次生效
  }
  return clamped
}

export function retentionMbToBytes(mb: number): number {
  return mb * 1024 * 1024
}
