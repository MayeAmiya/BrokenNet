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
import { resolveDirectChild } from './security-boundaries'
import { getModRoot, readManagedMods, readDownloadedMods, writeDownloadedMods, unmarkDownloadedMod } from './downloaded-mod-registry'
import { downloadFile } from './mod-ops'

const modSetOperationQueues = new Map<string, Promise<unknown>>()

function enqueueModSetOperation<T>(gameId: string, operation: () => Promise<T>): Promise<T> {
  const previous = modSetOperationQueues.get(gameId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  modSetOperationQueues.set(gameId, current)
  void current.finally(() => {
    if (modSetOperationQueues.get(gameId) === current) modSetOperationQueues.delete(gameId)
  })
  return current
}

/** 复制游戏本体时排除的运行时写目录（本体包只含只读资源） */
export const GAME_COPY_EXCLUDE = new Set([
  'UserData', 'Saved Games', 'Screenshots', 'Client', 'EasyAntiCheat',
  'plugins', 'GeneralsOnlineGameData', 'Map Editor',
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

function getBasePackage(gameId: string): { name: string; displayName: string } {
  return gameId === 'mental-omega'
    ? { name: 'MentalOmega', displayName: 'Mental Omega' }
    : { name: 'ZeroHour', displayName: 'Zero Hour' }
}

function getForeignBasePackage(gameId: string): string {
  return gameId === 'mental-omega' ? 'ZeroHour' : 'MentalOmega'
}

function makeZhPackagePlaySet(packageName: string, existing?: PlaySet): PlaySet {
  const extraPackages = existing?.packages
    .filter((pkg) => pkg.name !== 'ZeroHour' && pkg.name !== packageName)
    .map((pkg) => ({ id: pkg.name, name: pkg.name })) ?? []
  return {
    id: `zh-package:${packageName}`,
    name: existing?.name ?? packageName,
    description: existing?.description ?? `以 Zero Hour 为基底，加载 ${packageName}`,
    packages: [
      { id: 'ZeroHour', name: 'ZeroHour' },
      { id: packageName, name: packageName },
      ...extraPackages
    ]
  }
}

/** ZH 固定为一个 MOD 对应一个播放集；MO 仍保留手工组合播放集。 */
async function syncZhPackagePlaySets(packagesDir: string, sets: PlaySet[]): Promise<PlaySet[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packageNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.endsWith('.downloading') && entry.name !== 'MentalOmega')
    .map((entry) => entry.name)
  const downloadedMods = await readManagedMods(packagesDir)
  const mainPackages = downloadedMods.filter((name) => existsSync(join(getModRoot(packagesDir, name), name)))
  const vanilla = sets.find((set) => set.id === 'vanilla') ?? {
    id: 'vanilla',
    name: '原版',
    description: '只加载游戏本体（Zero Hour）',
    packages: [{ id: 'ZeroHour', name: 'ZeroHour' }]
  }
  vanilla.description = '只加载游戏本体（Zero Hour）'
  vanilla.packages = [{ id: 'ZeroHour', name: 'ZeroHour' }]

  // 保留前端传入的所有非 zh-package、非 vanilla 的用户播放集（zh-copy、自定义等）
  const userSets = sets
    .filter((s) => !s.id.startsWith('zh-package:') && s.id !== 'vanilla')
    .map((set) => {
      const mainPackage = set.packages.find((pkg) => mainPackages.includes(pkg.name))?.name
      const extraPackages = set.packages
        .map((pkg) => pkg.name)
        .filter((name) => name !== 'ZeroHour' && name !== mainPackage && existsSync(join(packagesDir, name)))
      return {
        ...set,
        packages: [
          { id: 'ZeroHour', name: 'ZeroHour' },
          ...(mainPackage ? [{ id: mainPackage, name: mainPackage }] : []),
          ...extraPackages.map((name) => ({ id: name, name }))
        ]
      }
    })

  // 前端已有的 zh-package 播放集（保留用户未删除的）
  const existingAutoSets = sets
    .filter((s) => s.id.startsWith('zh-package:'))
    .map((set) => {
      const name = set.id.slice('zh-package:'.length)
      return mainPackages.includes(name) ? makeZhPackagePlaySet(name, set) : null
    })
    .filter((set): set is PlaySet => set !== null)
  const existingAutoPkgNames = new Set(existingAutoSets.map((s) => s.id.replace('zh-package:', '')))

  // 只为「尚未有播放集」的新下载 MOD 自动创建播放集，不恢复用户已删除的
  const newAutoSets = mainPackages
    .filter((name) => !existingAutoPkgNames.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => makeZhPackagePlaySet(name))

  return [vanilla, ...existingAutoSets, ...newAutoSets, ...userSets]
}

/** 加载播放集（兼容旧 mods 字段） */
async function loadPlaySets(gameId: string): Promise<PlaySet[]> {
  try {
    const path = await getModSetsPath(gameId)
    if (!path) return []
    const data = await readFile(path, 'utf-8')
    const sets = JSON.parse(data) as Array<PlaySet & { mods?: Array<{ id: string; name: string }> }>
    const foreignBase = getForeignBasePackage(gameId)
    return sets
      .map((s) => ({
        ...s,
        packages: (s.packages ?? s.mods ?? []).filter((pkg) =>
          pkg.id !== foreignBase &&
          pkg.name !== foreignBase &&
          !pkg.id.endsWith('.downloading') &&
          !pkg.name.endsWith('.downloading')
        )
      }))
      .filter((s) => !s.id.endsWith(`:${foreignBase}`) && !s.id.endsWith('.downloading') && s.packages.length > 0)
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
 * 3. 确保当前游戏自己的本体包
 * 4. 确保 vanilla 播放集
 */
async function ensureDefaultPlaySet(gameId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const packagesDir = await getPackagesDir(gameId)
    const legacyModsDir = join(packagesDir, '..', 'mods')

    // 新结构是单向的：packages 中的历史下载包迁入 mods/<MOD>/，绝不把 mods 搬回 packages。
    await mkdir(packagesDir, { recursive: true })
    if (gameId === 'zero-hour') {
      const historicalNames = await readDownloadedMods(packagesDir)
      for (const modName of historicalNames) {
        const modRoot = getModRoot(packagesDir, modName)
        await mkdir(modRoot, { recursive: true })
        const names = await readdir(packagesDir, { withFileTypes: true })
        for (const entry of names) {
          if (!entry.isDirectory() || (entry.name !== modName && !entry.name.startsWith(`${modName}_patch_`) && !entry.name.startsWith(`${modName}_addon_`))) continue
          const target = join(modRoot, entry.name)
          if (!existsSync(target)) await rename(join(packagesDir, entry.name), target)
        }
      }
    }
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

    // 3. 每个游戏维护自己的本体包，不能让 MO 本体进入 ZH 播放集。
    const basePackage = getBasePackage(gameId)
    const basePkgDir = join(packagesDir, basePackage.name)
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

    // 4. 确保 vanilla 播放集指向当前游戏本体；修复早期 ZH 误引用 MentalOmega 的数据。
    if (readOk || !setsPath || !existsSync(setsPath)) {
      const vanilla = sets.find((s) => s.id === 'vanilla')
      if (!vanilla) {
        sets.unshift({
          id: 'vanilla',
          name: '原版',
          description: `只加载游戏本体（${basePackage.displayName}）`,
          packages: [{ id: basePackage.name, name: basePackage.name }]
        })
        await savePlaySets(gameId, sets)
      } else if (
        vanilla.packages.length !== 1 ||
        vanilla.packages[0]?.id !== basePackage.name ||
        vanilla.packages[0]?.name !== basePackage.name
      ) {
        vanilla.description = `只加载游戏本体（${basePackage.displayName}）`
        vanilla.packages = [{ id: basePackage.name, name: basePackage.name }]
        await savePlaySets(gameId, sets)
      }
    }

    if (gameId === 'zero-hour') {
      sets = await syncZhPackagePlaySets(packagesDir, sets)
      await savePlaySets(gameId, sets)
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
    return await Promise.all(entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.downloading') && e.name !== getForeignBasePackage(gameId))
      .map(async (e) => {
        const packagePath = join(packagesDir, e.name)
        let source: { provider: string; mod: string; slug: string; kind?: 'addon' | 'download'; fileId?: string; page?: string } | undefined
        try { source = JSON.parse(await readFile(join(packagePath, '.brokennet-source.json'), 'utf-8')) } catch { /* local package */ }
        return { name: e.name, path: packagePath, source }
      }))
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
    const modRoot = getModRoot(packagesDir, name)
    if (gameId === 'zero-hour' && existsSync(modRoot)) {
      await rm(modRoot, { recursive: true, force: true })
    } else {
      await rm(resolveDirectChild(packagesDir, name), { recursive: true, force: true })
    }
    await unmarkDownloadedMod(packagesDir, name)
    return { ok: true }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}

/** 注册包 / 播放集 IPC */
export function registerPackageHandlers(): void {
  ipcMain.handle('package:install-moddb-addon', async (_e, gameId: string, modName: string, slug: string, kind: 'addon' | 'download' = 'addon') => {
    if (gameId !== 'zero-hour' || !/^[a-z0-9][a-z0-9-_-]{1,80}$/i.test(modName) || !/^[a-z0-9][a-z0-9-_-]{1,120}$/i.test(slug)) return { ok: false, error: '无效的 ModDB addon 命令' }
    const resourceDir = await getResourceDir()
    if (!resourceDir) return { ok: false, error: '请先设置资源目录' }
    const existingPackageDir = join(resourceDir, gameId, 'packages', slug)
    let existingSource: { provider?: string; mod?: string; slug?: string; kind?: string; fileId?: string } | undefined
    try {
      if ((await stat(existingPackageDir)).isDirectory()) {
        try { existingSource = JSON.parse(await readFile(join(existingPackageDir, '.brokennet-source.json'), 'utf-8')) } catch { /* 旧 package 无完整来源信息，需要重新校验下载 */ }
      }
    } catch { /* 尚未安装 */ }
    const view = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } })
    try {
      view.webContents.session.webRequest.onBeforeRequest({ urls: ['*://ads.pubmatic.com/*', '*://u.openx.net/*', '*://*.primis.tech/*', '*://*.doubleclick.net/*', '*://*.googlesyndication.com/*'] }, (_details, callback) => callback({ cancel: true }))
      const page = `https://www.moddb.com/mods/${encodeURIComponent(modName)}/${kind === 'download' ? 'downloads' : 'addons'}/${encodeURIComponent(slug)}`
      await view.loadURL(page)
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const start = await view.webContents.executeJavaScript(`Array.from(document.querySelectorAll('a')).map(a => a.href).find(href => href.includes('/${kind === 'download' ? 'downloads' : 'addons'}/start/')) || null`, true)
      if (!start) throw new Error('未找到 ModDB addon 下载入口，可能需要先完成页面验证')
      const fileId = String(start).match(/\/start\/(\d+)/)?.[1]
      if (!fileId) throw new Error('无法识别 ModDB 文件编号')
      if (
        existingSource?.provider === 'moddb' &&
        existingSource.mod?.toLowerCase() === modName.toLowerCase() &&
        existingSource.slug?.toLowerCase() === slug.toLowerCase() &&
        existingSource.kind === kind &&
        existingSource.fileId === fileId
      ) {
        _e.sender.send('package:moddb-progress', { slug, status: 'done', progress: 100, received: 0, total: 0 })
        return { ok: true, alreadyInstalled: true, packageName: slug }
      }
      await view.loadURL(start)
      const mirror = await view.webContents.executeJavaScript(`Array.from(document.querySelectorAll('a')).map(a => a.href).find(href => href.includes('/downloads/mirror/')) || null`, true)
      if (!mirror) throw new Error('未找到 ModDB 下载镜像链接')
      const packageDir = join(resourceDir, gameId, 'packages', slug)
      const archivePath = join(resourceDir, gameId, 'temp', `${slug}.download`)
      await mkdir(dirname(archivePath), { recursive: true })
      // BrowserWindow 只负责把 ModDB mirror 解析成最终文件 URL。Electron 的
      // DownloadItem 在这些镜像上经常不发送中间 updated 事件，因此实际下载交给 aria2c。
      const directUrl = await new Promise<string>((resolve, reject) => {
        view.webContents.session.once('will-download', (_event, item) => {
          const url = item.getURL()
          item.cancel()
          url ? resolve(url) : reject(new Error('无法获取 ModDB 最终下载地址'))
        })
        void view.loadURL(mirror).catch((error) => { if (!String(error).includes('ERR_FAILED')) reject(error) })
      })
      let downloadedBytes = 0
      const downloadResult = await downloadFile(directUrl, archivePath, `moddb:${slug}`, (received, total, percent) => {
        downloadedBytes = Math.max(downloadedBytes, received)
        _e.sender.send('package:moddb-progress', {
          slug,
          status: 'downloading',
          progress: percent !== undefined ? Math.min(94, Math.round(percent * 0.94)) : total > 0 ? Math.min(94, Math.round(received / total * 94)) : 0,
          received,
          total
        })
      })
      if (!downloadResult.ok) throw new Error(downloadResult.error ?? 'ModDB 下载失败')
      downloadedBytes = (await stat(archivePath)).size
      if (existsSync(packageDir)) {
        const quarantineDir = join(resourceDir, gameId, 'quarantine', 'moddb-refresh')
        await mkdir(quarantineDir, { recursive: true })
        await rename(packageDir, join(quarantineDir, `${slug}-${Date.now()}`))
      }
      _e.sender.send('package:moddb-progress', { slug, status: 'extracting', progress: 95, received: downloadedBytes, total: downloadedBytes })
      await extractArchive(archivePath, packageDir); await rm(archivePath, { force: true })
      await writeFile(join(packageDir, '.brokennet-source.json'), JSON.stringify({ provider: 'moddb', mod: modName, slug, kind, fileId, page }, null, 2))
      _e.sender.send('package:moddb-progress', { slug, status: 'done', progress: 100, received: downloadedBytes, total: downloadedBytes })
      return { ok: true, packageName: slug }
    } catch (error) { return { ok: false, error: (error as Error).message } } finally { view.destroy() }
  })
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
    return enqueueModSetOperation(gameId, async () => {
      if (gameId === 'zero-hour') {
        const packagesDir = await getPackagesDir(gameId)
        const normalized = await syncZhPackagePlaySets(packagesDir, playSets)
        return savePlaySets(gameId, normalized)
      }
      return savePlaySets(gameId, playSets)
    })
  })
  ipcMain.handle('modset:ensure-default', (_e, gameId: string) =>
    enqueueModSetOperation(gameId, () => ensureDefaultPlaySet(gameId))
  )
}
