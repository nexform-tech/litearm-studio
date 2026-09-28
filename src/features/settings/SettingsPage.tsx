import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NumberField } from '@/components/ui/number-field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Download, RefreshCw, Save, Scale, ShieldCheck, Upload, Activity, Zap } from 'lucide-react'
import { useSettingsState, type SettingsState } from './useSettingsState'

function Section({
  title,
  desc,
  children,
}: {
  title: string
  desc: string
  children: ReactNode
}) {
  return (
    <Card className="flex flex-col gap-4 rounded-[0.875rem] p-5">
      <div>
        <h2 className="text-sm font-bold text-foreground">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      {children}
    </Card>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** 载荷：写下去之后固件会**静默钳幅**，所以显示的是读回值而不是输入值。 */
function PayloadSection({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['settings'])
  const [mass, setMass] = useState(vm.payload.mass)
  const [com, setCom] = useState<[number, number, number]>(vm.payload.com)

  useEffect(() => {
    setMass(vm.payload.mass)
    setCom(vm.payload.com)
  }, [vm.payload])

  return (
    <Section title={t('settings:payload.title')} desc={t('settings:payload.desc')}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label={t('settings:payload.mass')}>
          <NumberField value={mass} min={0} max={20} step={0.01} disabled={!vm.connected} onCommit={setMass} />
        </Field>
        <Field label={t('settings:payload.comX')}>
          <NumberField value={com[0]} min={-1} max={1} step={0.001} disabled={!vm.connected}
            onCommit={(v) => setCom([v, com[1], com[2]])} />
        </Field>
        <Field label={t('settings:payload.comY')}>
          <NumberField value={com[1]} min={-1} max={1} step={0.001} disabled={!vm.connected}
            onCommit={(v) => setCom([com[0], v, com[2]])} />
        </Field>
        <Field label={t('settings:payload.comZ')}>
          <NumberField value={com[2]} min={-1} max={1} step={0.001} disabled={!vm.connected}
            onCommit={(v) => setCom([com[0], com[1], v])} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!vm.connected || vm.saving} onClick={() => void vm.savePayload(mass, com)}>
          <Save className="size-3.5" />
          {t('settings:actions.save')}
        </Button>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">
          {t('settings:payload.effective', {
            mass: vm.payload.mass,
            com: vm.payload.com.map((v) => v.toFixed(3)).join(', '),
          })}
        </span>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{t('settings:payload.clampHint')}</p>
    </Section>
  )
}

function GravitySection({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['settings'])
  const [scale, setScale] = useState<number[]>(vm.feedForward.gravityScale)
  const [inertia, setInertia] = useState<number[]>(vm.feedForward.inertiaScale)
  const [vector, setVector] = useState<[number, number, number]>(vm.feedForward.gravityVector)

  useEffect(() => {
    setScale(vm.feedForward.gravityScale)
    setInertia(vm.feedForward.inertiaScale)
    setVector(vm.feedForward.gravityVector)
  }, [vm.feedForward])

  const edit = (list: number[], set: (v: number[]) => void, i: number, v: number) => {
    set(list.map((x, k) => (k === i ? v : x)))
  }

  // 前馈向量是**协议定长 7 通道**，不是按轴数（SDK 的 `set_ff_vec` 只收 7 个值）。
  // 这里只画这台臂**真有的**通道，`scale` / `inertia` 本身仍是完整 7 值、保存时原样发出去。
  const axes = vm.joints.length

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('settings:gravity.scaleTitle')} desc={t('settings:gravity.scaleHint')}>
        {axes === 0 ? (
          <p className="text-xs text-muted-foreground">{t('settings:gravity.empty')}</p>
        ) : (
          <div className="grid grid-cols-4 gap-2 md:grid-cols-7">
            {scale.slice(0, axes).map((v, i) => (
              <Field key={i} label={`J${i + 1}`}>
                <NumberField value={v} min={0} max={3} step={0.01} disabled={!vm.connected}
                  onCommit={(nv) => edit(scale, setScale, i, nv)} />
              </Field>
            ))}
          </div>
        )}
        {axes > 0 && axes < scale.length && (
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {t('settings:gravity.channelHint', { count: axes })}
          </p>
        )}
        <div>
          <Button size="sm" disabled={!vm.connected || vm.saving} onClick={() => void vm.saveGravityScale(scale)}>
            <Save className="size-3.5" />
            {t('settings:actions.save')}
          </Button>
        </div>
      </Section>

      <Section title={t('settings:gravity.inertiaTitle')} desc={t('settings:gravity.scaleHint')}>
        {axes === 0 ? (
          <p className="text-xs text-muted-foreground">{t('settings:gravity.empty')}</p>
        ) : (
          <div className="grid grid-cols-4 gap-2 md:grid-cols-7">
            {inertia.slice(0, axes).map((v, i) => (
              <Field key={i} label={`J${i + 1}`}>
                <NumberField value={v} min={0} max={3} step={0.01} disabled={!vm.connected}
                  onCommit={(nv) => edit(inertia, setInertia, i, nv)} />
              </Field>
            ))}
          </div>
        )}
        <div>
          <Button size="sm" disabled={!vm.connected || vm.saving} onClick={() => void vm.saveInertiaScale(inertia)}>
            <Save className="size-3.5" />
            {t('settings:actions.save')}
          </Button>
        </div>
      </Section>

      <Section title={t('settings:gravity.vectorTitle')} desc={t('settings:gravity.vectorHint')}>
        <div className="grid grid-cols-3 gap-3 md:max-w-md">
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <Field key={axis} label={axis}>
              <NumberField value={vector[i]} min={-1} max={1} step={0.001} disabled={!vm.connected}
                onCommit={(nv) => setVector(vector.map((x, k) => (k === i ? nv : x)) as [number, number, number])} />
            </Field>
          ))}
        </div>
        <div>
          <Button size="sm" disabled={!vm.connected || vm.saving} onClick={() => void vm.saveGravityVector(vector)}>
            <Save className="size-3.5" />
            {t('settings:actions.save')}
          </Button>
        </div>
      </Section>
    </div>
  )
}

function JointsSection({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['settings'])
  // 行数 = `get_joint_params` 真正返回的条数（daemon 侧是 `range(arm.n)`）。
  // 以前写死 7：`{1J}` 台架上 J2…J7 全是 `undefined`，渲染成一排 0、保存按钮被禁用，
  // 看起来像"参数只加载了一半"（issue #42）。
  const rows = vm.joints
  const [draft, setDraft] = useState<Record<number, Partial<Record<'kp' | 'kd' | 'tau_max' | 'q_min' | 'q_max', number>>>>({})

  useEffect(() => setDraft({}), [vm.joints])

  const valueOf = (i: number, key: 'kp' | 'kd' | 'tau_max' | 'q_min' | 'q_max', fallback: number) =>
    draft[i]?.[key] ?? fallback

  const setField = (i: number, key: 'kp' | 'kd' | 'tau_max' | 'q_min' | 'q_max', v: number) =>
    setDraft((prev) => ({ ...prev, [i]: { ...prev[i], [key]: v } }))

  return (
    <Section title={t('settings:joints.title')} desc={t('settings:joints.desc')}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('settings:joints.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[0.6875rem] text-muted-foreground">
              <tr>
                <th className="py-1 text-left">{t('settings:joints.joint')}</th>
                <th className="py-1 text-left">Kp</th>
                <th className="py-1 text-left">Kd</th>
                <th className="py-1 text-left">tau_max</th>
                <th className="py-1 text-left">{t('settings:joints.qMin')}</th>
                <th className="py-1 text-left">{t('settings:joints.qMax')}</th>
                <th className="py-1 text-right">{t('settings:actions.save')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((jp, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1.5 pr-2 font-mono font-semibold">J{i + 1}</td>
                  {(['kp', 'kd', 'tau_max'] as const).map((key) => (
                    <td key={key} className="py-1.5 pr-2">
                      <NumberField value={valueOf(i, key, jp[key])} min={0} max={500} step={0.1}
                        disabled={!vm.connected}
                        onCommit={(v) => setField(i, key, v)}
                        className="w-20" />
                    </td>
                  ))}
                  {(['q_min', 'q_max'] as const).map((key) => (
                    <td key={key} className="py-1.5 pr-2">
                      <NumberField value={valueOf(i, key, jp[key])} min={-Math.PI * 2} max={Math.PI * 2} step={0.001}
                        disabled={!vm.connected}
                        onCommit={(v) => setField(i, key, v)}
                        className="w-24" />
                    </td>
                  ))}
                  <td className="py-1.5 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!vm.connected || vm.saving}
                      onClick={() => {
                        const d = draft[i]
                        if (d?.kp != null || d?.kd != null || d?.tau_max != null) {
                          void vm.saveJointParam(i, valueOf(i, 'kp', jp.kp), valueOf(i, 'kd', jp.kd), valueOf(i, 'tau_max', jp.tau_max))
                        }
                        if (d?.q_min != null || d?.q_max != null) {
                          void vm.saveJointLimits(i, valueOf(i, 'q_min', jp.q_min), valueOf(i, 'q_max', jp.q_max))
                        }
                      }}
                    >
                      <Save className="size-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" disabled={!vm.connected || vm.saving} onClick={() => void vm.saveParams()}>
          <Download className="size-3.5" />
          {t('settings:joints.persist')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!vm.connected || vm.saving}
          onClick={() => {
            if (window.confirm(t('settings:joints.factoryConfirm'))) void vm.resetFactoryParams()
          }}
        >
          <Upload className="size-3.5" />
          {t('settings:joints.factory')}
        </Button>
        <span className="text-[0.6875rem] text-muted-foreground">{t('settings:joints.persistHint')}</span>
      </div>
    </Section>
  )
}

function DiagnosticsSection({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['settings'])
  const entries = vm.kinBench
    ? Object.entries(vm.kinBench).filter(([k]) => k !== 'ok')
    : []
  return (
    <Section title={t('settings:diagnostics.title')} desc={t('settings:diagnostics.desc')}>
      <div>
        <Button size="sm" disabled={!vm.connected || vm.saving} onClick={() => void vm.runSelfTest()}>
          <Activity className="size-3.5" />
          {t('settings:diagnostics.run')}
        </Button>
      </div>
      {vm.kinBench == null ? (
        <p className="text-xs text-muted-foreground">{t('settings:diagnostics.empty')}</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-t">
                <td className="py-1.5 pr-4 font-mono text-muted-foreground">{k}</td>
                <td className="py-1.5 font-mono font-semibold text-foreground">
                  {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

export function SettingsPage() {
  const { t } = useTranslation(['common', 'settings'])
  const vm = useSettingsState()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/10 p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">{t('settings:header.title')}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('settings:header.description')}</p>
          </div>
          <div className="flex items-center gap-2">
            {vm.connected ? (
              <Badge variant="success" className="gap-1.5 py-1 text-xs">
                <span className="size-2 rounded-full bg-success" />
                {t('common:connected')}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 py-1 text-xs text-muted-foreground">
                <ShieldCheck className="size-3" />
                {t('common:statusOffline')}
              </Badge>
            )}
            <Button size="sm" variant="outline" disabled={!vm.connected || vm.loading} onClick={() => void vm.refresh()}>
              <RefreshCw className={vm.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {t('settings:actions.read')}
            </Button>
          </div>
        </div>

        <Tabs defaultValue="payload" className="w-full space-y-4">
          <TabsList className="grid h-11 w-full grid-cols-2 rounded-xl bg-muted/60 p-1 md:grid-cols-4">
            <TabsTrigger value="payload" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Scale className="size-3.5" />
              {t('settings:tabs.payload')}
            </TabsTrigger>
            <TabsTrigger value="gravity" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Zap className="size-3.5" />
              {t('settings:tabs.gravity')}
            </TabsTrigger>
            <TabsTrigger value="joints" className="gap-1.5 rounded-lg text-xs font-semibold">
              <ShieldCheck className="size-3.5" />
              {t('settings:tabs.joints')}
            </TabsTrigger>
            <TabsTrigger value="diagnostics" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Activity className="size-3.5" />
              {t('settings:tabs.diagnostics')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="payload" className="focus-visible:outline-none">
            <PayloadSection vm={vm} />
          </TabsContent>
          <TabsContent value="gravity" className="focus-visible:outline-none">
            <GravitySection vm={vm} />
          </TabsContent>
          <TabsContent value="joints" className="focus-visible:outline-none">
            <JointsSection vm={vm} />
          </TabsContent>
          <TabsContent value="diagnostics" className="focus-visible:outline-none">
            <DiagnosticsSection vm={vm} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
