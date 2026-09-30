import type { ActivationContact, ActivationRequest } from '@/lib/arm'

/**
 * 激活表单 → 请求体。**纯函数**，于是"发出去的东西有哪些字段"能被测试钉住。
 *
 * ⚠ 这里**不加任何同意书里没列出的字段**。请求的键集与
 * `ActivationConsent.tsx` 里逐项列出的内容必须一致 —— 界面不再展示原始 JSON
 * （那份预览被去掉了），所以这条约束靠**同意书本身**和一条钉住键集的用例来守。
 */

export const EMPTY_CONTACT: ActivationContact = {
  name: '',
  organization: '',
  email: '',
  phone: '',
}

/**
 * 必填的联系人字段 —— **四个都是必填**（电话也要）。
 *
 * ⚠ 必须与本地程序 `activation.CONTACT_FIELDS` 一致：界面这里只是让按钮早点变灰，
 * **真正的门禁在守护进程**（它会回 `missing_contact`）。两边都写是有意的 —— 界面上
 * 少判一个只会让用户点完才挨骂，多判一个则会挡住合法输入。
 */
export const REQUIRED_CONTACT_FIELDS: ReadonlyArray<keyof ActivationContact> = [
  'name',
  'organization',
  'email',
  'phone',
]

/** 还没填的必填字段（按表单顺序）。 */
export function missingContactFields(contact: ActivationContact): (keyof ActivationContact)[] {
  return REQUIRED_CONTACT_FIELDS.filter((key) => !contact[key].trim())
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
      organization: draft.contact.organization.trim(),
      email: draft.contact.email.trim(),
      phone: draft.contact.phone.trim(),
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

/** 按钮能不能按：连上了、UID 读到了、四个必填都填了、同意书勾了。 */
export function canSubmitActivation(draft: ActivationDraft): boolean {
  return Boolean(
    draft.uid.trim() &&
      draft.consentGranted &&
      missingContactFields(draft.contact).length === 0,
  )
}
