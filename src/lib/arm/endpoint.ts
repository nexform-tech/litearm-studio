/** 机械臂连接端点：本地保存值优先，其次内置默认值。 */

export const ARM_ENDPOINT_LS_KEY = 'arm_endpoint'

/** 内置默认端点：7449 为 litearm-server 标准 WebSocket 端口。 */
export const DEFAULT_ARM_ENDPOINT = '192.168.1.1:7449'

export function getInitialEndpoint(): string {
  const saved = (localStorage.getItem(ARM_ENDPOINT_LS_KEY) || '').trim()
  return saved || DEFAULT_ARM_ENDPOINT
}
