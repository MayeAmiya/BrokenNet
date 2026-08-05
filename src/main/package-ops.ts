/**
 * 包管理 —— 替代原 MOD 体系。
 *
 * - 包存储：resourceDir/<gameId>/packages/<包名>/（每个子文件夹是一个包）
 * - 播放集：modsets.json 存 { packages: [{id,name}] }（旧字段 mods 读兼容，写用 packages）
 * - 迁移：mods/ → packages/、modsets.json mods → packages，幂等
 * - 本阶段只做本地导入（文件夹/压缩包）+ 删除；repo 下载走 mod:*（mod-ops.ts，落盘 packages/）
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { mkdir, stat, rename, readdir, readFile, rm, cp, writeFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extractArchive } from './archive'
import { getResourceDir } from './resource-dir'
import type { PlaySet, InstalledPackage, ImportResult } from '../shared/types/content'

/** 复制游戏本体时排除的运行时写目录（MentalOmega 包只含只读资源） */
export const GAME_COPY_EXCLUDE = new Set([
  'UserData', 'Saved Games', 'Screenshots', 'Client', 'EasyAntiCheat',
  'plugins', 'GeneralsOnlineGameData', 'Map Editor', 'Resources',
  'Logs', 'SettingsCache', 'tunnel_cache', 'ClientCrashLogs'
])

/** 包存储目录 resourceDir/<gameId>/packages */
async function getPackagesDir(gameId: string): Promise<string> {
  const resourceDir = await getResourceDir()
  if (resourceDir) return join(resourceDir, gameId, 'packages')
  return join(process.cwd(), 'packages')
}

/** 播放集文件路径 modsets.json */
async function getModSetsPath(gameId: string): Promise<string | null> {
  const resourceDir = await getResourceDir()
  if (resourceDir) return join(resourceDir, gameId, 'modsets.json')
  return null
}

/** 从 game.ini 读游戏安装目录 */
async function getInstallPath(gameId: string): Promise<string> {
  const resourceDir = await getResourceDir()
  if (!resourceDir) return ''
  const gameIniPath = join(resourceDir, gameId, 'game.ini')
  try {
    const data = await readFile(gameIniPath, 'utf-8')
    for (const line of data.split(/\r?\n/)) {
      const m = line.match(/^installPath=(.*)$/)
      if (m) return m[1].trim()
    }
  } catch { /* 不存在 */ }
  return ''
}

/** 加载播放集（兼容旧 mods 字段） */
async function loadPlaySets(gameId: string): Promise<PlaySet[]> {
  try {
    const path = await getModSetsPath(gameId)
    if (!path) return []
    const data = await readFile(path, 'utf-8')
    const sets = JSON.parse(data) as Array<PlaySet & { mods?: Array<{ id: string; name: string }> }>
    return sets.map((s) => ({
      ...s,
      packages: s.packages ?? s.mods ?? []
    }))
  } catch {
    return []
  }
}

/** 保存播放集（始终写 packages 字段） */
async function savePlaySets(gameId: string, playSets: PlaySet[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const path = await getModSetsPath(gameId)
    if (!path) return { ok: false, error: '请先设置资源目录' }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(playSets, null, 2), 'utf-8')
    console.log(`[savePlaySets] ${path} 写入 ${playSets.length} 个播放集: ${playSets.map(s => s.id).join(',')}`)
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    console.error('[savePlaySets] 失败:', err.message)
    return { ok: false, error: err.message }
  }
}

/**
 * 迁移旧 mod 体系 → 包体系（幂等）：
 * 1. mods/ → packages/（packages 不存在时才重命名；两者都在则 packages 为准）
 * 2. modsets.json mods 字段 → packages
 * 3. 确保 packages/MentalOmega（游戏本体）
 * 4. 确保 vanilla 播放集
 */
async function ensureDefaultPlaySet(gameId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const packagesDir = await getPackagesDir(gameId)
    const legacyModsDir = join(packagesDir, '..', 'mods')

    // 1. mods/ → packages/
    if (!existsSync(packagesDir) && existsSync(legacyModsDir)) {
      await mkdir(dirname(packagesDir), { recursive: true })
      await rename(legacyModsDir, packagesDir)
      console.log(`[Packages] 已迁移 mods/ -> packages/ (${gameId})`)
    }
    await mkdir(packagesDir, { recursive: true })

    // 2. modsets.json mods → packages
    const setsPath = await getModSetsPath(gameId)
    let sets: Array<PlaySet & { mods?: Array<{ id: string; name: string }> }> = []
    let readOk = false
    if (setsPath && existsSync(setsPath)) {
      try {
        sets = JSON.parse(await readFile(setsPath, 'utf-8'))
        readOk = true
      } catch (e) {
        console.error(`[Packages] modsets.json 读取失败（保留原文件）: ${(e as Error).message}`)
        sets = []
      }
      let changed = false
      for (const s of sets) {
        if (Array.isArray(s.mods) && !Array.isArray(s.packages)) {
          s.packages = s.mods
          delete s.mods
          changed = true
        }
      }
      if (changed) await savePlaySets(gameId, sets)
    }

    // 3. 确保 packages/MentalOmega（游戏本体）
    const basePkgDir = join(packagesDir, 'MentalOmega')
    if (!existsSync(basePkgDir)) {
      const installPath = await getInstallPath(gameId)
      if (installPath && existsSync(installPath)) {
        await cp(installPath, basePkgDir, {
          recursive: true,
          filter: (src) => {
            const name = basename(src)
            return !GAME_COPY_EXCLUDE.has(name)
          }
        })
        console.log(`[Packages] 已复制游戏本体 -> ${basePkgDir}`)
      } else {
        await mkdir(basePkgDir, { recursive: true })
      }
    }

    // 4. 确保 vanilla 播放集（仅当文件不存在或成功读到时才写，避免把已有播放集覆盖掉）
    if (readOk || !setsPath || !existsSync(setsPath)) {
      if (!sets.some((s) => s.id === 'vanilla')) {
        sets.unshift({
          id: 'vanilla',
          name: '原版',
          description: '只加载游戏本体（MentalOmega）',
          packages: [{ id: 'MentalOmega', name: 'MentalOmega' }]
        })
        await savePlaySets(gameId, sets)
      }
    }

    return { ok: true }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}

/** 列出已安装包 */
async function listPackages(gameId: string): Promise<InstalledPackage[]> {
  try {
    const packagesDir = await getPackagesDir(gameId)
    await mkdir(packagesDir, { recursive: true })
    const entries = await readdir(packagesDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(packagesDir, e.name) }))
  } catch {
    return []
  }
}

/** 目标不存在时返回原始名，否则加 (2) (3) … 后缀 */
async function uniqueName(packagesDir: string, name: string): Promise<string> {
  if (!existsSync(join(packagesDir, name))) return name
  let i = 2
  while (existsSync(join(packagesDir, `${name} (${i})`))) i++
  return `${name} (${i})`
}

/**
 * 按给定路径导入包（按钮弹窗与拖拽共用）。
 * - 文件夹 → 复制为 packages/<文件夹名>
 * - 压缩包（zip/7z/rar）→ 解压到临时目录，单顶层目录提升为包根，否则整个 temp 作为包
 * - 其他文件跳过
 * 重名自动后缀。
 */
async function importPackageFromPaths(gameId: string, filePaths: string[]): Promise<ImportResult> {
  try {
    const packagesDir = await getPackagesDir(gameId)
    await mkdir(packagesDir, { recursive: true })
    const imported: string[] = []

    for (const filePath of filePaths) {
      let s: import('node:fs').Stats
      try { s = await stat(filePath) } catch { continue }
      const isArchive = /\.(zip|7z|rar)$/i.test(filePath)

      if (s.isDirectory()) {
        const name = await uniqueName(packagesDir, basename(filePath))
        await cp(filePath, join(packagesDir, name), { recursive: true })
        imported.push(name)
      } else if (isArchive) {
        const name = await uniqueName(packagesDir, basename(filePath).replace(/\.[^.]+$/, ''))
        const tempDir = join(packagesDir, `.import-${randomUUID()}`)
        try {
          await extractArchive(filePath, tempDir)
          // 单顶层目录 → 提升为包根
          const entries = await readdir(tempDir, { withFileTypes: true })
          if (entries.length === 1 && entries[0].isDirectory()) {
            await rename(join(tempDir, entries[0].name), join(packagesDir, name))
          } else {
            await rename(tempDir, join(packagesDir, name))
          }
          imported.push(name)
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
      }
      // 其他文件跳过
    }

    return imported.length ? { ok: true, imported } : { ok: false, error: '没有可导入的包' }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}

/** 删除包 */
async function deletePackage(gameId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const packagesDir = await getPackagesDir(gameId)
    await rm(join(packagesDir, name), { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}

/** 注册包 / 播放集 IPC */
export function registerPackageHandlers(): void {
  ipcMain.handle('package:list', async (_e, gameId: string) => {
    return { ok: true, packages: await listPackages(gameId) }
  })
  // 导入：文件夹弹窗 / 压缩包弹窗 / 拖拽路径（共用 importPackageFromPaths）
  ipcMain.handle('package:import-folder', async (e, gameId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: '无法获取窗口' }
    const result = await dialog.showOpenDialog(win, { title: '导入文件夹', properties: ['openDirectory', 'multiSelections'] })
    if (result.canceled || !result.filePaths.length) return { ok: false, error: '已取消' }
    return importPackageFromPaths(gameId, result.filePaths)
  })
  ipcMain.handle('package:import-archive', async (e, gameId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: '无法获取窗口' }
    const result = await dialog.showOpenDialog(win, {
      title: '导入压缩包',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '压缩包', extensions: ['zip', '7z', 'rar'] }]
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, error: '已取消' }
    return importPackageFromPaths(gameId, result.filePaths)
  })
  ipcMain.handle('package:import-paths', (_e, gameId: string, paths: string[]) => importPackageFromPaths(gameId, paths))
  ipcMain.handle('package:delete', (_e, gameId: string, name: string) => deletePackage(gameId, name))

  ipcMain.handle('modset:list', async (_e, gameId: string) => {
    return { ok: true, modSets: await loadPlaySets(gameId) }
  })
  ipcMain.handle('modset:save', (_e, gameId: string, playSets: PlaySet[]) => {
    console.log(`[modset:save] gameId=${gameId} 收到 ${playSets?.length} 个播放集`)
    return savePlaySets(gameId, playSets)
  })
  ipcMain.handle('modset:ensure-default', (_e, gameId: string) => ensureDefaultPlaySet(gameId))
}
