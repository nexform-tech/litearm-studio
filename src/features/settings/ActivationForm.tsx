import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { armClient, type ActivationContact } from '@/lib/arm'
import {
  CONTACT_LIMITS,
  EMPTY_CONTACT,
  buildActivationRequest,
  canSubmitActivation,
  invalidContactField,
  missingContactFields,
} from './activationPayload'
import { ActivationConsentDialog } from './ActivationConsent'
import type { ActivationState } from './useActivation'

type Props = {
  vm: ActivationState
  uid: string
  firmware: string
  /** 机械臂当前是否失能 —— 固件只在失能态写授权记录（会回 `0x3F/0x04`）。 */
  disarmed: boolean
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium text-muted-foreground">
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
    </label>
  )
}

/**
 * 注册信息表单 + 两条激活路径（在线领凭据 / 导入凭据文件）。
 *
 * ⚠ **只有一份同意**（激活注册信息同意书，弹窗里逐项列出发送内容）。它覆盖请求里的每一项，
 * 所以没有"某一项可以不勾"的开关；未勾选时按钮是灰的，而真正的门禁在守护进程那一层。
 */
export function ActivationForm({ vm, uid, firmware, disarmed }: Props) {
  const { t } = useTranslation(['common', 'settings'])
  const [contact, setContact] = useState<ActivationContact>(EMPTY_CONTACT)
  const [consentGranted, setConsentGranted] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const versions = armClient.versions
  const draft = {
    uid,
    contact,
    consentGranted,
    diagnostics: {
      studio: versions?.daemon ?? '',
      sdk: versions?.sdk ?? '',
      firmware,
    },
  }
  const ready = canSubmitActivation(draft) && disarmed && !vm.submitting
  const missing = missingContactFields(contact)
  // 格式问题。⚠ 与"还没填"分开：把没填报成填错，操作员会去改一个空框。
  const problem = invalidContactField(contact)

  const setField = (key: keyof ActivationContact, value: string) =>
    setContact((prev) => ({ ...prev, [key]: value }))

  async function pickFile(file: File | undefined) {
    setFileError(null)
    if (!file) return
    try {
      await vm.importLicense(await file.text())
    } catch {
      setFileError(t('common:errors.licenseUnreadable'))
    } finally {
      // 同一个文件再选一次也要能触发 change。
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <div>
        <h3 className="text-sm font-bold text-foreground">{t('settings:activation.formTitle')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('settings:activation.formDesc')}</p>
      </div>

      {/* 字段与顺序都以激活网站的表单为准（`litearm-activation/src/lib/validation.ts`）。 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t('settings:activation.name')} required>
          <Input
            data-testid="activation-name"
            value={contact.name}
            maxLength={CONTACT_LIMITS.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.phone')} required>
          <Input
            data-testid="activation-phone"
            value={contact.phone}
            inputMode="numeric"
            maxLength={CONTACT_LIMITS.phone}
            onChange={(e) => setField('phone', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.organization')} required>
          <Input
            data-testid="activation-organization"
            value={contact.organization}
            maxLength={CONTACT_LIMITS.organization}
            onChange={(e) => setField('organization', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.wechatId')}>
          <Input
            data-testid="activation-wechat"
            value={contact.wechatId}
            maxLength={CONTACT_LIMITS.wechatId}
            onChange={(e) => setField('wechatId', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.email')} required>
          <Input
            data-testid="activation-email"
            type="email"
            value={contact.email}
            maxLength={CONTACT_LIMITS.email}
            onChange={(e) => setField('email', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.region')} required>
          <Input
            data-testid="activation-region"
            value={contact.region}
            maxLength={CONTACT_LIMITS.region}
            onChange={(e) => setField('region', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.industry')}>
          <Input
            data-testid="activation-industry"
            value={contact.industry}
            maxLength={CONTACT_LIMITS.industry}
            onChange={(e) => setField('industry', e.target.value)}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label={t('settings:activation.purpose')}>
            <Textarea
              data-testid="activation-purpose"
              rows={3}
              value={contact.purpose}
              maxLength={CONTACT_LIMITS.purpose}
              onChange={(e) => setField('purpose', e.target.value)}
            />
          </Field>
        </div>
      </div>
      <p className="text-[0.6875rem] text-muted-foreground">
        {t('settings:activation.contactRequired')}
      </p>
      {problem ? (
        <p data-testid="activation-invalid" className="text-[0.6875rem] text-danger">
          {t(`settings:activation.${problem.key}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor="activation-consent" className="flex items-start gap-2 text-[0.71875rem] leading-relaxed">
          <input
            id="activation-consent"
            data-testid="activation-consent"
            type="checkbox"
            checked={consentGranted}
            onChange={(e) => setConsentGranted(e.target.checked)}
            className="mt-0.5 size-3.5 flex-none accent-primary"
          />
          <span className="text-muted-foreground">{t('settings:activation.consentAgreeLabel')}</span>
        </label>
        <button
          type="button"
          data-testid="activation-consent-open"
          onClick={() => setConsentOpen(true)}
          className="text-[0.71875rem] font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('settings:activation.consentDocName')}
        </button>
      </div>

      <ActivationConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        onAgree={() => {
          setConsentGranted(true)
          setConsentOpen(false)
        }}
      />

      {!disarmed ? (
        <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-[0.71875rem] text-danger">
          {t('settings:activation.mustDisable')}
        </p>
      ) : null}

      {fileError ? <p className="text-[0.71875rem] text-danger">{fileError}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="activation-submit"
          size="sm"
          disabled={!ready}
          onClick={() => void vm.submit(buildActivationRequest(draft))}
        >
          <Send className="size-3.5" />
          {vm.submitting ? t('settings:activation.submitting') : t('settings:activation.submit')}
        </Button>
        <Button
          data-testid="activation-import"
          size="sm"
          variant="outline"
          disabled={!disarmed || vm.submitting}
          onClick={() => fileRef.current?.click()}
        >
          <FileUp className="size-3.5" />
          {t('settings:activation.importButton')}
        </Button>
        <input
          ref={fileRef}
          data-testid="activation-file"
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        {t('settings:activation.importHint')}
      </p>
      {missing.length > 0 ? (
        <p className="sr-only" data-testid="activation-missing">
          {missing.join(',')}
        </p>
      ) : null}
    </div>
  )
}
