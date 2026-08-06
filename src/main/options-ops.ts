/**
 * 游戏画质设置 —— 读写 Options.ini
 *
 * ZH 路径: %USERPROFILE%\Documents\Command and Conquer Generals Zero Hour Data\Options.ini
 * Gen 路径: %USERPROFILE%\Documents\Command and Conquer Generals Data\Options.ini
 */
import { ipcMain } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** Options.ini 的所有画质键 */
export interface GameOptions {
  Resolution: string
  HeatEffects: string
  UseShadowVolumes: string
  UseShadowDecals: string
  UseCloudMap: string
  ShowTrees: string
  BuildingOcclusion: string
  ExtraAnimations: string
  UseLightMap: string
  DynamicLOD: string
  ShowSoftWaterEdge: string
  UseAlternateMouse: string
  MaxParticleCount: string
  TextureReduction: string
  CameraHeight: string
  [key: string]: string
}

/** 获取 Options.ini 路径 */
function getOptionsPath(gameType: 'zh' | 'gen'): string {
  const docsDir = app.getPath('documents')
  if (gameType === 'zh') {
    return join(docsDir, 'Command and Conquer Generals Zero Hour Data', 'Options.ini')
  }
  return join(docsDir, 'Command and Conquer Generals Data', 'Options.ini')
}

/** 默认画质选项 */
const DEFAULT_OPTIONS: Record<string, string> = {
  Resolution: ' 1920 1080',
  HeatEffects: ' no',
  UseShadowVolumes: ' no',
  UseShadowDecals: ' yes',
  UseCloudMap: ' no',
  ShowTrees: ' no',
  BuildingOcclusion: ' no',
  ExtraAnimations: ' no',
  UseLightMap: ' no',
  DynamicLOD: ' yes',
  ShowSoftWaterEdge: ' no',
  UseAlternateMouse: ' no',
  MaxParticleCount: ' 2500',
  TextureReduction: ' 1',
  CameraHeight: ' 310'
}

/** 可用分辨率列表 */
export const RESOLUTION_LIST = [
  '1024×768',
  '1152×864',
  '1280×720',
  '1280×768',
  '1280×800',
  '1280×960',
  '1280×1024',
  '1360×768',
  '1366×768',
  '1440×900',
  '1600×900',
  '1600×1024',
  '1600×1200',
  '1680×1050',
  '1920×1080',
  '1920×1200',
  '1920×1440',
  '2560×1440',
  '3840×2160'
]

/** 解析 Options.ini */
function parseOptions(content: string): GameOptions {
  const options: GameOptions = {} as GameOptions
  for (const line of content.split('\n')) {
    if (!line.includes('=') || line.startsWith('[')) continue
    const eqIndex = line.indexOf('=')
    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1)
    if (key && !options[key]) {
      options[key] = value
    }
  }
  // 补全缺失的默认值
  for (const [key, defaultValue] of Object.entries(DEFAULT_OPTIONS)) {
    if (!options[key]) {
      options[key] = defaultValue
    }
  }
  return options
}

/** 序列化 Options.ini */
function serializeOptions(options: GameOptions): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(options)) {
    if (key.startsWith('_')) continue
    const trimmed = value.startsWith(' ') ? value : ' ' + value
    lines.push(`${key} =${trimmed}`)
  }
  return lines.join('\n')
}

/** 读取 Options.ini */
export async function readOptions(gameType: 'zh' | 'gen'): Promise<GameOptions> {
  const filePath = getOptionsPath(gameType)
  try {
    const content = await readFile(filePath, 'utf-8')
    return parseOptions(content)
  } catch {
    // 文件不存在，返回默认值
    return { ...DEFAULT_OPTIONS } as GameOptions
  }
}

/** 写入 Options.ini */
export async function writeOptions(gameType: 'zh' | 'gen', options: GameOptions): Promise<void> {
  const filePath = getOptionsPath(gameType)
  console.log(`[options:write] ${gameType} -> ${filePath} Windowed=${options.Windowed}`)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, serializeOptions(options), 'utf-8')
}

/** 注册画质设置 IPC 处理器 */
export function registerOptionsHandlers(): void {
  // 读取画质设置
  ipcMain.handle('options:read', async (_e, gameType: 'zh' | 'gen') => {
    try {
      const options = await readOptions(gameType)
      return { ok: true, options }
    } catch (e) {
      const err = e as Error
      return { ok: false, error: err.message }
    }
  })

  // 写入画质设置
  ipcMain.handle('options:write', async (_e, gameType: 'zh' | 'gen', options: GameOptions) => {
    try {
      // UI 只提交它负责的字段；保留音量、网络和游戏内的其它 Options.ini 项。
      const current = await readOptions(gameType)
      await writeOptions(gameType, { ...current, ...options })
      return { ok: true }
    } catch (e) {
      const err = e as Error
      return { ok: false, error: err.message }
    }
  })

  // 应用推荐画质（首次运行）
  ipcMain.handle('options:apply-default', async (_e, gameType: 'zh' | 'gen') => {
    try {
      const options = await readOptions(gameType)
      // 使用默认值覆盖关键选项
      options.HeatEffects = ' no'
      options.UseCloudMap = ' no'
      options.UseShadowVolumes = ' no'
      options.MaxParticleCount = ' 2500'
      options.UseShadowDecals = ' yes'
      options.DynamicLOD = ' yes'
      await writeOptions(gameType, options)
      return { ok: true, options }
    } catch (e) {
      const err = e as Error
      return { ok: false, error: err.message }
    }
  })

  // 获取可用分辨率列表
  ipcMain.handle('options:get-resolutions', async (_e, gameType: 'zh' | 'gen') => {
    const options = await readOptions(gameType)
    const current = options.Resolution?.trim().replace(/\s+/g, '×') ?? '1920×1080'
    const list = [...RESOLUTION_LIST]
    if (!list.includes(current)) {
      list.push(current)
    }
    return { list, current }
  })
}
