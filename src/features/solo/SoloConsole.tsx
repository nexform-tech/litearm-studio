import { useTranslation } from 'react-i18next'
import { useSoloState } from './useSoloState'
import { PreviewPanel } from './PreviewPanel'
import { PosePanel } from './PosePanel'
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
      {/* LEFT: 状态 —— 3D 吃掉剩余高度，关节与笛卡尔合成一张卡，曲线压扁垫在最底下 */}
      <div style={{ ...SCROLL_COLUMN, ...SIDE_COL_WIDE, gap: '0.75rem' }}>
        <PreviewPanel viewTabs={vm.viewTabs} viewBadge={vm.viewBadge} preview={vm.preview} />
        <PosePanel jointPose={vm.poseJoint} cartPose={vm.poseCart} />
        <MetricsPanel
          compact
          metrics={vm.metricSeries}
          activeMetric={vm.activeMetric}
          selectMetric={vm.selectMetric}
          pauseLabel={vm.pauseLabel}
          togglePause={vm.togglePause}
          series={vm.series}
          shown={vm.shown}
          liveData={vm.liveData}
          simMode={vm.simMode}
          chips={vm.chips}
          selectAll={vm.selectAll}
        />
      </div>

      {/* MIDDLE: 操作 */}
      <div style={{ ...SCROLL_COLUMN, flex: '1 1 26rem', minWidth: '23rem', gap: '0.75rem' }}>
        <ControlBar
          enableColor={vm.enableColor}
          enabled={vm.enabled}
          toggleEnable={vm.toggleEnable}
          speed={vm.speed}
          setSpeed={vm.setSpeed}
          faultReason={vm.faultReason}
          showDisableHint={!simMode && vm.enabled}
          reset={vm.resetArm}
          clearFault={vm.clearFault}
          zeroJoints={vm.zeroJoints}
          zeroGravity={vm.zeroGravity}
          toggleZeroGravity={vm.toggleZeroGravity}
          readyPose={vm.homeJoints}
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

      {/* RIGHT: 任务（急停常驻）+ 夹爪 —— 夹爪顶掉原来曲线占的那一整块高度 */}
      <div style={{ ...SCROLL_COLUMN, flex: '0 1 clamp(20.5rem, 25vw, 28rem)', minWidth: '20.5rem', gap: '0.75rem' }}>
        <StopButton inert={simMode} />
        {/* 夹爪和机械臂共用一条总线，操作它不该离开这一页。 */}
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
