/**
 * MOD 仓库操作 —— 对接 GenLauncher YAML 格式
 *
 * 主清单地址：https://raw.githubusercontent.com/p0ls3r/GenLauncherModsData/master/ReposModificationDataZH4.yaml
 */
import { ipcMain, net } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, rename, unlink, readdir, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { existsSync } from 'node:fs'

// 下载控制
const downloadControllers = new Map<string, AbortController>()
const downloadPaused = new Set<string>()

// GenLauncher 主清单地址
const ZH_REPOS_URL = 'https://raw.githubusercontent.com/p0ls3r/GenLauncherModsData/master/ReposModificationDataZH4.yaml'
const GEN_REPOS_URL = 'https://raw.githubusercontent.com/p0ls3r/GenLauncherModsData/master/ReposModificationDataGenerals3.yaml'

/** 简单的 YAML 解析（GenLauncher 的 YAML 结构比较固定，用正则足够） */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split('\n')
  let currentKey = ''
  let currentArray: string[] = []
  let inArray = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // 顶级键: `key: value` 或 `key:`
    const topLevelMatch = trimmed.match(/^(\w+):\s*(.*)/)
    if (topLevelMatch && !line.startsWith(' ')) {
      // 保存之前的数组
      if (currentKey && inArray && currentArray.length > 0) {
        result[currentKey] = currentArray
        currentArray = []
      }

      currentKey = topLevelMatch[1]
      const value = topLevelMatch[2].trim()

      if (value === '' || value === '[]') {
        // 可能是数组开始
        inArray = true
        currentArray = []
      } else {
        inArray = false
        result[currentKey] = parseYamlValue(value)
      }
      continue
    }

    // 数组项: `- value`
    const arrayItemMatch = trimmed.match(/^-\s+(.+)/)
    if (arrayItemMatch && currentKey) {
      inArray = true
      currentArray.push(arrayItemMatch[1].trim())
      continue
    }

    // 嵌套键（如 ColorsInformation 下的子键）
    if (currentKey && line.startsWith('  ') && !trimmed.startsWith('-')) {
      const nestedMatch = trimmed.match(/^(\w+):\s*(.*)/)
      if (nestedMatch) {
        // 这里简化处理，实际可能需要更复杂的逻辑
        if (!result[currentKey]) result[currentKey] = {}
        ;(result[currentKey] as Record<string, string>)[nestedMatch[1]] = parseYamlValue(nestedMatch[2])
      }
    }
  }

  // 保存最后一个数组
  if (currentKey && inArray && currentArray.length > 0) {
    result[currentKey] = currentArray
  }

  return result
}

function parseYamlValue(value: string): string {
  // 去除引号
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1)
  }
  return value
}

/** 解析主清单 YAML */
function parseReposData(yamlText: string): {
  modDatas: Array<{ ModName: string; ModLink: string; ModPatches: string[]; ModAddons: string[] }>
  executables: Array<{ ModName: string; ModLink: string; DependencyName: string }>
} {
  const lines = yamlText.split('\n')
  const modDatas: Array<{ ModName: string; ModLink: string; ModPatches: string[]; ModAddons: string[] }> = []
  const executables: Array<{ ModName: string; ModLink: string; DependencyName: string }> = []

  let currentSection: 'mod' | 'exe' | null = null
  let currentMod: { ModName: string; ModLink: string; ModPatches: string[]; ModAddons: string[] } | null = null
  let currentExe: { ModName: string; ModLink: string; DependencyName: string } | null = null
  let currentArrayKey = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // 检测 modDatas 部分
    if (trimmed === 'modDatas:') {
      currentSection = 'mod'
      continue
    }

    // 检测 executables 部分
    if (trimmed === 'executables:') {
      currentSection = 'exe'
      continue
    }

    // 检测其他顶级键（跳出当前解析）
    if (!line.startsWith(' ') && trimmed.match(/^\w+:/) && trimmed !== 'modDatas:' && trimmed !== 'executables:') {
      currentSection = null
      currentMod = null
      currentExe = null
      continue
    }

    // 新的 MOD 条目
    if (currentSection === 'mod' && trimmed.startsWith('- ModName:')) {
      if (currentMod) modDatas.push(currentMod)
      currentMod = {
        ModName: trimmed.replace('- ModName:', '').trim(),
        ModLink: '',
        ModPatches: [],
        ModAddons: []
      }
      currentArrayKey = ''
      continue
    }

    // 新的可执行文件条目
    if (currentSection === 'exe' && trimmed.startsWith('- ModName:')) {
      if (currentExe) executables.push(currentExe)
      currentExe = {
        ModName: trimmed.replace('- ModName:', '').trim(),
        ModLink: '',
        DependencyName: ''
      }
      currentArrayKey = ''
      continue
    }

    // MOD 属性
    if (currentMod) {
      if (trimmed.startsWith('ModLink:')) {
        currentMod.ModLink = trimmed.replace('ModLink:', '').trim()
      } else if (trimmed === 'ModPatches:') {
        currentArrayKey = 'ModPatches'
      } else if (trimmed === 'ModAddons:') {
        currentArrayKey = 'ModAddons'
      } else if (trimmed.startsWith('- ') && currentArrayKey) {
        const url = trimmed.replace('- ', '').trim()
        if (currentArrayKey === 'ModPatches') currentMod.ModPatches.push(url)
        else if (currentArrayKey === 'ModAddons') currentMod.ModAddons.push(url)
      } else if (!trimmed.startsWith('-')) {
        currentArrayKey = ''
      }
    }

    // 可执行文件属性
    if (currentExe) {
      if (trimmed.startsWith('ModLink:')) {
        currentExe.ModLink = trimmed.replace('ModLink:', '').trim()
      } else if (trimmed.startsWith('DependencyName:')) {
        currentExe.DependencyName = trimmed.replace('DependencyName:', '').trim()
      }
    }
  }

  // 保存最后一个
  if (currentMod) modDatas.push(currentMod)
  if (currentExe) executables.push(currentExe)

  return { modDatas, executables }
}

/** 解析单个 MOD 的 manifest YAML */
function parseModManifest(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yamlText.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^(\w+):\s*(.*)/)
    if (match) {
      const key = match[1]
      let value = match[2].trim()

      // 去除引号
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1)
      }

      // 解析数组
      if (value === '' || value === '[]') {
        result[key] = []
      } else if (value === "''" || value === '""') {
        result[key] = ''
      } else {
        result[key] = value
      }
    }
  }

  return result
}

/** 代理前缀（国内访问 GitHub 失败时使用） */
const GH_PROXY = 'https://ghproxy.com/'

/** 从 GitHub 获取 YAML 内容（失败时自动尝试代理） */
async function fetchYaml(url: string): Promise<string> {
  // 第一次尝试直连
  try {
    const response = await net.fetch(url, {
      headers: { 'User-Agent': 'TDHourLauncher/1' }
    })
    if (response.ok) {
      return await response.text()
    }
  } catch {
    // 直连失败，尝试代理
  }

  // 第二次尝试代理
  if (url.includes('raw.githubusercontent.com')) {
    const proxyUrl = GH_PROXY + url
    const response = await net.fetch(proxyUrl, {
      headers: { 'User-Agent': 'TDHourLauncher/1' }
    })
    if (!response.ok) {
      throw new Error(`代理请求失败: ${response.status}`)
    }
    return await response.text()
  }

  throw new Error('无法获取 YAML 内容')
}

type DownloadResult = { ok: true } | { ok: false; paused: boolean; error?: string }

/** 下载文件到指定路径（失败时自动尝试代理，支持暂停/取消） */
async function downloadFile(
  url: string,
  destPath: string,
  modName: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<DownloadResult> {
  await mkdir(dirname(destPath), { recursive: true })

  // 检查是否有已下载的部分文件（断点续传）
  let startOffset = 0
  try {
    const s = await stat(destPath)
    startOffset = s.size
    if (startOffset > 0) {
      console.log(`[下载] 断点续传: 已有 ${startOffset} 字节`)
    }
  } catch {
    // 文件不存在，从头开始
  }

  console.log(`[下载] 开始: ${url}`)

  const controller = new AbortController()
  downloadControllers.set(modName, controller)

  const doFetch = async (fetchUrl: string, headers: Record<string, string> = {}) => {
    return net.fetch(fetchUrl, {
      headers: { 'User-Agent': 'TDHourLauncher/1', ...headers },
      redirect: 'follow',
      signal: controller.signal as any
    })
  }

  const tryUrls: Array<{ url: string; headers: Record<string, string> }> = [
    { url, headers: {} }
  ]
  if (url.includes('raw.githubusercontent.com') || url.includes('github.com')) {
    tryUrls.push({ url: GH_PROXY + url, headers: {} })
  }

  for (const { url: fetchUrl } of tryUrls) {
    // 每次循环前检查暂停
    if (downloadPaused.has(modName)) {
      downloadControllers.delete(modName)
      return { ok: false, paused: true }
    }

    try {
      const rangeHeaders: Record<string, string> = {}
      if (startOffset > 0) {
        rangeHeaders['Range'] = `bytes=${startOffset}-`
      }

      console.log(`[下载] 请求: ${fetchUrl}${startOffset > 0 ? ` (从 ${startOffset} 字节)` : ''}`)
      const response = await doFetch(fetchUrl, rangeHeaders)

      if (response.ok || response.status === 206) {
        const contentLength = Number(response.headers.get('content-length')) || 0
        const total = response.status === 206 ? startOffset + contentLength : contentLength
        console.log(`[下载] 成功, 状态: ${response.status}, 大小: ${total}`)

        const writeResult = await writeResponseToFile(response, destPath, modName, startOffset, total, onProgress)
        return writeResult
      }

      // 416 Range Not Satisfiable = 文件已完整下载
      if (response.status === 416 && startOffset > 0) {
        console.log(`[下载] 416: 文件已完整 (${startOffset} 字节)`)
        // 通知进度为 100%
        if (onProgress) {
          onProgress(startOffset, startOffset)
        }
        downloadControllers.delete(modName)
        return { ok: true }
      }

      console.log(`[下载] 失败: ${response.status}`)
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (downloadPaused.has(modName)) {
          console.log('[下载] 已暂停')
          downloadControllers.delete(modName)
          return { ok: false, paused: true }
        }
        console.log('[下载] 已取消')
        downloadControllers.delete(modName)
        return { ok: false, paused: false, error: '下载已取消' }
      }
      console.log(`[下载] 异常: ${(e as Error).message}`)
    }
  }

  downloadControllers.delete(modName)
  return { ok: false, paused: false, error: '下载失败' }
}

/** 暂停下载 */
function pauseDownload(modName: string): void {
  console.log(`[下载] 暂停: ${modName}`)
  downloadPaused.add(modName)
  const controller = downloadControllers.get(modName)
  if (controller) {
    controller.abort()
  }
}

/** 取消下载 */
function cancelDownload(modName: string): void {
  console.log(`[下载] 取消: ${modName}`)
  downloadPaused.delete(modName)
  const controller = downloadControllers.get(modName)
  if (controller) {
    controller.abort()
  }
  downloadControllers.delete(modName)
}

/** 将响应内容写入文件（支持断点续传追加写入） */
async function writeResponseToFile(
  response: Response,
  destPath: string,
  modName: string,
  startOffset: number,
  total: number,
  onProgress?: (downloaded: number, total: number) => void
): Promise<DownloadResult> {
  const reader = response.body?.getReader()
  if (!reader) {
    return { ok: false, paused: false, error: '无法获取响应体' }
  }

  // 服务端返回200（完整内容）但本地有旧的部分文件时，需要截断重写而非追加
  const isFullResponse = response.status === 200 && startOffset > 0
  const writeOffset = isFullResponse ? 0 : startOffset
  const writeFlags = isFullResponse ? 'w' : 'a'

  const fileStream = createWriteStream(destPath, { start: writeOffset, flags: writeFlags })
  let downloaded = writeOffset
  let closed = false

  const closeStream = (): Promise<void> => {
    if (closed) return Promise.resolve()
    closed = true
    return new Promise<void>((resolve) => {
      fileStream.end(() => resolve())
    })
  }

  try {
    while (true) {
      if (downloadPaused.has(modName)) {
        await closeStream()
        return { ok: false, paused: true }
      }

      const { done, value } = await reader.read()
      if (done) break

      // 正确处理背压：write 返回 false 时等待 drain
      const canWrite = fileStream.write(value)
      downloaded += value.length

      if (!canWrite) {
        await new Promise<void>((resolve) => fileStream.once('drain', resolve))
      }

      if (onProgress && total > 0) {
        onProgress(downloaded, total)
      }
    }
  } catch (e) {
    await closeStream()
    if ((e as Error).name === 'AbortError') {
      if (downloadPaused.has(modName)) {
        return { ok: false, paused: true }
      }
      return { ok: false, paused: false, error: '下载已取消' }
    }
    throw e
  } finally {
    await closeStream()
    downloadControllers.delete(modName)
  }

  return { ok: true }
}

/** 查找 7z.exe 路径 */
async function find7zExe(): Promise<string> {
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
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  await stat(archivePath)

  console.log(`[解压] ${archivePath} -> ${destDir}`)

  const binPath = await find7zExe()
  console.log(`[解压] 7z: ${binPath}`)

  const execFileAsync = promisify(execFile)
  try {
    await execFileAsync(binPath, ['x', archivePath, `-o${destDir}`, '-y'])
    console.log('[解压] 完成')
  } catch (e) {
    console.error('[解压] 失败:', (e as Error).message)
    throw new Error(`解压失败: ${(e as Error).message}`)
  }
}

/** 获取资源目录下的 MOD 存储路径 */
async function getModsDir(gameId: string): Promise<string> {
  const { app } = await import('electron')
  const configPath = join(app.getPath('userData'), 'config.json')
  try {
    const data = await readFile(configPath, 'utf-8')
    const config = JSON.parse(data) as Record<string, string>
    const resourceDir = config.resourceDir
    if (resourceDir) {
      return join(resourceDir, gameId, 'mods')
    }
  } catch {
    // 配置不存在
  }
  // 回退到应用目录
  return join(process.cwd(), 'mods')
}

/** 播放集数据结构 */
interface ModSetData {
  id: string
  name: string
  description: string
  background?: string
  mods: Array<{ id: string; name: string }>
}

/** 获取播放集文件路径 */
async function getModSetsPath(gameId: string): Promise<string | null> {
  const { app } = await import('electron')
  const configPath = join(app.getPath('userData'), 'config.json')
  try {
    const data = await readFile(configPath, 'utf-8')
    const config = JSON.parse(data) as Record<string, string>
    const resourceDir = config.resourceDir
    if (resourceDir) {
      return join(resourceDir, gameId, 'modsets.json')
    }
  } catch { /* 无配置 */ }
  return null
}

/** 加载播放集 */
async function loadModSets(gameId: string): Promise<{ ok: boolean; modSets: ModSetData[]; error?: string }> {
  try {
    const path = await getModSetsPath(gameId)
    if (!path) return { ok: true, modSets: [] }
    const data = await readFile(path, 'utf-8')
    const modSets = JSON.parse(data) as ModSetData[]
    return { ok: true, modSets }
  } catch {
    return { ok: true, modSets: [] }
  }
}

/** 保存播放集 */
async function saveModSets(gameId: string, modSets: ModSetData[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const path = await getModSetsPath(gameId)
    if (!path) return { ok: false, error: '请先设置资源目录' }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(modSets, null, 2), 'utf-8')
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, error: err.message }
  }
}

/** 从 game.ini 读游戏安装目录 */
async function getInstallPath(gameId: string): Promise<string> {
  const modsDir = await getModsDir(gameId)
  const gameIniPath = join(modsDir, '..', 'game.ini')
  try {
    const data = await readFile(gameIniPath, 'utf-8')
    for (const line of data.split(/\r?\n/)) {
      const m = line.match(/^installPath=(.*)$/)
      if (m) return m[1].trim()
    }
  } catch { /* 不存在 */ }
  return ''
}

/** 复制游戏本体时排除的运行时写目录（MentalOmega mod 只含只读资源） */
const GAME_COPY_EXCLUDE = new Set([
  'UserData', 'Saved Games', 'Screenshots', 'Client', 'EasyAntiCheat',
  'plugins', 'GeneralsOnlineGameData', 'Map Editor', 'Resources',
  'Logs', 'SettingsCache', 'tunnel_cache', 'ClientCrashLogs'
])

/**
 * 确保默认"原版"播放集存在：mods 只含 MentalOmega（游戏本体视为 mod）。
 * - 没有 mods/MentalOmega 时，从游戏安装目录复制游戏本体过去
 * - 没有"原版"播放集时，创建它
 * 幂等：已存在则不动。
 */
async function ensureDefaultModSet(gameId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const modsDir = await getModsDir(gameId)
    const mentalDir = join(modsDir, 'MentalOmega')

    // 1. 确保 mods/MentalOmega 存在（游戏本体作为 mod）
    if (!existsSync(mentalDir)) {
      const installPath = await getInstallPath(gameId)
      if (installPath && existsSync(installPath)) {
        await cp(installPath, mentalDir, {
          recursive: true,
          filter: (src) => {
            const name = basename(src)
            return !GAME_COPY_EXCLUDE.has(name)
          }
        })
        console.log(`[Mods] 已复制游戏本体 -> ${mentalDir}`)
      } else {
        await mkdir(mentalDir, { recursive: true })
      }
    }

    // 2. 确保"原版"播放集存在（mods 只含 MentalOmega）
    const path = await getModSetsPath(gameId)
    if (path) {
      let modSets: ModSetData[] = []
      try { modSets = JSON.parse(await readFile(path, 'utf-8')) } catch { /* 无播放集 */ }
      const vanilla = modSets.find((m) => m.id === 'vanilla')
      if (!vanilla) {
        modSets.unshift({
          id: 'vanilla',
          name: '原版',
          description: '只加载游戏本体（MentalOmega）',
          mods: [{ id: 'MentalOmega', name: 'MentalOmega' }]
        })
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify(modSets, null, 2), 'utf-8')
        console.log('[Mods] 已创建默认"原版"播放集（MentalOmega）')
      }
    }
    return { ok: true }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}

/** 注册 MOD 相关 IPC 处理器 */
export function registerModHandlers(): void {
  // 获取主清单（MOD 列表）
  ipcMain.handle('mod:fetch-repo-mods', async (_e, gameType: 'zh' | 'gen') => {
    try {
      const url = gameType === 'zh' ? ZH_REPOS_URL : GEN_REPOS_URL
      const yamlText = await fetchYaml(url)
      const data = parseReposData(yamlText)
      return { ok: true, data }
    } catch (e) {
      const err = e as Error
      return { ok: false, error: err.message }
    }
  })

  // 获取单个 MOD 的 manifest
  ipcMain.handle('mod:fetch-manifest', async (_e, url: string) => {
    try {
      const yamlText = await fetchYaml(url)
      const manifest = parseModManifest(yamlText)
      return { ok: true, manifest }
    } catch (e) {
      const err = e as Error
      return { ok: false, error: err.message }
    }
  })

  // 下载 MOD
  ipcMain.handle('mod:download', async (e, url: string, gameId: string, modName: string) => {
    const modsDir = await getModsDir(gameId)
    const modDir = join(modsDir, modName)
    const tempDir = join(modsDir, `${modName}.downloading`)

    const urlPath = url.split('?')[0].toLowerCase()
    const isArchive = urlPath.endsWith('.rar') || urlPath.endsWith('.zip') || urlPath.endsWith('.7z')

    // 根据 URL 中的实际扩展名命名压缩包
    let archiveExt = '.rar'
    if (urlPath.endsWith('.7z')) archiveExt = '.7z'
    else if (urlPath.endsWith('.zip')) archiveExt = '.zip'
    const archivePath = join(tempDir, `${modName}${archiveExt}`)
    const targetFile = isArchive ? archivePath : join(tempDir, url.split('?')[0].split('/').pop() || modName)

    // 清理可能残留的 tempDir（上次下载中断留下的，避免污染新下载）
    try { await rm(tempDir, { recursive: true, force: true }) } catch { /* 不存在 */ }

    console.log(`[下载] MOD: ${modName}`)
    console.log(`[下载] URL: ${url}`)
    console.log(`[下载] 压缩包: ${isArchive}`)
    console.log(`[下载] 目标: ${targetFile}`)

    // 下载主文件
    const downloadResult = await downloadFile(url, targetFile, modName, (downloaded, total) => {
      e.sender.send('mod:download-progress', {
        modName,
        status: 'downloading',
        progress: Math.round((downloaded / total) * 80),
        downloaded,
        total
      })
    })

    if (!downloadResult.ok) {
      if (downloadResult.paused) {
        e.sender.send('mod:download-progress', {
          modName,
          status: 'paused',
          progress: 0,
          downloaded: 0,
          total: 0
        })
        return { ok: false, error: '下载已暂停' }
      }
      e.sender.send('mod:download-progress', {
        modName,
        status: 'error',
        progress: 0,
        downloaded: 0,
        total: 0,
        error: downloadResult.error
      })
      return { ok: false, error: downloadResult.error }
    }

    // 清理暂停状态
    downloadPaused.delete(modName)

    // 下载完成，解压或移动
    try {
      if (isArchive) {
        e.sender.send('mod:download-progress', {
          modName,
          status: 'extracting',
          progress: 80,
          downloaded: 0,
          total: 0
        })

        await extractArchive(archivePath, tempDir)
        await unlink(archivePath).catch(() => {})

        try { await stat(modDir); await rm(modDir, { recursive: true, force: true }) } catch { /* 不存在 */ }

        await rename(tempDir, modDir)
      } else {
        try { await stat(modDir); await rm(modDir, { recursive: true, force: true }) } catch { /* 不存在 */ }
        await rename(tempDir, modDir)
      }

      e.sender.send('mod:download-progress', {
        modName,
        status: 'done',
        progress: 100,
        downloaded: 0,
        total: 0
      })

      return { ok: true, path: modDir }
    } catch (err) {
      const error = err as Error
      console.error(`[下载] 后处理失败: ${error.message}`)
      e.sender.send('mod:download-progress', {
        modName,
        status: 'error',
        progress: 0,
        downloaded: 0,
        total: 0,
        error: error.message
      })
      return { ok: false, error: error.message }
    }
  })

  // 获取已安装的 MOD 列表
  ipcMain.handle('mod:list-installed', async (_e, gameId: string) => {
    try {
      const modsDir = await getModsDir(gameId)
      const entries = await readdir(modsDir, { withFileTypes: true })
      const mods = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({
          name: e.name,
          path: join(modsDir, e.name)
        }))
      return { ok: true, mods }
    } catch (e) {
      return { ok: true, mods: [] }
    }
  })

  // 删除 MOD
  ipcMain.handle('mod:delete', async (_e, gameId: string, modName: string) => {
    try {
      const modsDir = await getModsDir(gameId)
      const modDir = join(modsDir, modName)
      await rm(modDir, { recursive: true, force: true })
      return { ok: true }
    } catch (e) {
      const err = e as Error
      return { ok: false, error: err.message }
    }
  })

  // 暂停下载
  ipcMain.handle('mod:pause-download', async (_e, modName: string) => {
    pauseDownload(modName)
    return { ok: true }
  })

  // 取消下载
  ipcMain.handle('mod:cancel-download', async (_e, modName: string) => {
    cancelDownload(modName)
    return { ok: true }
  })

  // 确保默认"原版"播放集存在（游戏本体作为 mod）
  ipcMain.handle('mod:ensure-default-modset', async (_e, gameId: string) => {
    return ensureDefaultModSet(gameId)
  })

  // 加载播放集
  ipcMain.handle('mod:load-modsets', async (_e, gameId: string) => {
    return loadModSets(gameId)
  })

  // 保存播放集
  ipcMain.handle('mod:save-modsets', async (_e, gameId: string, modSets: Array<{
    id: string
    name: string
    description: string
    background?: string
    mods: Array<{ id: string; name: string }>
  }>) => {
    return saveModSets(gameId, modSets)
  })

  // 读取 MOD 版本号
  ipcMain.handle('mod:get-version', async (_e, gameId: string, modName: string) => {
    try {
      const modsDir = await getModsDir(gameId)
      const versionPath = join(modsDir, modName, 'version.txt')
      const version = await readFile(versionPath, 'utf-8')
      return { ok: true, version: version.trim() }
    } catch {
      return { ok: true, version: '' }
    }
  })

  // 写入 MOD 版本号
  ipcMain.handle('mod:set-version', async (_e, gameId: string, modName: string, version: string) => {
    try {
      const modsDir = await getModsDir(gameId)
      const versionPath = join(modsDir, modName, 'version.txt')
      await mkdir(dirname(versionPath), { recursive: true })
      await writeFile(versionPath, version, 'utf-8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
