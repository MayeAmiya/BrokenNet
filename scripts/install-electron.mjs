// npm 11 起默认拦截依赖包的 install 脚本，electron 的二进制不会自动下载；
// 同时自定义的 electron_mirror 配置也不再传进脚本环境。
// 所以这里由项目自己的 postinstall 补上这一步（根项目的脚本不受 allow-scripts 拦截）。
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'

const require = createRequire(import.meta.url)

let electronDir
try {
  electronDir = dirname(require.resolve('electron/package.json'))
} catch {
  console.log('[electron] 尚未安装，跳过')
  process.exit(0)
}

if (existsSync(join(electronDir, 'dist', 'electron.exe'))) {
  console.log('[electron] 二进制已存在，跳过下载')
  process.exit(0)
}

console.log('[electron] 正在下载二进制…')
const r = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // 国内直连 GitHub Release 经常超时，走 npmmirror
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'
  }
})

process.exit(r.status ?? 1)
