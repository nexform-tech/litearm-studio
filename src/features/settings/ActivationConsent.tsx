import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** 隐私政策在服务站点上（站点上线前这个地址是 404，文案本身待法务定稿）。 */
const PRIVACY_URL = 'https://act.nexform.tech/privacy'

/**
 * 同意书里**逐项列出**的采集内容。
 *
 * ⚠ 这张表就是"我们会发什么"的**唯一清单**：往请求里加字段就必须在这里加一项，
 * 因为界面不再展示原始请求体（那份"将要发送的内容"预览已去掉）。
 * `activationPayload.buildActivationRequest` 的键集由测试钉住，两处一起改才过得去。
 */
const CONSENT_ITEMS = [
  { id: 'contact', what: 'consentItemContact', why: 'consentItemContactWhy' },
  { id: 'uid', what: 'consentItemUid', why: 'consentItemUidWhy' },
  { id: 'versions', what: 'consentItemVersions', why: 'consentItemVersionsWhy' },
  { id: 'source', what: 'consentItemSource', why: 'consentItemSourceWhy' },
] as const

/**
 * 信息收集同意书（弹窗）。
 *
 * 「同意」按钮**同时**勾上外面的复选框并关闭 —— 让用户在读完的同一个动作里完成同意，
 * 而不是"读完再回去找个框打勾"。
 */
export function ActivationConsentDialog({
  open,
  onOpenChange,
  onAgree,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAgree: () => void
}) {
  const { t } = useTranslation(['common', 'settings'])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" data-testid="activation-consent-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings:activation.consentTitle')}</DialogTitle>
          <DialogDescription>{t('settings:activation.consentIntro')}</DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3" data-testid="activation-consent-items">
          {CONSENT_ITEMS.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-foreground">
                {t(`settings:activation.${item.what}`)}
              </span>
              <span className="text-[0.71875rem] leading-relaxed text-muted-foreground">
                {t(`settings:activation.${item.why}`)}
              </span>
            </li>
          ))}
        </ul>

        <p className="text-[0.71875rem] leading-relaxed text-muted-foreground">
          {t('settings:activation.consentFooter')}{' '}
          <a
            href={PRIVACY_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t('settings:activation.privacy')}
          </a>
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('settings:activation.consentClose')}
          </Button>
          <Button data-testid="activation-consent-agree" onClick={onAgree}>
            {t('settings:activation.consentAgree')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
