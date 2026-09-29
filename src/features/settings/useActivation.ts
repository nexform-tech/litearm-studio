import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  armClient,
  formatArmError,
  useArmConnection,
  type ActivationRequest,
  type LicenseSnapshot,
} from '@/lib/arm'

/**
 * 授权状态与激活动作。
 *
 * 读: 授权记录**不随状态帧推送**（它是请求/应答式的一次性记录，不是 100Hz 的状态流），
 * 所以连上之后拉一次、用户点「刷新」时再拉。
 *
 * 写: 两条路 —— `submit()` 走激活服务（唯一出网的动作），`importLicense()` 用凭据文件，
 * 不联网。两条都由守护进程做最终校验（同意、UID 是否本机、文件格式），这里只负责把结果
 * 或错误摆到界面上。
 */
export function useActivation() {
  const { t } = useTranslation(['common', 'settings'])
  const { status } = useArmConnection()
  const connected = status === 'connected'

  const [snapshot, setSnapshot] = useState<LicenseSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    try {
      setSnapshot(await armClient.license())
      setError(null)
    } catch (err) {
      setError(formatArmError(err) || String(err))
    } finally {
      setLoading(false)
    }
  }, [connected])

  useEffect(() => {
    if (connected) {
      void refresh()
    } else {
      // 断开之后不留上一次会话的授权记录：那台机器已经不在这条链路上了。
      setSnapshot(null)
      setError(null)
    }
  }, [connected, refresh])

  /** 提交注册信息并从激活服务领凭据。⚠ 全应用唯一出网的动作（见 `client.activate`）。 */
  const submit = useCallback(
    async (request: ActivationRequest): Promise<boolean> => {
      setSubmitting(true)
      try {
        const record = await armClient.activate(request)
        setSnapshot(record)
        setError(null)
        toast.success(t('settings:activation.activatedJustNow'))
        return true
      } catch (err) {
        // ⚠ 失败必须让操作员看见原因：「提交了但没激活」与「提交没成功」是两件事。
        toast.error(formatArmError(err) || String(err), { id: 'activation-submit' })
        return false
      } finally {
        setSubmitting(false)
      }
    },
    [t],
  )

  /**
   * 用凭据文件激活（不联网）。
   *
   * 这里只做 `JSON.parse` —— 让人当场知道"选错文件了"；**字段级的判据全在守护进程**
   * （它才知道当前设备的 UID），只有一处实现，不会两边漂。
   */
  const importLicense = useCallback(
    async (text: string): Promise<boolean> => {
      let doc: unknown
      try {
        doc = JSON.parse(text)
      } catch {
        toast.error(t('common:errors.licenseUnreadable'), { id: 'activation-import' })
        return false
      }
      setSubmitting(true)
      try {
        const record = await armClient.importLicense(doc as Record<string, unknown>)
        setSnapshot(record)
        setError(null)
        toast.success(t('settings:activation.activatedJustNow'))
        return true
      } catch (err) {
        toast.error(formatArmError(err) || String(err), { id: 'activation-import' })
        return false
      } finally {
        setSubmitting(false)
      }
    },
    [t],
  )

  return { connected, snapshot, loading, submitting, error, refresh, submit, importLicense }
}

export type ActivationState = ReturnType<typeof useActivation>
