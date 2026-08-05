import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 资源目录（config.json 的 resourceDir）。
 * 所有包/地图/播放集等资源的根目录。
 */
export async function getResourceDir(): Promise<string> {
  try {
    const { app } = await import('electron')
    const configPath = join(app.getPath('userData'), 'config.json')
    const data = await readFile(configPath, 'utf-8')
    const config = JSON.parse(data) as Record<string, string>
    if (config.resourceDir) return config.resourceDir
  } catch { /* 配置不存在 */ }
  return ''
}

/**
 * 全局设置存储目录 resourceDir/<gameId>/settings。
 * 画质/快捷键/音量设置存这里（不按播放集），playground 构建时硬链接进游戏目录。
 */
export async function getSettingsDir(gameId: string): Promise<string> {
  const resourceDir = await getResourceDir()
  return resourceDir ? join(resourceDir, gameId, 'settings') : ''
}
