import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NumberField } from '@/components/ui/number-field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Check, Compass, Download, HardDriveDownload, Info, RefreshCw, Save, Scale, ShieldCheck, TriangleAlert, Upload, Activity, Grip, KeyRound } from 'lucide-react'
import { useSettingsState, type SettingsState } from './useSettingsState'
import {
  gravityFromRpy,
  gravityMagnitude,
  INSTALLATION_POSES,
  installationPoseById,
  isStandardMagnitude,
  matchInstallationPose,
  STANDARD_GRAVITY,
  type InstallationPoseId,
} from './installationPose'
import { GripperSection } from './GripperSection'
import { ActivationSection } from './ActivationSection'
import { FirmwareSection } from './FirmwareSection'

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

const RPY_AXES = ['roll', 'pitch', 'yaw'] as const
const GRAVITY_AXES = ['x', 'y', 'z'] as const

/** 带符号的定点显示：`+0.0000` / `-9.8100`（「设备当前」那一行照抄固件面板的写法）。 */
function signed(v: number): string {
  const n = Math.abs(v) < 5e-5 ? 0 : v
  return `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(4)}`
}

/** 读回值对应的 rpy —— 命中预设才拿得到那组装角，否则只能是从零开始的草稿。 */
function rpyForRead(read: readonly number[]): [number, number, number] {
  const pose = matchInstallationPose(read)
  return pose ? [...installationPoseById(pose).rpy] : [0, 0, 0]
}

/** 标签在**左边**、输入框在右边的窄字段（安装姿态那一行是并排的，不是上下）。 */
function InlineField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="font-mono text-[0.6875rem] text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/**
 * 安装方向 —— 预设只填草稿，点「下发」才写固件（与页面上其它写入一致）。
 *
 * 三种值必须分开看，混在一起就会骗人：
 *   · `vector`           —— 草稿，将要下发的那三个数；
 *   · `vm.gravityVector` —— 固件里**现在**生效的读回值（「设备当前」那一行）；
 *   · `rpy`              —— 安装姿态。它只在草稿上成立；向量被手改过之后
 *                            rpy 不再描述它，标成「自定义」（反向不唯一，不做反解）。
 *
 * 「设备当前」读的必须是读回值而不是草稿：选了预设还没下发时，它得还能看见固件里
 * 现在是什么装法 —— 否则操作员会以为已经改完了。
 */
function InstallationSection({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['settings'])
  const [rpy, setRpy] = useState<[number, number, number]>(() => rpyForRead(vm.gravityVector))
  const [vector, setVector] = useState<[number, number, number]>(vm.gravityVector)
  const [rpyCustom, setRpyCustom] = useState(() => matchInstallationPose(vm.gravityVector) === null)
  /**
   * 操作员**显式**选了「自定义」。
   *
   * ⚠ 它和 `draftPose === null`("这组数不属于任何预设")不是一回事, 两个都要: 选了侧装+x
   * 之后, 向量本来就命中预设, 只靠匹配结果就永远回不到「自定义」——那样这块牌子就是一张
   * 单向门。任何一条"数值有来源"的路径 (点预设 / 改 rpy / 读回) 都会把它清掉。
   */
  const [custom, setCustom] = useState(false)

  // 读回值变了（刚连上、点了「读当前」、下发后的读回）就跟着走。
  useEffect(() => {
    setVector(vm.gravityVector)
    const pose = matchInstallationPose(vm.gravityVector)
    if (pose) setRpy([...installationPoseById(pose).rpy])
    setRpyCustom(pose === null)
    setCustom(false)
  }, [vm.gravityVector])

  const pickPose = (id: InstallationPoseId) => {
    const pose = installationPoseById(id)
    setRpy([...pose.rpy])
    setVector([...pose.gravity])
    setRpyCustom(false)
    setCustom(false)
  }

  const editRpy = (i: number, v: number) => {
    const next = rpy.map((x, k) => (k === i ? v : x)) as [number, number, number]
    setRpy(next)
    setVector(gravityFromRpy(next))
    setRpyCustom(false)
    // 向量现在由 rpy 推导 ⇒ 不再算"自定义", 落到它真正对应的预设上 (可能一个都不是)。
    setCustom(false)
  }

  const editVector = (i: number, v: number) => {
    setVector(vector.map((x, k) => (k === i ? v : x)) as [number, number, number])
    setRpyCustom(true)
    setCustom(true)
  }

  const poseLabel = (id: InstallationPoseId | null) =>
    id ? t(`settings:installation.pose.${id}`) : t('settings:installation.custom')

  const draftPose = matchInstallationPose(vector)
  const devicePose = matchInstallationPose(vm.gravityVector)
  const deviceKnown = gravityMagnitude(vm.gravityVector) > 0
  const magnitude = gravityMagnitude(vector)
  const magnitudeOk = isStandardMagnitude(vector)

  const segmentStyles = {
    containerStyle: {
      display: 'flex' as const,
      flexWrap: 'wrap' as const,
      gap: '0.1875rem',
      background: 'var(--line-soft)',
      borderRadius: '0.5625rem',
      padding: '0.1875rem',
    },
    itemStyle: {
      padding: '0.3125rem 0.875rem',
      borderRadius: '0.4375rem',
      fontSize: '0.75rem',
      color: 'var(--ink-subtle)',
      fontWeight: 500,
    },
    activeItemStyle: {
      background: 'var(--seg-active)',
      color: 'var(--ink)',
      fontWeight: 600,
      boxShadow: '0 0.0625rem 0.125rem rgba(16,24,40,.08)',
    },
  }

  return (
    <Card className="flex flex-col gap-4 rounded-[0.875rem] p-5">
      {/* 固件里的现状，与下面的草稿分开说 —— 这两行说的是两件事。 */}
      <p
        className={`flex items-center gap-1.5 text-xs ${
          deviceKnown ? 'text-[var(--info)]' : 'text-muted-foreground'
        }`}
      >
        <Info className="size-3.5 flex-none" />
        {deviceKnown
          ? t('settings:installation.readLine', { pose: poseLabel(devicePose) })
          : t('settings:installation.notRead')}
      </p>

      <div className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-semibold text-foreground">
          {t('settings:installation.stepChoose')}
        </h3>
        <SegmentedControl
          ariaLabel={t('settings:installation.stepChoose')}
          items={[
            ...INSTALLATION_POSES.map((pose) => ({
              key: pose.id,
              label: t(`settings:installation.pose.${pose.id}`),
              active: !custom && draftPose === pose.id,
              onClick: () => pickPose(pose.id),
            })),
            // 「自定义」是能点的: 它是一个"这次不用预设"的选择, 而不是一块只能看的牌子。
            // 选了预设之后想改回自定义, 点这里就退出预设 —— 只是**不清掉数字**, 那三个数
            // 正好是接着改的起点。
            {
              key: 'custom',
              label: t('settings:installation.custom'),
              active: custom || draftPose === null,
              onClick: () => setCustom(true),
            },
          ]}
          {...segmentStyles}
        />
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          {t('settings:installation.presetHint')}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-line-soft pt-3.5">
        <h3 className="text-[0.8125rem] font-semibold text-foreground">
          {t('settings:installation.stepPose')}
        </h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* ⚠ 前缀是 `<span>` 而不是 `<label>`: 每个轴自己已经是 label, 嵌套 label 会把
              输入框的关联关系搞乱 (点 "base_rpy" 也会跳进第一个框)。 */}
          <span className="font-mono text-[0.6875rem] text-muted-foreground">base_rpy</span>
          {RPY_AXES.map((axis, i) => (
            <InlineField key={axis} label={axis}>
              <NumberField
                value={rpy[i]}
                min={-Math.PI}
                max={Math.PI}
                step={0.0001}
                digits={4}
                disabled={!vm.connected}
                onCommit={(v) => editRpy(i, v)}
                className="h-7 w-[7rem] font-mono text-xs"
              />
            </InlineField>
          ))}
          {rpyCustom ? (
            <span className="text-[0.6875rem] text-muted-foreground">
              {t('settings:installation.rpyCustom')}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-[0.6875rem] text-muted-foreground">gravity</span>
          {GRAVITY_AXES.map((axis, i) => (
            <InlineField key={axis} label={axis}>
              <NumberField
                value={vector[i]}
                min={-STANDARD_GRAVITY}
                max={STANDARD_GRAVITY}
                step={0.0001}
                digits={4}
                disabled={!vm.connected}
                onCommit={(v) => editVector(i, v)}
                className="h-7 w-[7rem] font-mono text-xs"
              />
            </InlineField>
          ))}
          <span
            className={`flex items-center gap-1 font-mono text-xs ${
              magnitudeOk ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'
            }`}
            title={
              magnitudeOk
                ? t('settings:installation.magnitudeOk')
                : t('settings:installation.magnitudeOff')
            }
          >
            |g| = {magnitude.toFixed(4)}
            {magnitudeOk ? <Check className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
          </span>
        </div>
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          {t('settings:installation.rpyHint')}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-line-soft pt-3.5">
        <h3 className="text-[0.8125rem] font-semibold text-foreground">
          {t('settings:installation.stepApply')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!vm.connected || vm.loading}
            onClick={() => void vm.readGravity()}
          >
            <RefreshCw className={vm.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('settings:installation.readCurrent')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!vm.connected || vm.saving || vm.enabled}
            title={vm.enabled ? t('settings:installation.armedHint') : undefined}
            onClick={() => void vm.saveGravityVector(vector)}
          >
            <Upload className="size-3.5" />
            {t('settings:installation.send')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!vm.connected || vm.saving}
            title={t('settings:installation.persistTitle')}
            onClick={() => void vm.saveParams()}
          >
            <Download className="size-3.5" />
            {t('settings:installation.persist')}
          </Button>
        </div>
        {vm.enabled ? (
          <p className="text-[0.6875rem] leading-relaxed text-amber-700 dark:text-amber-400">
            {t('settings:installation.armedHint')}
          </p>
        ) : null}
        <p className="font-mono text-[0.6875rem] text-muted-foreground">
          {t('settings:installation.effective', {
            vector: vm.gravityVector.map(signed).join(', '),
            pose: poseLabel(devicePose),
            magnitude: gravityMagnitude(vm.gravityVector).toFixed(4),
          })}
        </p>
      </div>
    </Card>
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

/** 页签 id —— 与下面每个 `TabsTrigger value` 一一对应。 */
const TAB_IDS = ['payload', 'installation', 'joints', 'diagnostics', 'gripper', 'activation', 'firmware'] as const
const DEFAULT_TAB = 'payload'

/**
 * 旧页签 id 的别名。
 *
 * ⚠ 「重力与惯量」在界面上被「安装方向」整个换掉了（`?tab=gravity` ⇒ `installation`）:
 * 这个查询串会出现在说明书、聊天记录和书签里, 让老链接掉回「末端负载」等于告诉
 * 操作员"这个功能没了"。
 */
const TAB_ALIASES: Record<string, string> = { gravity: 'installation' }

/**
 * 从 URL 的 `?tab=` 取页签。
 *
 * ⚠ 认不出的值**退回默认**，不报错也不白屏：这个查询串是别人给的（说明书、聊天记录、
 * 书签），拼错一个字母不该让整页打不开。`/settings?tab=activation` 是文档与支持话术里
 * 反复出现的入口 —— 界面上「未激活」那条提示指的就是授权激活。
 */
function initialTab(params: URLSearchParams): string {
  const wanted = params.get('tab') ?? ''
  const resolved = TAB_ALIASES[wanted] ?? wanted
  return (TAB_IDS as readonly string[]).includes(resolved) ? resolved : DEFAULT_TAB
}

export function SettingsPage() {
  const { t } = useTranslation(['common', 'settings'])
  const [searchParams, setSearchParams] = useSearchParams()
  const vm = useSettingsState()
  const tab = initialTab(searchParams)

  /**
   * 切页签 → **写回 URL**。
   *
   * ⚠ 只读不写是不够的：那样 `?tab=` 只是 `defaultValue` 的初值，操作员切到
   * 「固件升级」再刷新会掉回默认页签，看上去像那次切换根本没生效。
   *
   * `replace: true`：页签是同一个页面的视图切换，不该往历史里堆 —— 否则按「返回」
   * 得在页签之间走一遍才离得开设置页。
   */
  const selectTab = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('tab', next)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

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

        <Tabs value={tab} onValueChange={selectTab} className="w-full space-y-4">
          <TabsList className="grid h-11 w-full grid-cols-2 rounded-xl bg-muted/60 p-1 md:grid-cols-7">
            <TabsTrigger value="payload" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Scale className="size-3.5" />
              {t('settings:tabs.payload')}
            </TabsTrigger>
            <TabsTrigger value="installation" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Compass className="size-3.5" />
              {t('settings:tabs.installation')}
            </TabsTrigger>
            <TabsTrigger value="joints" className="gap-1.5 rounded-lg text-xs font-semibold">
              <ShieldCheck className="size-3.5" />
              {t('settings:tabs.joints')}
            </TabsTrigger>
            <TabsTrigger value="diagnostics" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Activity className="size-3.5" />
              {t('settings:tabs.diagnostics')}
            </TabsTrigger>
            <TabsTrigger value="gripper" className="gap-1.5 rounded-lg text-xs font-semibold">
              <Grip className="size-3.5" />
              {t('settings:tabs.gripper')}
            </TabsTrigger>
            <TabsTrigger value="activation" className="gap-1.5 rounded-lg text-xs font-semibold">
              <KeyRound className="size-3.5" />
              {t('settings:tabs.activation')}
            </TabsTrigger>
            <TabsTrigger value="firmware" className="gap-1.5 rounded-lg text-xs font-semibold">
              <HardDriveDownload className="size-3.5" />
              {t('settings:tabs.firmware')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="payload" className="focus-visible:outline-none">
            <PayloadSection vm={vm} />
          </TabsContent>
          <TabsContent value="installation" className="focus-visible:outline-none">
            <InstallationSection vm={vm} />
          </TabsContent>
          <TabsContent value="joints" className="focus-visible:outline-none">
            <JointsSection vm={vm} />
          </TabsContent>
          <TabsContent value="diagnostics" className="focus-visible:outline-none">
            <DiagnosticsSection vm={vm} />
          </TabsContent>
          <TabsContent value="gripper" className="focus-visible:outline-none">
            <GripperSection />
          </TabsContent>
          <TabsContent value="activation" className="focus-visible:outline-none">
            <ActivationSection />
          </TabsContent>
          <TabsContent value="firmware" className="focus-visible:outline-none">
            <FirmwareSection />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
