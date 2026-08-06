/**
 * MOD 仓库操作 —— 对接 GenLauncher YAML 格式
 *
 * 主清单地址：https://raw.githubusercontent.com/p0ls3r/GenLauncherModsData/master/ReposModificationDataZH4.yaml
 */
import { ipcMain, session } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, rename, unlink, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { extractArchive, isExtractableArchive } from './archive'
import { getModRoot, getModsRoot, markDownloadedMod, readManagedMods } from './downloaded-mod-registry'

// 下载控制
const downloadControllers = new Map<string, AbortController>()
const downloadPaused = new Set<string>()
const execFileAsync = promisify(execFile)

function findAria2c(): string | null {
  const candidates = [join(process.resourcesPath || '', 'aria2c.exe'), join(process.cwd(), 'resources', 'aria2c.exe'), 'aria2c.exe']
  return candidates.find((candidate) => candidate === 'aria2c.exe' || existsSync(candidate)) ?? null
}

async function downloadWithAria2(url: string, destPath: string, onProgress?: (downloaded: number, total: number, percent?: number) => void): Promise<DownloadResult | null> {
  const exe = findAria2c()
  if (!exe) return null
  await mkdir(dirname(destPath), { recursive: true })
  const args = ['--allow-overwrite=true', '--auto-file-renaming=false', '--continue=true', '--max-connection-per-server=8', '--split=8', '--summary-interval=1', '--dir', dirname(destPath), '--out', basename(destPath)]
  try {
    const proxy = await session.defaultSession.resolveProxy(url)
    const match = proxy.match(/PROXY\s+([^;]+)/i)
    if (match) args.push(`--all-proxy=http://${match[1]}`)
  } catch { /* DIRECT */ }
  args.push(url)
  console.log(`[aria2c] ${exe} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`)
  const child = execFile(exe, args, { windowsHide: true })
  let lastDownloaded = 0
  let lastTotal = 0
  let lastPercent = 0
  let stdoutBuffer = ''
  const units: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }
  child.stdout?.on('data', (data) => {
    const output = String(data)
    console.log(`[aria2c] ${output.trim()}`)
    // stdout 的 data 事件没有行边界保证；保留滚动缓冲，避免
    // `274MiB/0.9GiB(27%)` 被切成两个 chunk 后永远解析不到。
    stdoutBuffer = (stdoutBuffer + output).replace(/\x1b\[[0-9;]*m/g, '')
    const pattern = /(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB)\s*\/\s*(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB).*?\((\d+)%\)/gi
    let match: RegExpExecArray | null
    while ((match = pattern.exec(stdoutBuffer)) !== null) {
      const downloaded = Number(match[1]) * units[match[2].toLowerCase()]
      const total = Number(match[3]) * units[match[4].toLowerCase()]
      const percent = Number(match[5])
      if (percent >= lastPercent) {
        lastDownloaded = Math.max(lastDownloaded, downloaded)
        lastTotal = Math.max(lastTotal, total)
        lastPercent = percent
        onProgress?.(lastDownloaded, lastTotal, lastPercent)
      }
    }
    if (stdoutBuffer.length > 16384) stdoutBuffer = stdoutBuffer.slice(-8192)
  })
  child.stderr?.on('data', (data) => console.error(`[aria2c] ${String(data).trim()}`))
  const timer = setInterval(async () => {
    try {
      const current = (await stat(destPath)).size
      if (current >= lastDownloaded) { lastDownloaded = current; onProgress?.(current, lastTotal, lastPercent || undefined) }
    } catch { /* 尚未创建文件 */ }
  }, 500)
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`aria2c 退出码 ${code}`))) })
    const size = (await stat(destPath)).size
    onProgress?.(size, size, 100)
    return { ok: true }
  } catch (error) { console.warn('[aria2c] 下载失败:', (error as Error).message); return { ok: false, paused: false, error: (error as Error).message } }
  finally { clearInterval(timer) }
}

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
const GH_PROXY = 'https://gh-proxy.com/'

/** 从 GitHub 获取 YAML 内容（失败时自动尝试代理） */
async function fetchYaml(url: string): Promise<string> {
  const isValidYaml = (text: string) => !/^\s*<!doctype html/i.test(text) && (/^\s*modDatas:/m.test(text) || /SimpleDownloadLink\s*:/i.test(text) || /Version\s*:/i.test(text))
  const urls = url.includes('raw.githubusercontent.com') ? [GH_PROXY + url, url] : [url]
  for (const fetchUrl of urls) {
    try {
      const response = await fetch(fetchUrl, { headers: { 'User-Agent': 'TDHourLauncher/1' } })
      if (response.ok) { const body = await response.text(); if (isValidYaml(body)) return body }
    } catch { /* 尝试 curl/下一个地址 */ }
    try {
      const result = await execFileAsync('curl.exe', ['-L', '--compressed', '-A', 'Mozilla/5.0', '-sS', fetchUrl], { maxBuffer: 8 * 1024 * 1024 })
      if (result.stdout && isValidYaml(result.stdout)) return result.stdout
    } catch { /* 继续 */ }
  }
  if (url.includes('raw.githubusercontent.com')) {
    const proxyUrl = GH_PROXY + url
    const response = await fetch(proxyUrl, { headers: { 'User-Agent': 'TDHourLauncher/1' } })
    if (!response.ok) {
      throw new Error(`代理请求失败: ${response.status}`)
    }
    const body = await response.text()
    if (!isValidYaml(body)) throw new Error('代理返回的不是有效 YAML')
    return body
  }

  throw new Error('无法获取 YAML 内容')
}

type DownloadResult = { ok: true } | { ok: false; paused: boolean; error?: string }

/** 下载文件到指定路径（失败时自动尝试代理，支持暂停/取消） */
export async function downloadFile(
  url: string,
  destPath: string,
  modName: string,
  onProgress?: (downloaded: number, total: number, percent?: number) => void
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

  let normalizedUrl = url
  if (/^https?:\/\/onedrive\.live\.com\/embed\?/i.test(normalizedUrl)) normalizedUrl = normalizedUrl.replace('/embed?', '/download?')
  const ariaUrl = (normalizedUrl.includes('raw.githubusercontent.com') || normalizedUrl.includes('github.com')) ? GH_PROXY + normalizedUrl : normalizedUrl
  const ariaResult = await downloadWithAria2(ariaUrl, destPath, onProgress)
  if (ariaResult) return ariaResult

  const controller = new AbortController()
  downloadControllers.set(modName, controller)

  const doFetch = async (fetchUrl: string, headers: Record<string, string> = {}) => {
    return fetch(fetchUrl, {
      headers: { 'User-Agent': 'TDHourLauncher/1', ...headers },
      redirect: 'follow',
      signal: controller.signal as any
    })
  }

  const tryUrls: Array<{ url: string; headers: Record<string, string> }> = []
  if (url.includes('raw.githubusercontent.com') || url.includes('github.com')) {
    tryUrls.push({ url: GH_PROXY + url, headers: {} }, { url, headers: {} })
  } else {
    tryUrls.push({ url, headers: {} })
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

/** 获取资源目录下的包存储路径（repo 下载落盘到 packages/） */
async function getPackagesDir(gameId: string): Promise<string> {
  const { app } = await import('electron')
  const configPath = join(app.getPath('userData'), 'config.json')
  try {
    const data = await readFile(configPath, 'utf-8')
    const config = JSON.parse(data) as Record<string, string>
    const resourceDir = config.resourceDir
    if (resourceDir) {
      return join(resourceDir, gameId, 'packages')
    }
  } catch {
    // 配置不存在
  }
  // 回退到应用目录
  return join(process.cwd(), 'packages')
}

/** 注册 MOD 相关 IPC 处理器 */
export function registerModHandlers(): void {
  ipcMain.handle('mod:list-installed', async (_e, gameId: string) => {
    const packagesDir = await getPackagesDir(gameId)
    const mods = await readManagedMods(packagesDir)
    const packages: string[] = []
    for (const modName of mods) {
      const entries = await readdir(getModRoot(packagesDir, modName), { withFileTypes: true }).catch(() => [])
      packages.push(...entries.filter((entry) => entry.isDirectory() && !entry.name.endsWith('.downloading')).map((entry) => entry.name))
    }
    return { ok: true, mods, packages }
  })
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
  ipcMain.handle('mod:download', async (e, url: string, gameId: string, modName: string, overwrite = false) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `无效的下载地址: ${JSON.stringify(url)}` }
    }
    const packagesDir = await getPackagesDir(gameId)
    const modsRoot = getModsRoot(packagesDir)
    const mainName = modName.replace(/_(patch|addon)_\d+$/, '')
    const modRoot = getModRoot(packagesDir, mainName)
    const modDir = join(modRoot, modName)
    const tempDir = join(modRoot, `${modName}.downloading`)
    await mkdir(modRoot, { recursive: true })

    try {
      const installed = await stat(modDir)
      if (installed.isDirectory() && !overwrite) {
        return { ok: false, alreadyInstalled: true, path: modDir, error: 'MOD 已安装' }
      }
    } catch { /* 未安装 */ }

    const urlPath = url.split('?')[0].toLowerCase()
    const hasArchiveExtension = urlPath.endsWith('.rar') || urlPath.endsWith('.zip') || urlPath.endsWith('.7z')

    // 根据 URL 中的实际扩展名命名压缩包
    let archiveExt = '.rar'
    if (urlPath.endsWith('.7z')) archiveExt = '.7z'
    else if (urlPath.endsWith('.zip')) archiveExt = '.zip'
    const archivePath = join(tempDir, `${modName}${archiveExt}`)
    const targetFile = hasArchiveExtension ? archivePath : join(tempDir, url.split('?')[0].split('/').pop() || `${modName}.download`)

    // 清理可能残留的 tempDir（上次下载中断留下的，避免污染新下载）
    try { await rm(tempDir, { recursive: true, force: true }) } catch { /* 不存在 */ }

    console.log(`[下载] MOD: ${modName}`)
    console.log(`[下载] URL: ${url}`)
    console.log(`[下载] URL 扩展名判断为压缩包: ${hasArchiveExtension}`)
    console.log(`[下载] 目标: ${targetFile}`)

    // 下载主文件
    const downloadResult = await downloadFile(url, targetFile, modName, (downloaded, total, percent) => {
      e.sender.send('mod:download-progress', {
        modName,
        status: 'downloading',
        progress: percent !== undefined ? Math.round(percent * 0.8) : total > 0 ? Math.round((downloaded / total) * 80) : 0,
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
      const isArchive = hasArchiveExtension || await isExtractableArchive(targetFile)
      console.log(`[下载] 文件内容判断为压缩包: ${isArchive}`)
      if (isArchive) {
        e.sender.send('mod:download-progress', {
          modName,
          status: 'extracting',
          progress: 80,
          downloaded: 0,
          total: 0
        })

        await extractArchive(targetFile, tempDir)
        await unlink(targetFile).catch(() => {})

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

      await markDownloadedMod(packagesDir, mainName)

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

  // 读取 MOD 版本号
  ipcMain.handle('mod:get-version', async (_e, gameId: string, modName: string) => {
    try {
      const modsDir = await getPackagesDir(gameId)
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
      const modsDir = await getPackagesDir(gameId)
      const versionPath = join(modsDir, modName, 'version.txt')
      await mkdir(dirname(versionPath), { recursive: true })
      await writeFile(versionPath, version, 'utf-8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
