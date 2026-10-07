export { armClient, normalizeLicense } from './client'
export type {
  ActivationContact,
  ActivationRequest,
  ArmCommandError,
  ConnInfo,
  ConnectionStatus,
  HelloInfo,
  JointParams,
  LicenseRecord,
  LicenseSnapshot,
  Pose6,
  RobotState,
} from './client'
export { formatArmError, formatFirmwareReason } from './errors'
export type { DaemonErrorInfo } from './errors'
export {
  FIRMWARE_PHASE_KEYS,
  fileToBase64,
  normalizeFirmwareProgress,
  normalizeFirmwareResult,
  normalizeFirmwareStatus,
} from './firmware'
export type {
  FirmwareImageSummary,
  FirmwareProgress,
  FirmwareResult,
  FirmwareStatus,
} from './firmware'
export { DEFAULT_JOINT_COUNT, MAX_JOINT_COUNT, jointIndexes, resolveJointCount, useJointCount } from './axes'
export { useArmConnection } from './useArmConnection'
export { useArmState } from './useArmState'
export { useArmMetrics } from './useArmMetrics'
export type { SeriesSample, MetricSeries, MetricChip, MetricType, ArmMetricsReturn, UseArmMetricsOptions } from './useArmMetrics'
export { GripperClient, gripperClient, normalizeGripperState } from './gripperClient'
export type {
  CalibrationCandidate,
  CalibrationSource,
  GripperAlert,
  GripperBusy,
  GripperCalibProgress,
  GripperConnInfo,
  GripperState,
  MotionSettings,
} from './gripperClient'
export { DaemonSocket } from './socket'
export type { CommandError, SocketLifecycle } from './socket'
export { gripperFail, useGripperAlerts, useGripperCalibration, useGripperConnection, useGripperState } from './useGripper'
