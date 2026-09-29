import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONTACT,
  buildActivationRequest,
  canSubmitActivation,
  missingContactFields,
  previewJson,
} from './activationPayload'

const UID = '101112131415161718191a1b'

function draft(over: Partial<Parameters<typeof buildActivationRequest>[0]> = {}) {
  return {
    uid: UID,
    contact: { name: '张三', organization: '某大学', email: 'z@example.com', phone: '' },
    consentRequired: true,
    consentDiagnostics: false,
    diagnostics: { studio: '0.1.0', sdk: '2.1.0', firmware: 'Litearm1.8.0-7J' },
    ...over,
  }
}

describe('buildActivationRequest', () => {
  it('sends exactly what the preview shows', () => {
    const request = buildActivationRequest(draft())
    // 预览渲染的就是这个对象 —— 这是"不许有暗字段"那条约束的落点。
    expect(JSON.parse(previewJson(request))).toEqual(request)
    expect(request).toEqual({
      uid: UID,
      contact: { name: '张三', organization: '某大学', email: 'z@example.com', phone: '' },
      consent: { required: true, diagnostics: false },
    })
  })

  it('keeps diagnostics out unless the operator agreed to them', () => {
    expect(buildActivationRequest(draft()).diagnostics).toBeUndefined()
    const withDiag = buildActivationRequest(draft({ consentDiagnostics: true }))
    expect(withDiag.diagnostics).toEqual({
      studio: '0.1.0',
      sdk: '2.1.0',
      firmware: 'Litearm1.8.0-7J',
    })
  })

  it('trims the fields and lowercases the uid', () => {
    const request = buildActivationRequest(
      draft({
        uid: `  ${UID.toUpperCase()}  `,
        contact: { ...EMPTY_CONTACT, name: '  张三 ', organization: ' 某大学', email: ' z@x.io ' },
      }),
    )
    expect(request.uid).toBe(UID)
    expect(request.contact).toEqual({
      name: '张三',
      organization: '某大学',
      email: 'z@x.io',
      phone: '',
    })
  })

  it('omits an empty order code instead of sending an empty field', () => {
    expect('code' in buildActivationRequest(draft())).toBe(false)
    expect(buildActivationRequest(draft({ code: ' A-42 ' })).code).toBe('A-42')
  })

  it('reflects an unticked consent box in the preview (the daemon is the gate)', () => {
    // 预览要如实显示"没勾选时的请求长什么样" —— 服务端会拒, 但界面不能假装它没这回事。
    expect(buildActivationRequest(draft({ consentRequired: false })).consent.required).toBe(false)
  })
})

describe('canSubmitActivation', () => {
  it('needs consent, a uid and the required contact fields', () => {
    expect(canSubmitActivation(draft())).toBe(true)
    expect(canSubmitActivation(draft({ consentRequired: false }))).toBe(false)
    expect(canSubmitActivation(draft({ uid: '  ' }))).toBe(false)
    expect(canSubmitActivation(draft({ contact: { ...EMPTY_CONTACT, name: '张三' } }))).toBe(false)
  })

  it('does not require the optional phone number', () => {
    expect(canSubmitActivation(draft())).toBe(true)
  })

  it('names the fields that are still missing', () => {
    expect(missingContactFields({ ...EMPTY_CONTACT, name: '张三' })).toEqual([
      'organization',
      'email',
    ])
    expect(missingContactFields({ ...EMPTY_CONTACT, name: '  ' })).toEqual([
      'name',
      'organization',
      'email',
    ])
  })
})
