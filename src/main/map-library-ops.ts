/**
 * 独立地图库 —— 下载/导入地图专用。
 *
 * 结构（文件夹包）：resourceDir/<gameId>/maps/<图名>/ 内含 .map 文件 + 可选配置
 * （模式/预设，格式 TBD，读取时留扩展点）。
 * 原有地图仍从安装目录 MentalOmegaMaps.ini 读，不在此库。
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { mkdir, stat, rename, readdir, rm, cp } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extractArchive } from './archive'
import { getResourceDir } from './resource-dir'
import { MAP_EXTENSIONS } from './map-preview'
import type { LibraryMap, ImportResult } from '../shared/types/content'

/** 地图库目录 resourceDir/<gameId>/maps */
async function getMapsDir(gameId: string): Promise<string> {
  const resourceDir = await getResourceDir()
  if (resourceDir) return join(resourceDir, gameId, 'maps')
  return join(process.cwd(), 'maps')
}

function isMapFile(name: string): boolean {
  return MAP_EXTENSIONS.includes(extname(name).toLowerCase())
}

/** 列出地图库中的包（每个包 = 一个子文件夹，含至少一个 .map） */
export async function listLibraryMaps(gameId: string): Promise<LibraryMap[]> {
  try {
    const mapsDir = await getMapsDir(gameId)
    await mkdir(mapsDir, { recursive: true })
    const entries = await readdir(mapsDir, { withFileTypes: true })
    const result: LibraryMap[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const pkgDir = join(mapsDir, entry.name)
      const mapFile = await findMapInBundle(pkgDir)
      if (!mapFile) continue
      try {
        const s = await stat(mapFile)
        result.push({ id: entry.name, name: entry.name, path: mapFile, size: s.size })
      } catch { /* 忽略不可读 */ }
    }
    return result
  } catch {
    return []
  }
}

/** 在包文件夹里找 .map 文件（取第一个） */
export async function findMapInBundle(pkgDir: string): Promise<string | null> {
  const entries = await readdir(pkgDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isDirectory()) continue
    if (isMapFile(e.name)) return join(pkgDir, e.name)
  }
  return null
}

async function uniqueName(mapsDir: string, name: string): Promise<string> {
  if (!existsSync(join(mapsDir, name))) return name
  let i = 2
  while (existsSync(join(mapsDir, `${name} (${i})`))) i++
  return `${name} (${i})`
}

/**
 * 导入地图：弹窗选文件夹（地图包）/ .map 文件 / 压缩包。
 * - 文件夹 → 复制为 maps/<文件夹名>（已是包结构）
 * - .map 文件 → 包一层文件夹 maps/<图名>/<图名>.map（保持文件夹包结构）
 * - 压缩包 → 解压到 maps/<图名>/（单顶层目录提升为包根）
 */
async function importMaps(webContents: Electron.WebContents, gameId: string): Promise<ImportResult> {
  try {
    const win = BrowserWindow.fromWebContents(webContents)
    if (!win) return { ok: false, error: '无法获取窗口' }

    // Windows：openDirectory + filters 会让文件不可选（只剩文件夹），不设 filters。
    // 非地图/非压缩包的文件在循环里跳过。
    const result = await dialog.showOpenDialog(win, {
      title: '导入地图',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })

    if (result.canceled || !result.filePaths.length) return { ok: false, error: '已取消' }

    const mapsDir = await getMapsDir(gameId)
    await mkdir(mapsDir, { recursive: true })
    const imported: string[] = []

    for (const filePath of result.filePaths) {
      const s = await stat(filePath)
      const name = basename(filePath).replace(/\.[^.]+$/, '')

      if (s.isDirectory()) {
        const target = await uniqueName(mapsDir, basename(filePath))
        await cp(filePath, join(mapsDir, target), { recursive: true })
        imported.push(target)
      } else if (isMapFile(filePath)) {
        const target = await uniqueName(mapsDir, name)
        const pkgDir = join(mapsDir, target)
        await mkdir(pkgDir, { recursive: true })
        await cp(filePath, join(pkgDir, `${target}${extname(filePath)}`))
        imported.push(target)
      } else if (/\.(zip|7z|rar)$/i.test(filePath)) {
        const target = await uniqueName(mapsDir, name)
        const tempDir = join(mapsDir, `.import-${randomUUID()}`)
        try {
          await extractArchive(filePath, tempDir)
          const entries = await readdir(tempDir, { withFileTypes: true })
          if (entries.length === 1 && entries[0].isDirectory()) {
            await rename(join(tempDir, entries[0].name), join(mapsDir, target))
          } else {
            await rename(tempDir, join(mapsDir, target))
          }
          imported.push(target)
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
      }
    }

    return imported.length ? { ok: true, imported } : { ok: false, error: '没有可导入的地图' }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}

/** 删除地图包 */
async function deleteMap(gameId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const mapsDir = await getMapsDir(gameId)
    await rm(join(mapsDir, name), { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}

/** 注册地图库 IPC */
export function registerMapLibraryHandlers(): void {
  ipcMain.handle('maps:import', (e, gameId: string) => importMaps(e.sender, gameId))
  ipcMain.handle('maps:delete', (_e, gameId: string, name: string) => deleteMap(gameId, name))
  ipcMain.handle('maps:list-library', async (_e, gameId: string) => {
    return { ok: true, maps: await listLibraryMaps(gameId) }
  })
}
