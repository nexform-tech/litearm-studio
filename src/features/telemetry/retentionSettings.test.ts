import { beforeEach, describe, expect, it } from 'vitest'
import {
  RETENTION_DEFAULT_MB,
  RETENTION_MAX_MB,
  RETENTION_MIN_MB,
  clampRetentionMb,
  getRetentionMb,
  retentionMbToBytes,
  setRetentionMb,
} from './retentionSettings'

describe('retentionSettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to 10MB when nothing is stored', () => {
    expect(RETENTION_DEFAULT_MB).toBe(10)
    expect(getRetentionMb()).toBe(RETENTION_DEFAULT_MB)
  })

  it('clamps to the min/max range', () => {
    expect(RETENTION_MIN_MB).toBe(10)
    expect(RETENTION_MAX_MB).toBe(500)
    expect(clampRetentionMb(1)).toBe(RETENTION_MIN_MB)
    expect(clampRetentionMb(9999)).toBe(RETENTION_MAX_MB)
    expect(clampRetentionMb(37.4)).toBe(37)
    expect(clampRetentionMb(Number.NaN)).toBe(RETENTION_DEFAULT_MB)
  })

  it('persists and restores the setting', () => {
    setRetentionMb(80)
    expect(getRetentionMb()).toBe(80)
  })

  it('falls back to the default for invalid stored values', () => {
    localStorage.setItem('litearm-studio:telemetry-retention-mb', 'not-a-number')
    expect(getRetentionMb()).toBe(RETENTION_DEFAULT_MB)
  })

  it('reads legacy storage key when new key is not set', () => {
    localStorage.setItem('litearm-console:telemetry-retention-mb', '120')
    expect(getRetentionMb()).toBe(120)
  })

  it('converts MB to bytes', () => {
    expect(retentionMbToBytes(10)).toBe(10 * 1024 * 1024)
    expect(retentionMbToBytes(500)).toBe(500 * 1024 * 1024)
  })
})
