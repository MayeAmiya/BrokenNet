import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { link, unlink, stat, mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, clipboard } from 'electron'
import { existsSync } from 'node:fs'

function getDefaultResourceBase(): string {
  for (let code = 'Z'.charCodeAt(0); code >= 'C'.charCodeAt(0); code--) {
    const root = `${String.fromCharCode(code)}:\\`
    if (existsSync(root)) return root
  }
  return app.getPath('documents')
}

async function discoverGamePaths(gameId: string): Promise<string[]> {
  const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA'], process.env['USERPROFILE']].filter(Boolean) as string[]
  const candidates = new Set<string>()
  const names = gameId === 'mental-omega'
    ? ['MentalOmega', 'Mental Omega']
    : ['Command and Conquer Generals Zero Hour', 'Command & Conquer Generals Zero Hour', 'Zero Hour']
  for (const root of roots) for (const name of names) candidates.add(join(root, name))
  for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
    for (const name of names) candidates.add(join(drive + '\\', 'Program Files (x86)', 'Steam', 'steamapps', 'common', name))
    for (const name of names) candidates.add(join(drive + '\\', 'Program Files', 'Steam', 'steamapps', 'common', name))
  }
  const result: string[] = []
  for (const candidate of candidates) {
    try { await access(candidate); result.push(candidate) } catch { /* not installed */ }
  }
  // 对常见安装根目录做有限深度扫描，以覆盖 Steam 自定义库和改名目录。
  const markers = gameId === 'mental-omega' ? ['MentalOmegaClient.exe'] : ['Generals.exe', 'WindowZH.big']
  const scanRoots = [...roots, ...['C:', 'D:', 'E:', 'F:', 'G:'].map((d) => `${d}\\`)]
  const queue = scanRoots.map((path) => ({ path, depth: 0 }))
  const visited = new Set<string>()
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > 5 || visited.has(current.path)) continue
    visited.add(current.path)
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(current.path, { withFileTypes: true }) } catch { continue }
    const namesInDir = new Set(entries.map((entry) => entry.name.toLowerCase()))
    if (markers.some((marker) => namesInDir.has(marker.toLowerCase())) || namesInDir.has('mental omega')) {
      result.push(current.path)
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !['Windows', 'System32', 'node_modules'].includes(entry.name)) {
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
      }
    }
  }
  return [...new Set(result)]
}

export interface LinkResult {
  ok: boolean
  error?: string
}

/**
 * 创建硬链接。底层就是 Win32 的 CreateHardLinkW —— 这件事不需要原生模块。
 *
 * 两个限制是 NTFS 本身的，换成 C++ 写也绕不过去：
 *   1. 硬链接不能跨卷（源和目标必须在同一个盘符上）
 *   2. 目录不能建硬链接，只有文件可以（目录要用 junction）
 */
async function createHardLink(src: string, dest: string, overwrite: boolean): Promise<LinkResult> {
  try {
    const srcStat = await stat(src)
    if (srcStat.isDirectory()) {
      return { ok: false, error: '硬链接不支持目录，目录请用 junction' }
    }

    await mkdir(dirname(dest), { recursive: true })

    if (overwrite) {
      // 目标已存在时 link() 会直接失败，先删掉
      await unlink(dest).catch(() => {})
    }

    await link(src, dest)
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EXDEV') {
      return { ok: false, error: '源和目标不在同一个卷上，硬链接无法跨盘' }
    }
    if (err.code === 'EEXIST') {
      return { ok: false, error: '目标已存在' }
    }
    return { ok: false, error: err.message }
  }
}

/** 数一个文件有几个硬链接指向它（nlink > 1 就说明被链接过） */
async function linkCount(path: string): Promise<number> {
  const s = await stat(path)
  return s.nlink
}

export function registerFsHandlers(): void {
  ipcMain.handle('fs:hardlink', (_e, src: string, dest: string, overwrite = false) =>
    createHardLink(src, dest, overwrite)
  )
  ipcMain.handle('fs:link-count', (_e, path: string) => linkCount(path))
  ipcMain.handle('fs:open-maps-dir', (_e, gameId: string) => openDir(gameId, 'maps'))
  ipcMain.handle('fs:open-replays-dir', (_e, gameId: string) => openDir(gameId, 'replay'))
  ipcMain.handle('fs:open-packages-dir', (_e, gameId: string) => openDir(gameId, 'packages'))
  ipcMain.handle('fs:open-playground-dir', (_e, gameId: string) => openDir(gameId, 'playground'))
  ipcMain.handle('fs:list-maps', (_e, gameId: string) => listDirFiles(gameId, 'maps'))
  ipcMain.handle('fs:list-replays', (_e, gameId: string) => listDirFiles(gameId, 'replay'))
  ipcMain.handle('fs:select-directory', (e) => selectDirectory(e.sender))
  ipcMain.handle('fs:get-default-resource-base', () => getDefaultResourceBase())
  ipcMain.handle('clipboard:write-text', (_e, value: string) => { clipboard.writeText(value) })
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('fs:discover-game-paths', (_e, gameId: string) => discoverGamePaths(gameId))
  // 首启引导：在用户选择的基目录下创建 BrokenNetLib 并设为资源库。
  // 若 BrokenNetLib 已存在则直接复用（不覆写库内已有内容），返回 reused 标记
  ipcMain.handle('fs:init-resource-dir', async (_e, basePath: string) => {
    try {
      if (!basePath) return { ok: false, error: '未选择位置' }
      const dir = join(basePath, 'BrokenNetLib')
      let reused = false
      try {
        reused = (await stat(dir)).isDirectory()
      } catch {
        // 目录不存在
      }
      if (!reused) await mkdir(dir, { recursive: true })
      await setConfig('resourceDir', dir)
      return { ok: true, path: dir, reused }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('fs:get-config', (_e, key: string) => getConfig(key))
  ipcMain.handle('fs:set-config', (_e, key: string, value: string) => setConfig(key, value))
  ipcMain.handle('fs:create-game-dirs', (_e, gameConfig: GameConfig) => createGameDirs(gameConfig))
  ipcMain.handle('fs:update-game-config', (_e, gameId: string, config: Partial<GameConfig>) => updateGameConfig(gameId, config))
  ipcMain.handle('fs:load-all-games', () => loadAllGames())
}

/** 用系统资源管理器打开指定游戏的子目录（maps/replay等） */
async function openDir(gameId: string, subDir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resourceDir = await getConfig('resourceDir')
    if (!resourceDir) {
      return { ok: false, error: '请先在设置中选择资源目录' }
    }

    const dir = join(resourceDir, gameId, subDir)
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, error: err.message }
  }
}

/** 列出子目录中的文件 */
async function listDirFiles(gameId: string, subDir: string): Promise<{ ok: boolean; files: Array<{ name: string; path: string; size: number }>; error?: string }> {
  try {
    const resourceDir = await getConfig('resourceDir')
    if (!resourceDir) {
      return { ok: true, files: [] }
    }

    const dir = join(resourceDir, gameId, subDir)
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      // 目录创建失败，返回空列表
    }

    const entries = await readdir(dir, { withFileTypes: true })
    const files: Array<{ name: string; path: string; size: number }> = []

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = join(dir, entry.name)
      try {
        const fileStat = await stat(filePath)
        files.push({
          name: entry.name,
          path: filePath,
          size: fileStat.size
        })
      } catch {
        // 跳过无法读取的文件
      }
    }

    return { ok: true, files }
  } catch {
    return { ok: true, files: [] }
  }
}

/** 弹出系统目录选择框，返回选中的路径 */
async function selectDirectory(webContents: Electron.WebContents): Promise<{ path: string | null }> {
  const win = BrowserWindow.fromWebContents(webContents)
  if (!win) return { path: null }

  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  })

  if (result.canceled || !result.filePaths.length) {
    return { path: null }
  }

  return { path: result.filePaths[0] }
}

/** 配置文件路径 */
function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/** 读取配置 */
async function getConfig(key: string): Promise<string | null> {
  try {
    const configPath = getConfigPath()
    const data = await readFile(configPath, 'utf-8')
    const config = JSON.parse(data) as Record<string, string>
    return config[key] ?? null
  } catch {
    return null
  }
}

/** 写入配置 */
async function setConfig(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const configPath = getConfigPath()
    let config: Record<string, string> = {}

    try {
      const data = await readFile(configPath, 'utf-8')
      config = JSON.parse(data) as Record<string, string>
    } catch {
      // 文件不存在，使用空对象
    }

    config[key] = value
    await writeFile(configPath, JSON.stringify(config, null, 2))
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, error: err.message }
  }
}

/** 游戏配置 */
interface GameConfig {
  id: string
  name: string
  installPath: string
  generalsPath?: string
  useGtd?: boolean
  gtdPath?: string
  useGenTool?: boolean
}

/** 更新游戏配置文件 */
async function updateGameConfig(gameId: string, config: Partial<GameConfig>): Promise<{ ok: boolean; error?: string }> {
  try {
    const resourceDir = await getConfig('resourceDir')
    if (!resourceDir) {
      return { ok: false, error: '请先在设置中选择资源目录' }
    }

    const gameDir = join(resourceDir, gameId)
    const iniPath = join(gameDir, 'game.ini')

    // 读取现有配置
    let existingConfig: Record<string, string> = {}
    try {
      const data = await readFile(iniPath, 'utf-8')
      const lines = data.split('\n')
      for (const line of lines) {
        if (line.startsWith('[') || !line.includes('=')) continue
        const eqIndex = line.indexOf('=')
        const key = line.slice(0, eqIndex).trim()
        const value = line.slice(eqIndex + 1).trim()
        existingConfig[key] = value
      }
    } catch {
      // 文件不存在，使用空对象
    }

    // 更新配置
    if (config.id) existingConfig.id = config.id
    if (config.name) existingConfig.name = config.name
    if (config.installPath) existingConfig.installPath = config.installPath
    if (config.generalsPath !== undefined) existingConfig.generalsPath = config.generalsPath
    if (config.useGtd !== undefined) existingConfig.useGtd = String(config.useGtd)
    if (config.gtdPath !== undefined) existingConfig.gtdPath = config.gtdPath
    if (config.useGenTool !== undefined) existingConfig.useGenTool = String(config.useGenTool)

    // 生成 ini 文件内容
    const iniContent = [
      '[General]',
      `id=${existingConfig.id ?? ''}`,
      `name=${existingConfig.name ?? ''}`,
      `installPath=${existingConfig.installPath ?? ''}`,
      existingConfig.generalsPath ? `generalsPath=${existingConfig.generalsPath}` : '',
      // 始终写出开关状态，避免旧的配置值在切换后残留或加载时产生歧义。
      `useGtd=${existingConfig.useGtd ?? 'false'}`,
      existingConfig.gtdPath ? `gtdPath=${existingConfig.gtdPath}` : '',
      existingConfig.useGenTool ? `useGenTool=${existingConfig.useGenTool}` : '',
      `updatedAt=${new Date().toISOString()}`
    ]
      .filter(Boolean)
      .join('\n')

    await writeFile(iniPath, iniContent, 'utf-8')
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, error: err.message }
  }
}

/** 创建游戏数据目录结构 */
async function createGameDirs(gameConfig: GameConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    // 从配置读取资源目录
    const resourceDir = await getConfig('resourceDir')
    if (!resourceDir) {
      return { ok: false, error: '请先在设置中选择资源目录' }
    }

    const gameDir = join(resourceDir, gameConfig.id)
    const dirs = ['packages', 'replay', 'save', 'maps']

    // 创建子目录
    for (const dir of dirs) {
      await mkdir(join(gameDir, dir), { recursive: true })
    }

    // 生成 ini 文件内容
    const iniContent = [
      '[General]',
      `id=${gameConfig.id}`,
      `name=${gameConfig.name}`,
      `installPath=${gameConfig.installPath}`,
      gameConfig.generalsPath ? `generalsPath=${gameConfig.generalsPath}` : '',
      gameConfig.gtdPath ? `gtdPath=${gameConfig.gtdPath}` : '',
      `createdAt=${new Date().toISOString()}`
    ]
      .filter(Boolean)
      .join('\n')

    await writeFile(join(gameDir, 'game.ini'), iniContent, 'utf-8')

    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, error: err.message }
  }
}

/** 从资源目录加载所有游戏配置 */
interface LoadedGame {
  id: string
  name: string
  installPath: string
  generalsPath?: string
  useGtd?: boolean
  gtdPath?: string
  useGenTool?: boolean
}

async function loadAllGames(): Promise<LoadedGame[]> {
  try {
    const resourceDir = await getConfig('resourceDir')
    if (!resourceDir) return []

    const gamesDir = join(resourceDir)
    const entries = await readdir(gamesDir, { withFileTypes: true })
    const games: LoadedGame[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const iniPath = join(gamesDir, entry.name, 'game.ini')
      try {
        const data = await readFile(iniPath, 'utf-8')
        const config: LoadedGame = { id: '', name: '', installPath: '' }
        const lines = data.split('\n')
        for (const line of lines) {
          if (line.startsWith('[') || !line.includes('=')) continue
          const eqIndex = line.indexOf('=')
          const key = line.slice(0, eqIndex).trim()
          const value = line.slice(eqIndex + 1).trim()
          if (key === 'id') config.id = value
          else if (key === 'name') config.name = value
          else if (key === 'installPath') config.installPath = value
          else if (key === 'generalsPath') config.generalsPath = value
          else if (key === 'useGtd') config.useGtd = value === 'true'
          else if (key === 'gtdPath') config.gtdPath = value
          else if (key === 'useGenTool') config.useGenTool = value === 'true'
        }
        if (config.id && config.name) games.push(config)
      } catch {
        // 跳过无效目录
      }
    }

    return games
  } catch {
    return []
  }
}
