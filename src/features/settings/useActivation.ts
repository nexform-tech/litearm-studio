import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  armClient,
  formatArmError,
  useArmConnection,
  type ActivationRequest,
  type LicenseRecord,
  type LicenseSnapshot,
} from '@/lib/arm'

/**
 * 授权状态与激活动作。
 *
 * 读: 授权记录**不随状态帧推送**（它是请求/应答式的一次性记录，不是 100Hz 的状态流），
 * 所以连上之后拉一次、用户点「刷新」时再拉。
 *
 * ⚠ 「读不到」有**两条**路，界面必须一视同仁：
 *  · 命令报错（链路层失败）—— hook 拿到 reject；
 *  · 设备不应答 —— daemon 把超时吞成 `{supported: null}`，且应答是 `ok: true`，hook 拿不到
 *    任何错误（旧固件探测帧读不到 ERR 就走这条，见 daemon `session._license_dict`）。
 * 两条路都不清掉上一条记录，只把它标成**旧读数**（`stale`）；否则一次链路抖动就把 UID
 * 从屏幕上抹掉，而 UID 正是这一段唯一的交付物。
 *
 * 写: 一条路 —— `submit()` 走激活服务（唯一出网的动作）。由守护进程做最终校验（同意、
 * UID 是否本机、凭据格式），这里只负责把结果或错误摆到界面上。
 */
export function useActivation() {
  const { t } = useTranslation(['common', 'settings'])
  const { status } = useArmConnection()
  const connected = status === 'connected'

  const [snapshot, setSnapshot] = useState<LicenseSnapshot | null>(null)
  /** 最近一次**读到**的记录；读不到时保留上一条（见上面的说明）。 */
  const [record, setRecord] = useState<LicenseRecord | null>(null)
  /** `record` 是否早于最近一次读 —— 记录还在，但不能看起来像刚刚确认过。 */
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    try {
      const next = await armClient.license()
      setSnapshot(next)
      setError(null)
      if (next.supported === true) {
        setRecord(next)
        setStale(false)
      } else {
        setStale(true)
      }
    } catch (err) {
      setError(formatArmError(err) || String(err))
      setStale(true)
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
      setRecord(null)
      setStale(false)
      setError(null)
    }
  }, [connected, refresh])

  /** 提交注册信息并从激活服务领凭据。⚠ 全应用唯一出网的动作（见 `client.activate`）。 */
  const submit = useCallback(
    async (request: ActivationRequest): Promise<boolean> => {
      setSubmitting(true)
      try {
        const readBack = await armClient.activate(request)
        setSnapshot(readBack)
        setError(null)
        if (readBack.supported === true) {
          setRecord(readBack)
          setStale(false)
        } else {
          // 刚写过授权，回读又没确认 —— 屏幕上那条记录可能已经过时，但它是操作员唯一的
          // 参照，所以留着并标成旧读数（与刷新读不到时同一处理）。
          setStale(true)
        }
        // ⚠ 只有**回读确认**了才算成功。`activate` 回的 ok 只说明固件答应了 (ACK 可能被
        //   应答 FIFO 丢掉), 而写之后的回读本身可能超时 —— 那时 daemon 回的是
        //   `{supported: null}`, 服务端仍然是 ok。无条件弹"已解锁"会让同一个界面上同时
        //   出现"已解锁"和"读不到"两个相反的结论, 而这一步唯一的产出就是"到底解锁没有"。
        if (readBack.supported === true && readBack.activated) {
          toast.success(t('settings:activation.activatedJustNow'))
        } else {
          toast.warning(t('settings:activation.activatedUnconfirmed'), { id: 'activation-submit' })
        }
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

  return { connected, snapshot, record, stale, loading, submitting, error, refresh, submit }
}

export type ActivationState = ReturnType<typeof useActivation>
