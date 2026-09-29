import type { ActivationContact, ActivationRequest } from '@/lib/arm'

/**
 * 激活表单 → 请求体。**纯函数**，因为界面要把它的输出逐字渲染给用户看：
 * "将要发送的内容"必须与真正发出去的那个对象**是同一个东西**，不能各写一份。
 */

export const EMPTY_CONTACT: ActivationContact = {
  name: '',
  organization: '',
  email: '',
  phone: '',
}

/**
 * 必填的联系人字段。
 *
 * ⚠ 必须与本地程序 `activation.CONTACT_REQUIRED` 一致：界面这里只是让按钮早点变灰，
 * **真正的门禁在守护进程**（它会回 `missing_contact`）。两边都写是有意的 —— 界面上
 * 少判一个只会让用户点完才挨骂，多判一个则会挡住合法输入。
 */
export const REQUIRED_CONTACT_FIELDS: ReadonlyArray<keyof ActivationContact> = [
  'name',
  'organization',
  'email',
]

/** 还没填的必填字段（按表单顺序）。 */
export function missingContactFields(contact: ActivationContact): (keyof ActivationContact)[] {
  return REQUIRED_CONTACT_FIELDS.filter((key) => !contact[key].trim())
}

export type ActivationDraft = {
  uid: string
  contact: ActivationContact
  /** "同意发送注册信息" —— 未勾选时**不发**，界面只把按钮变灰。 */
  consentRequired: boolean
  consentDiagnostics: boolean
  diagnostics: { studio: string; sdk: string; firmware: string }
  /** 预留：订单号/激活码。今天界面上没有这个输入框，留着是为了契约先定下来。 */
  code?: string
}

/**
 * 组装请求体。
 *
 * ⚠ 这里**不加任何界面没显示的字段** —— 用户看到的就是发出去的。诊断信息只在勾选后出现；
 * `code` 为空时不出现在 JSON 里（空字段会被服务端当成"填了但为空"）。
 */
export function buildActivationRequest(draft: ActivationDraft): ActivationRequest {
  const request: ActivationRequest = {
    uid: draft.uid.trim().toLowerCase(),
    contact: {
      name: draft.contact.name.trim(),
      organization: draft.contact.organization.trim(),
      email: draft.contact.email.trim(),
      phone: draft.contact.phone.trim(),
    },
    consent: { required: draft.consentRequired, diagnostics: draft.consentDiagnostics },
  }
  if (draft.consentDiagnostics) {
    request.diagnostics = {
      studio: draft.diagnostics.studio,
      sdk: draft.diagnostics.sdk,
      firmware: draft.diagnostics.firmware,
    }
  }
  const code = draft.code?.trim()
  if (code) request.code = code
  return request
}

/** 按钮能不能按：连上了、UID 读到了、必填填了、同意勾了。 */
export function canSubmitActivation(draft: ActivationDraft): boolean {
  return Boolean(
    draft.uid.trim() &&
      draft.consentRequired &&
      missingContactFields(draft.contact).length === 0,
  )
}

/** 预览用：与服务端收到的**同一个对象**，缩进后直接渲染。 */
export function previewJson(request: ActivationRequest): string {
  return JSON.stringify(request, null, 2)
}
