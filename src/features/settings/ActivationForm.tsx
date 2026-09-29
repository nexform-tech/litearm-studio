import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { armClient, type ActivationContact } from '@/lib/arm'
import {
  EMPTY_CONTACT,
  buildActivationRequest,
  canSubmitActivation,
  missingContactFields,
  previewJson,
} from './activationPayload'
import type { ActivationState } from './useActivation'

const PRIVACY_URL = 'https://act.nexform.tech/privacy'

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

function Check({
  id,
  checked,
  onChange,
  children,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-[0.71875rem] leading-relaxed">
      <input
        id={id}
        data-testid={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 flex-none accent-primary"
      />
      <span className="text-muted-foreground">{children}</span>
    </label>
  )
}

/**
 * 注册信息表单 + 两条激活路径（在线领凭据 / 导入凭据文件）。
 *
 * ⚠ **"将要发送的内容"必须与真正发出去的对象是同一个东西**：它由 `buildActivationRequest`
 * 生成、由 `previewJson` 渲染，提交时把这个对象原样交给 `vm.submit()`。想加字段就得同时
 * 出现在预览里 —— 这条约束是有意的（激活会把个人信息发到公网，不许有暗字段）。
 */
export function ActivationForm({ vm, uid, firmware, disarmed }: Props) {
  const { t } = useTranslation(['common', 'settings'])
  const [contact, setContact] = useState<ActivationContact>(EMPTY_CONTACT)
  const [consentRequired, setConsentRequired] = useState(false)
  const [consentDiagnostics, setConsentDiagnostics] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const versions = armClient.versions
  const draft = {
    uid,
    contact,
    consentRequired,
    consentDiagnostics,
    diagnostics: {
      studio: versions?.daemon ?? '',
      sdk: versions?.sdk ?? '',
      firmware,
    },
  }
  const request = buildActivationRequest(draft)
  const ready = canSubmitActivation(draft) && disarmed && !vm.submitting
  const missing = missingContactFields(contact)

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

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t('settings:activation.name')} required>
          <Input
            data-testid="activation-name"
            value={contact.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.organization')} required>
          <Input
            data-testid="activation-organization"
            value={contact.organization}
            onChange={(e) => setField('organization', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.email')} required>
          <Input
            data-testid="activation-email"
            type="email"
            value={contact.email}
            onChange={(e) => setField('email', e.target.value)}
          />
        </Field>
        <Field label={t('settings:activation.phone')}>
          <Input
            data-testid="activation-phone"
            value={contact.phone}
            onChange={(e) => setField('phone', e.target.value)}
          />
        </Field>
      </div>
      <p className="text-[0.6875rem] text-muted-foreground">
        {t('settings:activation.contactRequired')}
      </p>

      <div className="flex flex-col gap-2">
        <Check id="activation-consent-required" checked={consentRequired} onChange={setConsentRequired}>
          {t('settings:activation.consentRequired')}
        </Check>
        <Check
          id="activation-consent-diagnostics"
          checked={consentDiagnostics}
          onChange={setConsentDiagnostics}
        >
          {t('settings:activation.consentDiagnostics')}
        </Check>
        <p className="text-[0.6875rem] text-muted-foreground">
          {t('settings:activation.consentNote')}{' '}
          <a
            href={PRIVACY_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t('settings:activation.privacy')}
          </a>
        </p>
      </div>

      <details open className="rounded-lg border border-line bg-muted/30 p-3">
        <summary className="cursor-pointer text-[0.71875rem] font-semibold text-foreground">
          {t('settings:activation.preview')}
        </summary>
        <p className="mt-1 text-[0.6875rem] text-muted-foreground">
          {t('settings:activation.previewHint')}
        </p>
        <pre
          data-testid="activation-preview"
          className="mt-2 max-h-56 overflow-auto rounded bg-background/60 p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground"
        >
          {previewJson(request)}
        </pre>
      </details>

      {!disarmed ? (
        <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-[0.71875rem] text-danger">
          {t('settings:activation.mustDisable')}
        </p>
      ) : null}

      {fileError ? (
        <p className="text-[0.71875rem] text-danger">{fileError}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="activation-submit"
          size="sm"
          disabled={!ready}
          onClick={() => void vm.submit(request)}
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
