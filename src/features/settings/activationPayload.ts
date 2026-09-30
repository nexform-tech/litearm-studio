import type { ActivationContact, ActivationRequest } from '@/lib/arm'

/**
 * 激活表单 → 请求体。**纯函数**，于是"发出去的东西有哪些字段"能被测试钉住。
 *
 * ⚠ **字段与判据都以激活网站的表单为准**（`litearm-activation/src/lib/validation.ts`）：
 * 网站是签发的那一端。这里与守护进程 `activation._CONTACT_RULES` 各写一遍是刻意的 ——
 * 界面只是让按钮早点变灰，**真正的门禁在守护进程**。
 *
 * ⚠ 这里**不加任何同意书里没列出的字段**。请求的键集与
 * `ActivationConsent.tsx` 里逐项列出的内容必须一致 —— 界面不再展示原始 JSON
 * （那份预览被去掉了），所以这条约束靠**同意书本身**和一条钉住键集的用例来守。
 */

/** 空表单。键的顺序与网站表单一致（姓名、手机号、单位、微信号、邮箱、地区、行业、用途）。 */
export const EMPTY_CONTACT: ActivationContact = {
  name: '',
  phone: '',
  organization: '',
  wechatId: '',
  email: '',
  region: '',
  industry: '',
  purpose: '',
}

/** 每个输入框的长度上限 —— 与网站表单的 zod 规则同值（`validation.ts`）。 */
export const CONTACT_LIMITS: Record<keyof ActivationContact, number> = {
  name: 32,
  phone: 11,
  organization: 128,
  wechatId: 64,
  email: 128,
  region: 64,
  industry: 64,
  purpose: 500,
}

/**
 * 必填字段（按表单顺序）。
 *
 * ⚠ 必须与本地程序 `activation.CONTACT_FIELDS` 一致：界面这里只是让按钮早点变灰，
 * **真正的门禁在守护进程**（它会回 `missing_contact`）。两边都写是有意的 —— 界面上
 * 少判一个只会让用户点完才挨骂，多判一个则会挡住合法输入。
 */
export const REQUIRED_CONTACT_FIELDS: ReadonlyArray<keyof ActivationContact> = [
  'name',
  'phone',
  'organization',
  'email',
  'region',
]

/** 还没填的必填字段（按表单顺序）。 */
export function missingContactFields(contact: ActivationContact): (keyof ActivationContact)[] {
  return REQUIRED_CONTACT_FIELDS.filter((key) => !contact[key].trim())
}

// 与网站 `validation.ts` 的正则逐字相同。
const PHONE_RE = /^1[3-9]\d{9}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PERSON_NAME_RE = /^[\p{L}\p{M}\u00b7\u2027\u30fb\u2019'\-\u3000 ]+$/u

/**
 * 格式不合法的那一个字段 → 提示文案的 i18n 后缀（`settings:activation.*`），全合法时 `null`。
 *
 * ⚠ **不判空**：空的必填项是 `missingContactFields` 的事，两者分开才不会把"没填"报成"填错"。
 * ⚠ 长度也不在这里判：输入框有 `maxLength`，超长只可能来自直连 WebSocket 的客户端
 * （守护进程会拒并回 `contact_too_long`）。
 */
export function invalidContactField(
  contact: ActivationContact,
): { field: keyof ActivationContact; key: string } | null {
  const name = contact.name.trim()
  if (name && (name.length < 2 || !PERSON_NAME_RE.test(name))) {
    return { field: 'name', key: 'invalidName' }
  }
  if (contact.phone.trim() && !PHONE_RE.test(contact.phone.trim())) {
    return { field: 'phone', key: 'invalidPhone' }
  }
  if (contact.email.trim() && !EMAIL_RE.test(contact.email.trim())) {
    return { field: 'email', key: 'invalidEmail' }
  }
  return null
}

export type ActivationDraft = {
  uid: string
  contact: ActivationContact
  /** "我已阅读并同意《激活注册信息同意书》"—— 未勾选时**不发**，界面只把按钮变灰。 */
  consentGranted: boolean
  diagnostics: { studio: string; sdk: string; firmware: string }
  /** 预留：订单号/激活码。今天界面上没有这个输入框，留着是为了契约先定下来。 */
  code?: string
}

/** 组装请求体。字段与同意书里逐项列出的内容一一对应。 */
export function buildActivationRequest(draft: ActivationDraft): ActivationRequest {
  const request: ActivationRequest = {
    uid: draft.uid.trim().toLowerCase(),
    contact: {
      name: draft.contact.name.trim(),
      phone: draft.contact.phone.trim(),
      organization: draft.contact.organization.trim(),
      wechatId: draft.contact.wechatId.trim(),
      email: draft.contact.email.trim(),
      region: draft.contact.region.trim(),
      industry: draft.contact.industry.trim(),
      purpose: draft.contact.purpose.trim(),
    },
    consent: { granted: draft.consentGranted },
    diagnostics: {
      studio: draft.diagnostics.studio,
      sdk: draft.diagnostics.sdk,
      firmware: draft.diagnostics.firmware,
    },
  }
  const code = draft.code?.trim()
  if (code) request.code = code
  return request
}

/** 按钮能不能按：连上了、UID 读到了、必填都填了、格式都对、同意书勾了。 */
export function canSubmitActivation(draft: ActivationDraft): boolean {
  return Boolean(
    draft.uid.trim() &&
      draft.consentGranted &&
      missingContactFields(draft.contact).length === 0 &&
      invalidContactField(draft.contact) === null,
  )
}
