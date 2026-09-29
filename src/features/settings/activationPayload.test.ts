import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONTACT,
  buildActivationRequest,
  canSubmitActivation,
  missingContactFields,
  type ActivationDraft,
} from './activationPayload'

const UID = '101112131415161718191a1b'

function draft(over: Partial<ActivationDraft> = {}): ActivationDraft {
  return {
    uid: UID,
    contact: { name: '张三', organization: '某大学', email: 'z@example.com', phone: '13800000000' },
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
    expect(Object.keys(request.contact).sort()).toEqual([
      'email',
      'name',
      'organization',
      'phone',
    ])
    // 只有一份同意 —— 没有逐项的开关。
    expect(request.consent).toEqual({ granted: true })
    expect(request.contact).toEqual({
      name: '张三',
      organization: '某大学',
      email: 'z@example.com',
      phone: '13800000000',
    })
  })

  it('always carries the version block, because it is part of the same consent', () => {
    expect(buildActivationRequest(draft()).diagnostics).toEqual({
      studio: '0.1.0',
      sdk: '2.1.0',
      firmware: 'Litearm1.8.0-7J',
    })
  })

  it('trims the fields and lowercases the uid', () => {
    const request = buildActivationRequest(
      draft({
        uid: `  ${UID.toUpperCase()}  `,
        contact: {
          ...EMPTY_CONTACT,
          name: '  张三 ',
          organization: ' 某大学',
          email: ' z@x.io ',
          phone: ' 13800000000 ',
        },
      }),
    )
    expect(request.uid).toBe(UID)
    expect(request.contact).toEqual({
      name: '张三',
      organization: '某大学',
      email: 'z@x.io',
      phone: '13800000000',
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
  it('needs consent, a uid and all four contact fields — phone included', () => {
    expect(canSubmitActivation(draft())).toBe(true)
    expect(canSubmitActivation(draft({ consentGranted: false }))).toBe(false)
    expect(canSubmitActivation(draft({ uid: '  ' }))).toBe(false)
    // 电话是必填：少一个字段就不让提交。
    expect(
      canSubmitActivation(draft({ contact: { ...EMPTY_CONTACT, name: '张三' } })),
    ).toBe(false)
    expect(
      canSubmitActivation(
        draft({
          contact: {
            name: '张三',
            organization: '某大学',
            email: 'z@example.com',
            phone: '   ',
          },
        }),
      ),
    ).toBe(false)
  })

  it('names the fields that are still missing', () => {
    expect(missingContactFields({ ...EMPTY_CONTACT, name: '张三' })).toEqual([
      'organization',
      'email',
      'phone',
    ])
    expect(missingContactFields(EMPTY_CONTACT)).toEqual([
      'name',
      'organization',
      'email',
      'phone',
    ])
  })
})
