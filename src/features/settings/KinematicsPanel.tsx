import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import YAML from 'yaml'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NumberField } from '@/components/ui/number-field'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  SlidersHorizontal,
  FileCode2,
  RefreshCw,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Cpu,
  Lock,
  Wrench,
} from 'lucide-react'
import type { SettingsState } from './useSettingsState'
import { JOINT_COLORS } from '@/lib/colors'

const DEFAULT_LITEARM_YAML = `robot_model:
  name: "LiteArm-7DOF"
  dof: 7
kinematics:
  dh_parameters:
    - joint: 1
      a: 0.0
      alpha: -1.5708
      d: 0.180
      theta: 0.0
    - joint: 2
      a: 0.0
      alpha: 1.5708
      d: 0.0
      theta: 0.0
    - joint: 3
      a: 0.0
      alpha: -1.5708
      d: 0.250
      theta: 0.0
    - joint: 4
      a: 0.0
      alpha: 1.5708
      d: 0.0
      theta: 0.0
    - joint: 5
      a: 0.0
      alpha: -1.5708
      d: 0.220
      theta: 0.0
    - joint: 6
      a: 0.0
      alpha: 1.5708
      d: 0.0
      theta: 0.0
    - joint: 7
      a: 0.0
      alpha: 0.0
      d: 0.120
      theta: 0.0
dynamics:
  links:
    - id: 1
      mass: 0.450
      com: [0.0, 0.0, 0.05]
      inertia: [0.0012, 0.0012, 0.0008]
    - id: 2
      mass: 0.420
      com: [0.0, 0.02, 0.04]
      inertia: [0.0010, 0.0010, 0.0007]
    - id: 3
      mass: 0.380
      com: [0.0, -0.01, 0.06]
      inertia: [0.0009, 0.0009, 0.0006]
    - id: 4
      mass: 0.350
      com: [0.0, 0.01, 0.04]
      inertia: [0.0008, 0.0008, 0.0005]
    - id: 5
      mass: 0.310
      com: [0.0, 0.0, 0.05]
      inertia: [0.0007, 0.0007, 0.0004]
    - id: 6
      mass: 0.280
      com: [0.0, 0.0, 0.03]
      inertia: [0.0005, 0.0005, 0.0003]
    - id: 7
      mass: 0.220
      com: [0.0, 0.0, 0.02]
      inertia: [0.0003, 0.0003, 0.0002]
`

type LinkDynamics = {
  id: number
  mass: number
  com: [number, number, number]
  inertia: [number, number, number]
}

type DhParams = {
  joint: number
  a: number
  alpha: number
  d: number
  theta: number
}

export function KinematicsPanel({ vm }: { vm: SettingsState }) {
  const { t } = useTranslation(['common', 'settings'])
  const [codeText, setCodeText] = useState(vm.yamlContent || DEFAULT_LITEARM_YAML)
  const [dirty, setDirty] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // 当后台抓取到最新文本且用户未修改草稿时同步
  useEffect(() => {
    if (!dirty && vm.yamlContent) {
      setCodeText(vm.yamlContent)
    }
  }, [vm.yamlContent, dirty])

  // YAML 语法解析与物理校验
  const { parsedYaml, parseError } = useMemo(() => {
    if (!codeText.trim()) {
      return { parsedYaml: null, parseError: '配置不能为空' }
    }
    try {
      const doc = YAML.parse(codeText)
      if (!doc || typeof doc !== 'object') {
        return { parsedYaml: null, parseError: 'YAML 根节点必须为对象格式' }
      }
      return { parsedYaml: doc, parseError: null }
    } catch (err: any) {
      return { parsedYaml: null, parseError: err.message || 'YAML 语法解析错误' }
    }
  }, [codeText])

  const validationResult = useMemo(() => {
    if (parseError) {
      return { valid: false, message: parseError }
    }
    if (!parsedYaml?.kinematics || !parsedYaml?.dynamics) {
      return { valid: false, message: '缺少 kinematics 或 dynamics 根级配置项' }
    }
    return { valid: true, message: t('settings:kinematics.formatValid') }
  }, [parseError, parsedYaml, t])

  // 从真实解析的 YAML 结构中提取连杆动力学与 DH 运动学数据
  const parsedData = useMemo(() => {
    const rawLinks = parsedYaml?.dynamics?.links
    const links: LinkDynamics[] = Array.from({ length: 7 }, (_, i) => {
      const raw = Array.isArray(rawLinks) ? rawLinks[i] : null
      return {
        id: i + 1,
        mass: raw?.mass != null ? Number(raw.mass) : 0.3 + (7 - i) * 0.03,
        com: [
          Number(raw?.com?.[0]) || 0,
          Number(raw?.com?.[1]) || (i === 1 ? 0.02 : i === 2 ? -0.01 : 0),
          Number(raw?.com?.[2]) || 0.03,
        ] as [number, number, number],
        inertia: [
          Number(raw?.inertia?.[0]) || 0.0008,
          Number(raw?.inertia?.[1]) || 0.0008,
          Number(raw?.inertia?.[2]) || 0.0005,
        ] as [number, number, number],
      }
    })

    const rawDh = parsedYaml?.kinematics?.dh_parameters
    const dhList: DhParams[] = Array.from({ length: 7 }, (_, i) => {
      const raw = Array.isArray(rawDh) ? rawDh[i] : null
      return {
        joint: i + 1,
        a: Number(raw?.a) || 0,
        alpha: raw?.alpha != null ? Number(raw.alpha) : i % 2 === 0 ? -1.5708 : 1.5708,
        d: raw?.d != null ? Number(raw.d) : 0.1 + i * 0.02,
        theta: Number(raw?.theta) || 0,
      }
    })

    return { links, dhList }
  }, [parsedYaml])

  // 可视化修改连杆动力学参数并双向写回 YAML 文本
  const updateLinkField = useCallback(
    (linkIdx: number, field: 'mass' | 'com', val: any) => {
      try {
        let obj = parsedYaml ? JSON.parse(JSON.stringify(parsedYaml)) : {}
        if (!obj.dynamics) obj.dynamics = {}
        if (!Array.isArray(obj.dynamics.links)) {
          obj.dynamics.links = []
        }
        while (obj.dynamics.links.length <= linkIdx) {
          const id = obj.dynamics.links.length + 1
          obj.dynamics.links.push({
            id,
            mass: 0.3,
            com: [0, 0, 0.03],
            inertia: [0.0008, 0.0008, 0.0005],
          })
        }
        obj.dynamics.links[linkIdx] = {
          ...obj.dynamics.links[linkIdx],
          id: linkIdx + 1,
          [field]: val,
        }
        setCodeText(YAML.stringify(obj, { indent: 2 }))
        setDirty(true)
      } catch (err) {
        console.error('Failed to update YAML link data:', err)
      }
    },
    [parsedYaml],
  )

  // 可视化修改 DH 参数并双向写回 YAML 文本
  const updateDhField = useCallback(
    (jointIdx: number, field: 'a' | 'alpha' | 'd' | 'theta', val: number) => {
      try {
        let obj = parsedYaml ? JSON.parse(JSON.stringify(parsedYaml)) : {}
        if (!obj.kinematics) obj.kinematics = {}
        if (!Array.isArray(obj.kinematics.dh_parameters)) {
          obj.kinematics.dh_parameters = []
        }
        while (obj.kinematics.dh_parameters.length <= jointIdx) {
          const joint = obj.kinematics.dh_parameters.length + 1
          obj.kinematics.dh_parameters.push({
            joint,
            a: 0,
            alpha: 0,
            d: 0,
            theta: 0,
          })
        }
        obj.kinematics.dh_parameters[jointIdx] = {
          ...obj.kinematics.dh_parameters[jointIdx],
          joint: jointIdx + 1,
          [field]: val,
        }
        setCodeText(YAML.stringify(obj, { indent: 2 }))
        setDirty(true)
      } catch (err) {
        console.error('Failed to update YAML DH parameter:', err)
      }
    },
    [parsedYaml],
  )

  const handleTextChange = (val: string) => {
    setCodeText(val)
    setDirty(true)
  }

  const handleResetDefault = () => {
    setCodeText(DEFAULT_LITEARM_YAML)
    setDirty(true)
  }

  const handleConfirmSave = async () => {
    setConfirmOpen(false)
    const ok = await vm.saveConfigYaml(codeText)
    if (ok) setDirty(false)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 严格安全模式提示栏 */}
      {!vm.canEdit && (
        <div className="flex items-center justify-between rounded-lg bg-muted/60 border border-border/80 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            <span>严格安全锁定：控制器未连接，运动学/动力学配置文件处于只读保护状态。请连接机械臂。</span>
          </div>
        </div>
      )}

      {/* 头部面板与双模式切换器 */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Cpu className="size-4" />
              </div>
              <div>
                <CardTitle className="text-base font-bold">{t('settings:kinematics.title')}</CardTitle>
                <CardDescription className="text-xs">
                  {t('settings:kinematics.description')}
                </CardDescription>
              </div>
            </div>

            {/* 顶部分段控制器（双模式切换） */}
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-lg bg-muted p-1 text-xs">
                <button
                  type="button"
                  onClick={() => vm.setEditorMode('visual')}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-all ${
                    vm.editorMode === 'visual'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <SlidersHorizontal className="size-3.5" />
                  {t('settings:kinematics.modeVisual')}
                </button>
                <button
                  type="button"
                  onClick={() => vm.setEditorMode('code')}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-all ${
                    vm.editorMode === 'code'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <FileCode2 className="size-3.5" />
                  {t('settings:kinematics.modeCode')}
                </button>
              </div>

              <Button
                variant="outline"
                size="icon-sm"
                onClick={vm.fetchConfigYaml}
                disabled={!vm.canEdit || vm.loadingKinematics}
                title={t('common:refresh')}
              >
                <RefreshCw className={`size-3.5 ${vm.loadingKinematics ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* 视图1：双模式——可视化表单 */}
      {vm.editorMode === 'visual' ? (
        parseError ? (
          <Card className="border border-destructive/30 bg-destructive/5 shadow-sm p-6 text-center">
            <div className="flex flex-col items-center gap-3">
              <AlertTriangle className="size-8 text-destructive" />
              <div>
                <h3 className="text-sm font-bold text-destructive">YAML 结构解析异常</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-md">
                  当前 YAML 配置包含语法错误或非标准键，无法通过可视化卡片模式进行结构化编辑：
                  <span className="block mt-1 font-mono text-destructive/90">{parseError}</span>
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => vm.setEditorMode('code')}
                className="gap-1.5 text-xs font-semibold"
              >
                <FileCode2 className="size-3.5" />
                切换至 YAML 源码编辑器进行排查
              </Button>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 7 个关节/连杆物理参数 */}
            <div className="space-y-4 lg:col-span-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {parsedData.links.map((link, idx) => {
                  const color = JOINT_COLORS[idx]
                  const dh = parsedData.dhList[idx]
                  return (
                    <Card key={link.id} className="border shadow-xs bg-card">
                      <CardHeader className="p-3 pb-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className="size-2.5 rounded-full shadow-xs"
                              style={{ backgroundColor: color }}
                            />
                            <span className="text-xs font-bold">
                              {t('settings:kinematics.jointLink', { id: link.id })}
                            </span>
                          </div>
                          <Badge variant="outline" className="text-[10px] font-mono py-0">
                            J{link.id}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3 p-3 text-xs">
                        {/* 连杆质量 */}
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-muted-foreground">
                            {t('settings:kinematics.linkMass')}
                          </label>
                          <NumberField
                            value={link.mass}
                            step={0.01}
                            min={0.01}
                            max={10.0}
                            onCommit={(v) => updateLinkField(idx, 'mass', v)}
                            disabled={!vm.canEdit}
                            className="h-8 text-xs font-mono bg-background border-border/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
                          />
                        </div>

                        {/* 质心 COM */}
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-muted-foreground">
                            COM (x, y, z) [m]
                          </label>
                          <div className="grid grid-cols-3 gap-1 font-mono text-[11px]">
                            <NumberField
                              value={link.com[0]}
                              step={0.005}
                              min={-2}
                              max={2}
                              onCommit={(v) => {
                                const nextCom: [number, number, number] = [v, link.com[1], link.com[2]]
                                updateLinkField(idx, 'com', nextCom)
                              }}
                              disabled={!vm.canEdit}
                              className="h-7 text-[11px] bg-background border-border/80"
                            />
                            <NumberField
                              value={link.com[1]}
                              step={0.005}
                              min={-2}
                              max={2}
                              onCommit={(v) => {
                                const nextCom: [number, number, number] = [link.com[0], v, link.com[2]]
                                updateLinkField(idx, 'com', nextCom)
                              }}
                              disabled={!vm.canEdit}
                              className="h-7 text-[11px] bg-background border-border/80"
                            />
                            <NumberField
                              value={link.com[2]}
                              step={0.005}
                              min={-2}
                              max={2}
                              onCommit={(v) => {
                                const nextCom: [number, number, number] = [link.com[0], link.com[1], v]
                                updateLinkField(idx, 'com', nextCom)
                              }}
                              disabled={!vm.canEdit}
                              className="h-7 text-[11px] bg-background border-border/80"
                            />
                          </div>
                        </div>

                        {/* DH 参数 [a, alpha, d, theta] */}
                        <div className="rounded-md bg-muted/40 p-2 space-y-1.5">
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground font-semibold">
                            <span>DH [a, α, d, θ]</span>
                            <Wrench className="size-2.5 text-muted-foreground/60" />
                          </div>
                          <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                            <div>
                              <span className="text-[10px] text-muted-foreground">a:</span>
                              <NumberField
                                value={dh.a}
                                step={0.01}
                                min={-5}
                                max={5}
                                onCommit={(v) => updateDhField(idx, 'a', v)}
                                disabled={!vm.canEdit}
                                className="h-6 text-[10px] bg-background border-border/70"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-muted-foreground">α:</span>
                              <NumberField
                                value={dh.alpha}
                                step={0.01}
                                min={-6.28}
                                max={6.28}
                                onCommit={(v) => updateDhField(idx, 'alpha', v)}
                                disabled={!vm.canEdit}
                                className="h-6 text-[10px] bg-background border-border/70"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-muted-foreground">d:</span>
                              <NumberField
                                value={dh.d}
                                step={0.01}
                                min={-5}
                                max={5}
                                onCommit={(v) => updateDhField(idx, 'd', v)}
                                disabled={!vm.canEdit}
                                className="h-6 text-[10px] bg-background border-border/70"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-muted-foreground">θ:</span>
                              <NumberField
                                value={dh.theta}
                                step={0.01}
                                min={-6.28}
                                max={6.28}
                                onCommit={(v) => updateDhField(idx, 'theta', v)}
                                disabled={!vm.canEdit}
                                className="h-6 text-[10px] bg-background border-border/70"
                              />
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </div>
          </div>
        )
      ) : (
        /* 视图2：双模式——原生 YAML 代码编辑器 */
        <Card className="border shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCode2 className="size-4 text-muted-foreground" />
                <span className="text-xs font-semibold">
                  {t('settings:kinematics.rawYaml')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={validationResult.valid ? 'success' : 'destructive'}
                  className="gap-1 text-[11px]"
                >
                  {validationResult.valid ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <AlertTriangle className="size-3" />
                  )}
                  {validationResult.valid
                    ? t('settings:kinematics.formatValid')
                    : t('settings:kinematics.formatInvalid')}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative rounded-lg border bg-zinc-950 p-3 font-mono text-xs text-zinc-100">
              <textarea
                value={codeText}
                onChange={(e) => handleTextChange(e.target.value)}
                disabled={!vm.canEdit}
                placeholder={t('settings:kinematics.yamlPlaceholder')}
                className="h-96 w-full resize-none border-none bg-transparent font-mono text-xs text-zinc-100 focus:outline-none focus:ring-0 leading-relaxed disabled:opacity-60"
                spellCheck={false}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* 底部操作与提交保存栏 */}
      <div className="flex items-center justify-between rounded-xl border bg-card p-4 shadow-xs">
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetDefault}
          disabled={!vm.canEdit || vm.savingKinematics}
          className="gap-1.5 text-xs text-muted-foreground font-medium"
        >
          <RotateCcw className="size-3.5" />
          {t('settings:kinematics.restoreDefaults')}
        </Button>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              disabled={!vm.canEdit || !validationResult.valid || vm.savingKinematics}
              className="gap-1.5 text-xs font-semibold"
            >
              <Save className="size-3.5" />
              {vm.savingKinematics
                ? t('common:saving')
                : t('settings:kinematics.saveYaml')}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="size-4 text-amber-500" />
                {t('settings:kinematics.saveConfirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-xs pt-1">
                {t('settings:kinematics.saveConfirmDesc')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:justify-end">
              <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
                {t('common:cancel')}
              </Button>
              <Button size="sm" onClick={handleConfirmSave} className="gap-1.5">
                <Save className="size-3.5" />
                {t('common:confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
