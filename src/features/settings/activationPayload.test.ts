import { describe, expect, it } from 'vitest'
import {
  CONTACT_LIMITS,
  EMPTY_CONTACT,
  buildActivationRequest,
  canSubmitActivation,
  invalidContactField,
  missingContactFields,
  type ActivationDraft,
} from './activationPayload'

const UID = '101112131415161718191a1b'

/** 一份填满的注册信息 —— 字段与激活网站的表单一一对应。 */
const FILLED_CONTACT = {
  name: '张三',
  phone: '13800000000',
  organization: '某大学',
  wechatId: 'zhangsan_wx',
  email: 'z@example.com',
  region: '上海',
  industry: '教育',
  purpose: '科研教学',
}

function draft(over: Partial<ActivationDraft> = {}): ActivationDraft {
  return {
    uid: UID,
    contact: { ...FILLED_CONTACT },
    consentGranted: true,
    diagnostics: { studio: '0.1.0', sdk: '2.1.0', firmware: 'Litearm1.8.0-7J' },
    ...over,
  }
}

describe('buildActivationRequest', () => {
  it('sends exactly the fields the consent document lists', () => {
    const request = buildActivationRequest(draft())
    // ⚠ 键集就是契约。「将要发送的内容」那份预览已经去掉了，所以"不许有暗字段"这条约束
    //   现在由这里钉住：往请求里加字段，必须同时改同意书（ActivationConsent 的 CONSENT_ITEMS）。
    expect(Object.keys(request).sort()).toEqual(['consent', 'contact', 'diagnostics', 'uid'])
    // 八个字段与激活网站的表单同集（`litearm-activation/src/lib/validation.ts`）。
    expect(Object.keys(request.contact).sort()).toEqual([
      'email',
      'industry',
      'name',
      'organization',
      'phone',
      'purpose',
      'region',
      'wechatId',
    ])
    // 只有一份同意 —— 没有逐项的开关。
    expect(request.consent).toEqual({ granted: true })
    expect(request.contact).toEqual(FILLED_CONTACT)
  })

  it('keeps the length caps the website form uses', () => {
    // 上限漂了就意味着"界面让填、网站会拒"。这张表与网站 zod 规则同值。
    expect(CONTACT_LIMITS).toEqual({
      name: 32,
      phone: 11,
      organization: 128,
      wechatId: 64,
      email: 128,
      region: 64,
      industry: 64,
      purpose: 500,
    })
  })

  it('always carries the version block, because it is part of the same consent', () => {
    expect(buildActivationRequest(draft()).diagnostics).toEqual({
      studio: '0.1.0',
      sdk: '2.1.0',
      firmware: 'Litearm1.8.0-7J',
    })
  })

  it('trims every field and lowercases the uid', () => {
    const request = buildActivationRequest(
      draft({
        uid: `  ${UID.toUpperCase()}  `,
        contact: {
          name: '  张三 ',
          phone: ' 13800000000 ',
          organization: ' 某大学',
          wechatId: ' zhangsan_wx ',
          email: ' z@x.io ',
          region: ' 上海 ',
          industry: ' 教育 ',
          purpose: ' 科研教学 ',
        },
      }),
    )
    expect(request.uid).toBe(UID)
    expect(request.contact).toEqual({
      name: '张三',
      phone: '13800000000',
      organization: '某大学',
      wechatId: 'zhangsan_wx',
      email: 'z@x.io',
      region: '上海',
      industry: '教育',
      purpose: '科研教学',
    })
  })

  it('omits an empty order code instead of sending an empty field', () => {
    expect('code' in buildActivationRequest(draft())).toBe(false)
    expect(buildActivationRequest(draft({ code: ' A-42 ' })).code).toBe('A-42')
  })

  it('reflects an unticked consent box (the daemon is the gate)', () => {
    // 界面把按钮变灰只是方便；服务端收到 `granted: false` 会当场拒。
    expect(buildActivationRequest(draft({ consentGranted: false })).consent.granted).toBe(false)
  })
})

describe('canSubmitActivation', () => {
  it('needs consent, a uid and all five required fields', () => {
    expect(canSubmitActivation(draft())).toBe(true)
    expect(canSubmitActivation(draft({ consentGranted: false }))).toBe(false)
    expect(canSubmitActivation(draft({ uid: '  ' }))).toBe(false)
    // 少任何一个必填项都不让提交 —— 逐个试一遍。
    for (const field of ['name', 'phone', 'organization', 'email', 'region'] as const) {
      expect(
        canSubmitActivation(draft({ contact: { ...FILLED_CONTACT, [field]: '  ' } })),
      ).toBe(false)
    }
  })

  it('refuses a value the website form would reject', () => {
    // 判据与网站同表：界面提前拦住，操作员不必等到服务器回一句"格式不对"。
    expect(canSubmitActivation(draft({ contact: { ...FILLED_CONTACT, phone: '1380000' } }))).toBe(
      false,
    )
    expect(
      canSubmitActivation(draft({ contact: { ...FILLED_CONTACT, email: 'z@example' } })),
    ).toBe(false)
    expect(
      canSubmitActivation(draft({ contact: { ...FILLED_CONTACT, name: '张3' } })),
    ).toBe(false)
  })

  it('names the fields that are still missing', () => {
    expect(missingContactFields({ ...EMPTY_CONTACT, name: '张三' })).toEqual([
      'phone',
      'organization',
      'email',
      'region',
    ])
    expect(missingContactFields(EMPTY_CONTACT)).toEqual([
      'name',
      'phone',
      'organization',
      'email',
      'region',
    ])
  })

  it('treats a whitespace-only value as missing, not as filled', () => {
    expect(canSubmitActivation(draft({ contact: { ...FILLED_CONTACT, region: '   ' } }))).toBe(false)
  })
})

describe('invalidContactField', () => {
  it('passes a filled form', () => {
    expect(invalidContactField(FILLED_CONTACT)).toBeNull()
  })

  it('accepts CJK, latin and the punctuation a real name uses', () => {
    for (const name of ['张三', 'Anne-Marie', "O'Brien", '买买提·艾力', '佐藤 優子']) {
      expect(invalidContactField({ ...FILLED_CONTACT, name })).toBeNull()
    }
  })

  it('points at the field that is wrong, so the operator knows which box to fix', () => {
    expect(invalidContactField({ ...FILLED_CONTACT, name: '张3' })).toEqual({
      field: 'name',
      key: 'invalidName',
    })
    expect(invalidContactField({ ...FILLED_CONTACT, phone: '1380000000' })).toEqual({
      field: 'phone',
      key: 'invalidPhone',
    })
    expect(invalidContactField({ ...FILLED_CONTACT, phone: '12800000000' })).toEqual({
      field: 'phone',
      key: 'invalidPhone',
    })
    expect(invalidContactField({ ...FILLED_CONTACT, email: 'z@example' })).toEqual({
      field: 'email',
      key: 'invalidEmail',
    })
  })

  it('leaves the empty fields to missingContactFields', () => {
    // "还没填"和"填错了"是两句话：把空的报成格式错，操作员会去改一个空框。
    expect(invalidContactField(EMPTY_CONTACT)).toBeNull()
    expect(invalidContactField({ ...FILLED_CONTACT, name: '  ' })).toBeNull()
  })

  it('does not judge the optional fields at all', () => {
    expect(
      invalidContactField({ ...FILLED_CONTACT, wechatId: '', industry: '', purpose: '' }),
    ).toBeNull()
  })
})
