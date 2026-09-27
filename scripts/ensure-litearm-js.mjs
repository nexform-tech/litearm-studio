// 确保 litearm-js 的浏览器产物存在且不旧于源码（发布构建前调用，跨平台）。
//
// litearm-js 是 package.json 里的 file: 依赖，pnpm install 会把它拷贝进依赖存储；
// 若 dist/litearm.mjs 缺失，构建会因无法解析 litearm-js/browser 而失败。
// 本地、Docker、Windows、CI 都可安全重复执行：产物新时直接跳过。
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sdk = path.resolve(here, '../..', 'litearm-js')
const bundle = path.join(sdk, 'dist', 'litearm.mjs')
const srcDir = path.join(sdk, 'src')

if (!existsSync(path.join(srcDir, 'index-browser.ts'))) {
  console.error(`错误：找不到 litearm-js 源码（${sdk}）`)
  process.exit(1)
}

function newestMtime(dir) {
  let newest = 0
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = statSync(p)
    newest = Math.max(newest, st.isDirectory() ? newestMtime(p) : st.mtimeMs)
  }
  return newest
}

if (existsSync(bundle) && statSync(bundle).mtimeMs >= newestMtime(srcDir)) {
  console.log('litearm-js browser bundle is up to date.')
  process.exit(0)
}

console.log('>>> rebuilding litearm-js browser bundle...')
if (!existsSync(path.join(sdk, 'node_modules'))) {
  execSync('npm install --no-audit --no-fund', { cwd: sdk, stdio: 'inherit' })
}
execSync('npm run build', { cwd: sdk, stdio: 'inherit' })
