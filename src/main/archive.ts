import { stat, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** 查找 7z.exe 路径 */
export async function find7zExe(): Promise<string> {
  const candidates = [
    // 打包后 resources 目录
    join(process.resourcesPath || process.cwd(), '7z.exe'),
    // 开发模式
    join(process.cwd(), 'resources', '7z.exe'),
    // 系统安装
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ]
  for (const p of candidates) {
    try {
      await stat(p)
      return p
    } catch { /* 不存在 */ }
  }
  throw new Error('未找到 7z.exe，请安装 7-Zip：https://7-zip.org')
}

/** 解压 RAR/ZIP/7Z 文件（统一用 7z.exe） */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  await stat(archivePath)

  console.log(`[解压] ${archivePath} -> ${destDir}`)

  const binPath = await find7zExe()
  console.log(`[解压] 7z: ${binPath}`)

  try {
    await execFileAsync(binPath, ['x', archivePath, `-o${destDir}`, '-y'])
    console.log('[解压] 完成')
  } catch (e) {
    console.error('[解压] 失败:', (e as Error).message)
    throw new Error(`解压失败: ${(e as Error).message}`)
  }
}
