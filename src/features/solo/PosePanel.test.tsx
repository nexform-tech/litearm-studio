import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { PosePanel, type PoseRow } from './PosePanel'

afterEach(cleanup)

/** 7 轴：与 `useSoloState` 交给面板的顺序一致（J1…Jn）。 */
const joint: PoseRow[] = Array.from({ length: 7 }, (_, i) => ({ k: `J${i + 1}`, v: `0.00${i}`, u: 'rad' }))

/** 笛卡尔：daemon `get_tcp` 的原生顺序，先位置后姿态。 */
const cart: PoseRow[] = [
  { k: 'X', v: '0.3241', u: 'm' },
  { k: 'Y', v: '-0.0182', u: 'm' },
  { k: 'Z', v: '0.4870', u: 'm' },
  { k: 'RX', v: '0.0000', u: 'rad' },
  { k: 'RY', v: '1.5701', u: 'rad' },
  { k: 'RZ', v: '-0.0004', u: 'rad' },
]

describe('PosePanel', () => {
  it('shows the joint and Cartesian readings side by side in a single card', () => {
    render(<PosePanel jointPose={joint} cartPose={cart} />)

    expect(screen.getByText(i18n.t('solo:pose.title'))).toBeTruthy()
    // 两栏同时可见：关节角与 TCP 位姿不再靠页签二选一。
    for (let n = 1; n <= 7; n++) expect(screen.getByText(i18n.t('solo:pose.jointLabel', { n }))).toBeTruthy()
    for (const row of cart) expect(screen.getByText(`${row.k}:`)).toBeTruthy()
    expect(screen.getByText('0.3241')).toBeTruthy()
    expect(screen.getByText('1.5701')).toBeTruthy()
  })

  it('says the Cartesian pose is unavailable instead of inventing a value', () => {
    render(<PosePanel jointPose={joint} cartPose={null} />)

    expect(screen.getByText(i18n.t('solo:cartesian.poseUnavailable'))).toBeTruthy()
    expect(screen.queryByText('RX:')).toBeNull()
    // 关节读数不受影响。
    expect(screen.getByText(i18n.t('solo:pose.jointLabel', { n: 7 }))).toBeTruthy()
  })
})
