import { useTranslation } from 'react-i18next'
import { useSoloState } from './useSoloState'
import { PreviewPanel } from './PreviewPanel'
import { PoseCards } from './PoseCards'
import { MetricsPanel } from './MetricsPanel'
import { ControlBar } from './ControlBar'
import { JointSpacePanel } from './JointSpacePanel'
import { CartesianPanel } from './CartesianPanel'
import { GripperPanel } from './GripperPanel'
import { StopButton } from '../../components/StopButton'
import { ROW_OVERFLOW, SCROLL_COLUMN, SIDE_COL_WIDE } from '../../lib/responsive'

export function SoloConsole() {
  const vm = useSoloState()
  const simMode = vm.simMode

  return (
    <div style={{ flex: 1, display: 'flex', gap: '0.875rem', padding: '0.875rem', minHeight: '0rem', ...ROW_OVERFLOW }}>
      {/* LEFT: 状态 —— 曲线搬到右列后，剩余高度由「当前位姿」吃掉 */}
      <div style={{ ...SCROLL_COLUMN, ...SIDE_COL_WIDE, gap: '0.75rem' }}>
        <PreviewPanel viewTabs={vm.viewTabs} viewBadge={vm.viewBadge} preview={vm.preview} />
        <PoseCards jointPose={vm.poseJoint} cartPose={vm.poseCart} />
      </div>

      {/* MIDDLE: 操作 */}
      <div style={{ ...SCROLL_COLUMN, flex: '1 1 26rem', minWidth: '23rem', gap: '0.75rem' }}>
        <ControlBar
          enableBg={vm.enableBg}
          enableFg={vm.enableFg}
          enableBd={vm.enableBd}
          enableDot={vm.enableDot}
          enabled={vm.enabled}
          toggleEnable={vm.toggleEnable}
          modes={vm.modes}
          speed={vm.speed}
          setSpeed={vm.setSpeed}
          fault={vm.fault}
          faultReason={vm.faultReason}
          clearFault={vm.clearFault}
          homeJoints={vm.homeJoints}
          zeroJoints={vm.zeroJoints}
        />

        {simMode ? <SimModeBanner /> : null}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem', minHeight: '0rem' }}>
          <JointSpacePanel
            joints={vm.joints}
            releaseOnly={vm.releaseOnly}
            toggleReleaseOnly={vm.toggleReleaseOnly}
            disabled={!vm.enabled}
            onDispatch={vm.dispatchJoint}
            onDispatchAll={vm.dispatchJoints}
            radOfPct={vm.radOfPct}
          />
          <CartesianPanel
            simMode={simMode}
            cartUnsupported={vm.cartUnsupported}
            frames={vm.frames}
            frameOrigin={vm.frameOrigin}
            transCells={vm.transCells}
            rotCells={vm.rotCells}
            onJogPress={vm.onJogPress}
            onJogRelease={vm.onJogRelease}
            transSteps={vm.transSteps}
            rotSteps={vm.rotSteps}
            transStep={vm.transStep}
            rotStep={vm.rotStep}
            setTransStep={vm.setTransStep}
            setRotStep={vm.setRotStep}
            onMovelTarget={vm.movelTarget}
            onSyncCurrentPose={vm.syncCurrentTcpPose}
          />
        </div>
      </div>

      {/* RIGHT: 任务（急停常驻）+ 实时曲线 */}
      <div style={{ ...SCROLL_COLUMN, flex: '0 1 clamp(20.5rem, 25vw, 28rem)', minWidth: '20.5rem', gap: '0.75rem' }}>
        <StopButton inert={simMode} />
        <MetricsPanel
          metrics={vm.metricSeries}
          pauseLabel={vm.pauseLabel}
          togglePause={vm.togglePause}
          series={vm.series}
          shown={vm.shown}
          liveData={vm.liveData}
          simMode={vm.simMode}
          chips={vm.chips}
          selectAll={vm.selectAll}
          selectNone={vm.selectNone}
        />
        {/* 夹爪组件常驻在控制页右下角（老版本 EndEffectorControlPanel 的位置）：
            夹爪和机械臂共用一条总线，操作它不该离开这一页。 */}
        <GripperPanel />
      </div>
    </div>
  )
}

function SimModeBanner() {
  const { i18n } = useTranslation()
  const isEn = i18n.language.startsWith('en')

  return (
    <div className="flex items-center gap-2 rounded-xl border border-warn-line bg-warn-soft px-3.5 py-2.5">
      <div className="size-2 flex-none rounded-full bg-[#f5a524]" />
      <div className="text-[0.8125rem] font-medium text-warn">
        {isEn
          ? 'Simulation Mode · Local preview only: Commands are not sent to the real robot arm.'
          : '仿真模式 · 纯前端临时模拟：指令不会下发到真机，切回实机后仿真状态全部丢弃'}
      </div>
    </div>
  )
}
