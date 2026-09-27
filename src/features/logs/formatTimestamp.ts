/** 时间显示：兼容 ISO 字符串与 epoch 秒。 */
export function formatTimestamp(value: string | number, locale: string) {
  if (value === '' || value === undefined || value === null) return ''
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(locale.startsWith('en') ? 'en-US' : 'zh-CN', { hour12: false })
}
