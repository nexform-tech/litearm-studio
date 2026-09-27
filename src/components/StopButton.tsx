import { useArmConnection } from '@/lib/arm'
import { useTranslation } from 'react-i18next'

export function StopButton({ inert = false }: { inert?: boolean }) {
  const { t } = useTranslation('common')
  const { status, requestStop } = useArmConnection()
  const connected = status === 'connected'
  const disabled = inert || !connected

  return (
    <button
      type="button"
      aria-label={t('stop')}
      title={inert ? t('stopSim') : connected ? t('stop') : t('stopDisconnected')}
      onClick={() => {
        if (disabled) return
        requestStop()
      }}
      className="flex h-[5.75rem] flex-none basis-[5.75rem] cursor-pointer items-center justify-center gap-3 rounded-[0.875rem]"
      style={{
        background: 'linear-gradient(180deg,#f0424a,#d5262e)',
        boxShadow: '0 0.125rem 0.375rem rgba(213,38,46,.3)',
        ...(disabled ? { opacity: 0.45, cursor: 'not-allowed', filter: 'grayscale(0.6)' } : {}),
      }}
    >
      <div className="text-[2.5rem] font-extrabold tracking-[0.1875rem] text-white">
        STOP
      </div>
    </button>
  )
}
