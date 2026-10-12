/**
 * i18n 静态守卫 (issue #131)。
 *
 * `src/i18n/index.ts` 没配 `missingKeyHandler`, 所以键写错或漏翻时页面直接把**键名**显示给
 * 操作员 —— `settings:installation.gateArmed` 就是这样上过线的 (issue #129): 那行代码在
 * 审查里没人看出来, 因为只钉具体字符串的那套用例覆盖不到"全量引用"。这里补两件:
 *
 * 1. 扫 src 下所有 .ts / .tsx 里**字面量**的 `t('ns:path')` / `i18n.t('ns:path')` 引用,
 *    断言每个键在两种语言里都有 (复数后缀 `_one` / `_other` … 算同一族)。
 * 2. 断言 `en/<ns>.json` 与 `zh/<ns>.json` 的键集合完全一致 —— 这一条自己就能挡住历史上
 *    出现过好几次的单边漏翻。
 *
 * 动态查表必须继续能写, 所以以下三种**不算引用**, 不检查: 模板字面量
 * (`t(\`gripper:gate.${gate}_why\`)`)、带 `defaultValue` 的兜底查表
 * (`t('common:metrics.' + id, { defaultValue: id })`)、以及拼接出来的键。扫描器本身有
 * 断言兜着 (见最后一个用例), 免得它坏掉之后整套守卫变成静默空转。
 */
import { describe, expect, it } from 'vitest'
import { resources } from '../index'

type Locale = 'en' | 'zh'

const LOCALES: Locale[] = ['en', 'zh']
/** 没有命名空间前缀的 `t('stop')` 走 defaultNS (见 `src/i18n/index.ts`)。 */
const DEFAULT_NS = 'common'

/**
 * locale JSON 与源码都用 Vite 的 `import.meta.glob` 在构建期收进来 —— 这是前端工程
 * (`tsconfig.app.json` 只给 `vite/client` 类型), 没有 `node:fs` 可用, 也不需要。
 */
const LOCALE_FILES = import.meta.glob('../locales/*/*.json', {
  eager: true, import: 'default',
}) as Record<string, unknown>
const SOURCE_FILES = import.meta.glob('../../**/*.{ts,tsx}', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>

// ── locale 文件 ─────────────────────────────────────────────────────────────

/** 扁平化成 `a.b.c` → 值; 只有叶子进集合 (键集合比对与存在性检查都只看叶子)。 */
function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      for (const [key, leaf] of flatten(v, prefix ? `${prefix}.${k}` : k)) out.set(key, leaf)
    }
  } else if (prefix) {
    out.set(prefix, String(value))
  }
  return out
}

/** lng → ns → 扁平键表。 */
const LOCALE: Record<Locale, Map<string, Map<string, string>>> = { en: new Map(), zh: new Map() }
for (const [file, json] of Object.entries(LOCALE_FILES)) {
  const parsed = /\/locales\/(en|zh)\/([^/]+)\.json$/.exec(file)
  if (parsed) LOCALE[parsed[1] as Locale].set(parsed[2], flatten(json))
}

function namespaces(lng: Locale): string[] {
  return [...LOCALE[lng].keys()].sort()
}

// ── 源码扫描 ────────────────────────────────────────────────────────────────

/** 从 `(` 之后扫到配对的 `)` —— 用来判断这次调用带不带 `defaultValue`。 */
function callArguments(text: string, start: number): string | null {
  let depth = 1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(start, i)
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
    }
  }
  return null
}

/** 抽出一段源码里**字面量**的 i18n 键引用 (动态查表按上面的规矩跳过)。 */
export function literalKeys(text: string): { key: string; index: number }[] {
  const out: { key: string; index: number }[] = []
  let i = 0
  for (;;) {
    const at = text.indexOf('t(', i)
    if (at < 0) return out
    i = at + 2
    // 别把 `format(` / `split(` / `at(` 这类名字以 t 结尾的函数当成 t()。
    const prev = at > 0 ? text[at - 1] : ''
    if (prev && /[A-Za-z0-9_$]/.test(prev)) continue
    let j = i
    while (j < text.length && /\s/.test(text[j])) j++
    const quote = text[j]
    if (quote !== "'" && quote !== '"') continue // 模板字面量或变量 ⇒ 动态键
    let k = j + 1
    while (k < text.length && text[k] !== quote) k += text[k] === '\\' ? 2 : 1
    if (k >= text.length) return out
    const args = callArguments(text, k + 1)
    if (args === null) continue
    if (args.includes('defaultValue')) continue // 兜底查表: 缺键也读得通
    const literal = text.slice(j + 1, k)
    if (/^\s*\+/.test(args) || literal.endsWith('.')) continue // 拼接出来的键
    out.push({ key: literal, index: at })
  }
}

/**
 * 没有前缀的裸键 (`t('speed')`) 落在哪个命名空间, 由**文件自己**决定:
 *
 * * `useTranslation('solo')` / `useTranslation(['common', 'nav'])` 给的就是候选集;
 * * 文件里若有个前缀包装 (`const t = (key) => i18n.t(\`common:errors.${key}\`)`), 裸键
 *   说的就是那个前缀下的键 (见 `src/lib/arm/errors.ts`);
 * * 两者都没有 (直接调 `i18n.t`) 就按 defaultNS —— `common`。
 */
function bareKeyNamespaces(text: string): { ns: string; prefix: string }[] {
  const prefixed = /i18n\.t\(\s*`([A-Za-z0-9_-]+):([A-Za-z0-9_.-]*?)\$\{/.exec(text)
  if (prefixed) return [{ ns: prefixed[1], prefix: prefixed[2] }]
  const out: string[] = []
  for (const call of text.matchAll(/useTranslation\(([^)]*)\)/g)) {
    for (const quoted of call[1].matchAll(/['"]([^'"]+)['"]/g)) out.push(quoted[1])
  }
  return [...new Set(out.length ? out : [DEFAULT_NS])].map((ns) => ({ ns, prefix: '' }))
}

/**
 * `ns|path` 形式的候选全名 —— 一个裸键可能落在文件声明的好几个命名空间里, 命中任意一个
 * 即可。`ns:path` 这种带前缀的引用只有一个候选。
 */
function candidatesFor(ref: string, names: string[],
                       bare: { ns: string; prefix: string }[]): string[] {
  const colon = ref.indexOf(':')
  if (colon < 0) return bare.map(({ ns, prefix }) => `${ns}|${prefix}${ref}`)
  const ns = ref.slice(0, colon)
  const key = ref.slice(colon + 1)
  return key && names.includes(ns) ? [`${ns}|${key}`] : []
}

/** 存在性: 精确命中, 或者命中复数族 (`key_one` / `key_other` / …)。 */
function has(flat: Map<string, string>, key: string): boolean {
  if (flat.has(key)) return true
  for (const candidate of flat.keys()) {
    if (candidate.startsWith(`${key}_`)) return true
  }
  return false
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

const SOURCES = Object.entries(SOURCE_FILES)
  .filter(([file]) => !/\.test\.tsx?$/.test(file))
  .map(([file, text]) => ({ path: file.replace(/^\.\.\/\.\.\//, 'src/'), text }))

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('i18n keys', () => {
  it('两种语言有同一组命名空间, 且都注册进了 resources', () => {
    expect(namespaces('zh')).toEqual(namespaces('en'))
    expect(Object.keys(resources.en).sort()).toEqual(namespaces('en'))
    expect(Object.keys(resources.zh).sort()).toEqual(namespaces('en'))
    expect(namespaces('en').length).toBeGreaterThan(5)
  })

  it('每个命名空间的键集合在两种语言里一致', () => {
    for (const ns of namespaces('en')) {
      const en = [...(LOCALE.en.get(ns) ?? new Map()).keys()].sort()
      const zh = [...(LOCALE.zh.get(ns) ?? new Map()).keys()].sort()
      expect({ ns, keys: en }).toEqual({ ns, keys: zh })
    }
  })

  it('代码里引用的字面量键在两种语言里都存在', () => {
    const missing: string[] = []
    let checked = 0
    for (const { path: file, text } of SOURCES) {
      const bare = bareKeyNamespaces(text)
      for (const { key, index } of literalKeys(text)) {
        const candidates = candidatesFor(key, namespaces('en'), bare)
        if (candidates.length === 0) continue
        checked++
        for (const lng of LOCALES) {
          const found = candidates.some((candidate) => {
            const [ns, key] = candidate.split('|')
            const dict = LOCALE[lng].get(ns)
            return dict !== undefined && has(dict, key)
          })
          if (!found) {
            missing.push(`${file}:${lineOf(text, index)}  ${lng}:${key}  →  ${candidates.join(' / ')}`)
          }
        }
      }
    }

    expect(missing).toEqual([])
    // 扫描器要是哪天扫不出东西, 上面那条会变成空转 —— 这个下限就是防它的。
    expect(checked).toBeGreaterThan(300)
  })

  it('动态查表不会被当成字面量引用', () => {
    const sample = [
      'return `${t(`gripper:gate.${gate}`)}`',
      "const name = t('common:metrics.' + id, { defaultValue: id })",
      'const why = i18n.t(`common:errors.${key}`)',
    ].join('\n')
    expect(literalKeys(sample)).toEqual([])
  })
})
