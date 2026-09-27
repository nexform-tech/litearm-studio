import { describe, expect, it } from 'vitest'
import { normalizeControllerLogs } from './useControllerLogsState'

describe('normalizeControllerLogs', () => {
  it('accepts an items array with timestamp/level/message fields', () => {
    const raw = {
      items: [
        { timestamp: '2026-08-21T10:00:00', level: 'error', message: 'motion timeout', logger: 'litearm_server.motion' },
        { timestamp: '2026-08-21T10:00:01', level: 'INFO', message: 'started' },
      ],
      total: 2,
    }
    const { items, total } = normalizeControllerLogs(raw)
    expect(total).toBe(2)
    expect(items[0]).toMatchObject({ level: 'ERROR', message: 'motion timeout', logger: 'litearm_server.motion' })
    expect(items[1].level).toBe('INFO')
  })

  it('accepts a logs array and common field aliases', () => {
    const { items, total } = normalizeControllerLogs({
      logs: [{ ts: 'x', severity: 'warning', msg: 'limit hit' }],
    })
    expect(total).toBe(1)
    expect(items[0]).toMatchObject({ timestamp: 'x', level: 'WARNING', message: 'limit hit' })
  })

  it('falls back gracefully for unknown shapes', () => {
    expect(normalizeControllerLogs(null)).toEqual({ items: [], total: 0 })
    expect(normalizeControllerLogs({ foo: 1 })).toEqual({ items: [], total: 0 })
    expect(normalizeControllerLogs([])).toEqual({ items: [], total: 0 })
  })
})
