import { useTranslation } from 'react-i18next'
import { useSoloState } from './useSoloState'
import { PreviewPanel } from './PreviewPanel'
import { PoseCard } from './PoseCard'
import { MetricsPanel } from './MetricsPanel'
import { ControlBar, LockedBanner } from './ControlBar'
import { JointSpacePanel } from './JointSpacePanel'
import { CartesianPanel } from './CartesianPanel'
import { TrajectoryPanel } from './TrajectoryPanel'
import { EndEffectorControlPanel } from './EndEffectorControlPanel'
import { StopButton } from '../../components/StopButton'
import { ROW_OVERFLOW, SCROLL_COLUMN, SIDE_COL_WIDE } from '../../lib/responsive'

export function SoloConsole() {
  const vm = useSoloState()
  const simMode = vm.simMode

  return (
    <div style={{ flex: 1, display: 'flex', gap: '0.875rem', padding: '0.875rem', minHeight: '0rem', ...ROW_OVERFLOW }}>
      {/* LEFT: 状态 */}
      <div style={{ ...SCROLL_COLUMN, ...SIDE_COL_WIDE, gap: '0.75rem' }}>
        <PreviewPanel viewTabs={vm.viewTabs} viewBadge={vm.viewBadge} preview={vm.preview} />
        <PoseCard poseTabs={vm.poseTabs} pose={vm.pose} />
        <MetricsPanel
          metrics={vm.metrics}
          metricUnit={vm.metricUnit}
          metricAxis={vm.metricAxis}
          pauseLabel={vm.pauseLabel}
          togglePause={vm.togglePause}
          series={vm.series}
          shown={vm.shown}
          liveData={vm.liveData}
          simMode={vm.simMode}
          chips={vm.chips}
          selectAll={vm.selectAll}
          selectNone={vm.selectNone}
          noData={vm.errNoData}
        />
      </div>

      {/* MIDDLE: 操作 */}
      {/* 中间列基宽收窄，右侧轨迹列在小屏上能拿到更多宽度（见下方右列覆盖）。 */}
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

        {vm.locked ? (
          <LockedBanner
            playName={vm.playName}
            playPoint={vm.playPoint}
            rateLabel={vm.rateLabel}
            playBtnLabel={vm.playBtnLabel}
            togglePlay={vm.togglePlay}
            stopPlay={vm.stopPlay}
          />
        ) : null}

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            minHeight: '0rem',
            opacity: vm.lockDim,
            pointerEvents: vm.lockEvents as 'auto' | 'none',
          }}
        >
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

      {/* RIGHT: 任务 */}
      {/* 轨迹列表在小屏上偏窄：右列下限从 18.75rem 提到 20.5rem、vw 份额同步上调，
          占用的空间由中间列（flex 伸展方）让出。 */}
      <div style={{ ...SCROLL_COLUMN, flex: '0 1 clamp(20.5rem, 25vw, 28rem)', minWidth: '20.5rem', gap: '0.75rem' }}>
        <StopButton inert={simMode} />
        <TrajectoryPanel
          simMode={simMode}
          traj={vm.traj}
          trajName={vm.trajName}
          setTrajName={vm.setTrajName}
          recording={vm.recording}
          toggleRecording={vm.toggleRecording}
          refreshTraj={vm.refreshTraj}
          recElapsed={vm.recElapsed}
          recOpacity={vm.recOpacity}
          recEvents={vm.recEvents as 'auto' | 'none'}
          playing={vm.playing}
          playBtnLabel={vm.playBtnLabel}
          playBtnBg={vm.playBtnBg}
          playBtnFg={vm.playBtnFg}
          playBtnBd={vm.playBtnBd}
          togglePlay={vm.togglePlay}
          stopPlay={vm.stopPlay}
          toggleLoop={vm.toggleLoop}
          loop={vm.loop}
          loopBd={vm.loopBd}
          loopBg={vm.loopBg}
          loopFg={vm.loopFg}
          rates={vm.rates}
          lockNote={vm.lockNote}
          lockFg={vm.lockFg}
          pendingDelete={vm.pendingDelete}
          onCancelDelete={vm.cancelDelete}
          onConfirmDelete={vm.confirmDelete}
        />
        <EndEffectorControlPanel simMode={simMode} />
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
