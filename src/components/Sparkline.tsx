export type SparkSeed = { c: string; f: number; p: number; a: number }

/** Ports Component.sparkline(): grid lines + damped-sine polylines per joint. */
export function Sparkline({ seeds, opacity = 0.85 }: { seeds: SparkSeed[]; opacity?: number }) {
  const grid = [0.25, 0.5, 0.75]
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full">
      {grid.map((g, i) => (
        <line key={i} x1={0} x2={100} y1={g * 100} y2={g * 100} stroke="var(--border)" strokeWidth={0.4} />
      ))}
      {seeds.map((s, i) => {
        const pts: string[] = []
        for (let x = 0; x <= 40; x++) {
          const t = x / 40
          const y = 0.5 + 0.34 * s.a * Math.sin(t * (5 + s.f) + s.p) * Math.exp(-0.15 * t) * Math.cos(t * 2.3 + s.p)
          pts.push(`${(t * 100).toFixed(2)},${((1 - y) * 100).toFixed(2)}`)
        }
        return (
          <polyline
            key={i}
            points={pts.join(' ')}
            fill="none"
            stroke={s.c}
            strokeWidth={1.6}
            opacity={opacity}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
    </svg>
  )
}

/** Ports dataVals()'s wave(): a single-color mini waveform used in episode rows. */
export function Waveform({ seed, color }: { seed: number; color: string }) {
  const pts: string[] = []
  for (let i = 0; i <= 48; i++) {
    const v = Math.sin(i * 0.42 + seed) * 0.5 + Math.sin(i * 0.17 + seed * 1.7) * 0.4
    pts.push(`${((i / 48) * 100).toFixed(2)},${(11 - v * 7.5).toFixed(2)}`)
  }
  return (
    <svg viewBox="0 0 100 22" preserveAspectRatio="none" className="block size-full">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
