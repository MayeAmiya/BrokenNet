import path from 'path'
import fs from 'fs'
import { createHash } from 'node:crypto'
import { loadIniFile, CCIniFile } from './ini-parser'
import { loadMaps } from './gamemode-reader'

const MAP_CELL_SIZE_X = 48
const MAP_CELL_SIZE_Y = 24
export const MAP_EXTENSIONS = ['.map', '.yrm', '.mmx', '.umx']

export interface MapPreviewData {
  previewPath: string | null
  previewDataUrl: string | null
  previewAvailable: boolean
  mapWidth: number
  mapHeight: number
  startingLocations: Array<{ x: number; y: number; waypoint: number }>
  extraTextures: Array<{ textureName: string; x: number; y: number; level: number; toggleable: boolean }>
  briefing: string
  isCoop: boolean
}

/**
 * Get the preview PNG path for a map file.
 * Convention: same directory, same base name, .png extension.
 */
export function getMapPreviewPath(gamePath: string, mapFilePath: string): string | null {
  const resolved = path.isAbsolute(mapFilePath) ? mapFilePath : path.join(gamePath, mapFilePath)

  // Build candidate PNG paths: same-name with .png
  const dir = path.dirname(resolved)
  const base = path.basename(resolved)
  const baseNoExt = base.replace(/\.[^.]+$/, '')
  const pngName = baseNoExt + '.png'

  // Try 1: directly next to the map file
  const candidate1 = path.join(dir, pngName)
  if (fs.existsSync(candidate1)) return candidate1

  // Try 2: same name without any extension manipulation, just append .png
  const candidate2 = resolved + '.png'
  if (fs.existsSync(candidate2)) return candidate2

  return null
}

/** 地图矩形（格数，来自 [Map] 段的 Size=/LocalSize=x,y,w,h） */
interface MapRect { x: number; y: number; w: number; h: number }

/**
 * 读取地图尺寸。MO 等距图用 LocalSize（本地可视区）和 Size（全图）。
 * 返回原始格数供等距转换使用（对齐 xna Map.cs 的 actualSizeValues/localSizeValues）。
 */
export function readMapSizeInfo(mapIni: CCIniFile): { actualSize: MapRect; localSize: MapRect; width: number; height: number } {
  const sec = mapIni.getSection('Map')
  const parse = (v?: string): MapRect | null => {
    if (!v) return null
    const p = v.split(',').map(s => parseInt(s.trim(), 10))
    if (p.length >= 4 && !isNaN(p[2]) && !isNaN(p[3])) {
      return { x: p[0] || 0, y: p[1] || 0, w: p[2], h: p[3] }
    }
    return null
  }
  const localSize = parse(sec?.getString('LocalSize'))
  const actualSize = parse(sec?.getString('Size'))
  const fallback: MapRect = { x: 0, y: 0, w: Math.ceil(1024 / MAP_CELL_SIZE_X), h: Math.ceil(768 / MAP_CELL_SIZE_Y) }
  const eff = localSize ?? actualSize ?? fallback
  return {
    actualSize: actualSize ?? { x: 0, y: 0, w: eff.w, h: eff.h },
    localSize: localSize ?? { x: 0, y: 0, w: eff.w, h: eff.h },
    width: eff.w * MAP_CELL_SIZE_X,
    height: eff.h * MAP_CELL_SIZE_Y
  }
}

/** 读取 PNG 文件的实际像素尺寸（PNG 头 16-23 字节是大端宽高） */
function readPngSize(filePath: string): { width: number; height: number } | null {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null // 非 PNG
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width > 0 && height > 0) return { width, height }
  } catch { /* ignore */ }
  return null
}

/**
 * Read starting locations from [Waypoints] section.
 * RA2 地图原生格式用裸数字键（0=…、1=…，前 8 个是出生点，20+ 是触发/目标点）；
 * 也兼容 CnCNet 自定义的 WaypointN=… 写法。
 */
export function readWaypoints(mapIni: CCIniFile): string[] {
  const sec = mapIni.getSection('Waypoints')
  if (!sec) return []

  const waypoints: string[] = []
  for (let i = 0; i < 8; i++) {
    const val = sec.getString(`Waypoint${i}`) || sec.getString(String(i))
    if (!val) break
    waypoints.push(val)
  }
  return waypoints
}

/**
 * Convert isometric waypoint coordinates to preview pixel coordinates.
 * 对齐 xna Map.cs 的 GetIsometricWaypointCoords + GetIsoTilePixelCoord：
 * - waypoint 编码：前缀=isoTileY，后 3 位=isoTileX
 * - rx/ry 用 actualSize（Size=）的全图宽度，再减 localSize（LocalSize=）的原点偏移
 * - 归一化到 localSize 宽高后 × 预览 PNG 像素尺寸
 */
function getIsometricWaypointCoords(
  waypoint: string,
  actualSize: MapRect,
  localSize: MapRect,
  previewSize: { width: number; height: number }
): { x: number; y: number } | null {
  if (!waypoint) return null

  const parts = waypoint.split(',').map(s => s.trim())
  if (parts.length < 1) return null

  const wpStr = parts[0]
  if (wpStr.length < 3) return null

  // 前缀 = isoTileY，后 3 位 = isoTileX（对齐 xna：xCoordIndex = len - 3）
  const isoTileY = parseInt(wpStr.substring(0, wpStr.length - 3), 10)
  const isoTileX = parseInt(wpStr.substring(wpStr.length - 3), 10)

  if (isNaN(isoTileX) || isNaN(isoTileY)) return null

  // Level (Z) from second part
  const level = parts.length >= 2 ? (parseInt(parts[1], 10) || 0) : 0

  // 对齐 xna GetIsoTilePixelCoord
  const rx = isoTileX - isoTileY + actualSize.w - 1
  const ry = isoTileX + isoTileY - actualSize.w - 1

  let pixelPosX = rx * MAP_CELL_SIZE_X / 2
  let pixelPosY = ry * MAP_CELL_SIZE_Y / 2 - level * MAP_CELL_SIZE_Y / 2

  // 减去本地图原点偏移（LocalSize 的 x/y）
  pixelPosX -= localSize.x * MAP_CELL_SIZE_X
  pixelPosY -= localSize.y * MAP_CELL_SIZE_Y

  const mapSizeX = localSize.w * MAP_CELL_SIZE_X
  const mapSizeY = localSize.h * MAP_CELL_SIZE_Y
  if (mapSizeX <= 0 || mapSizeY <= 0) return null

  return {
    x: Math.round((pixelPosX / mapSizeX) * previewSize.width),
    y: Math.round((pixelPosY / mapSizeY) * previewSize.height)
  }
}

/**
 * Read extra textures from map INI.
 */
function readExtraTextures(mapIni: CCIniFile): Array<{ textureName: string; x: number; y: number; level: number; toggleable: boolean }> {
  const sec = mapIni.getSection('Map')
  if (!sec) return []

  const textures: Array<{ textureName: string; x: number; y: number; level: number; toggleable: boolean }> = []

  for (let i = 0; i < 10; i++) {
    const val = sec.getString(`ExtraTexture${i}`)
    if (!val) continue

    const parts = val.split(',').map(s => s.trim())
    if (parts.length < 3) continue

    textures.push({
      textureName: parts[0],
      x: parseInt(parts[1], 10) || 0,
      y: parseInt(parts[2], 10) || 0,
      level: parts.length >= 4 ? (parseInt(parts[3], 10) || 0) : 0,
      toggleable: parts.length >= 5 ? parts[4].toLowerCase() === 'true' : true
    })
  }

  return textures
}

/**
 * Load full map preview data for a map file.
 */
export function loadMapPreviewData(gamePath: string, mapFilePath: string): MapPreviewData {
  // Resolve to absolute path if relative
  let resolvedMapPath = path.isAbsolute(mapFilePath) ? mapFilePath : path.join(gamePath, mapFilePath)
  // If resolved path has no extension, try common map extensions
  if (!path.extname(resolvedMapPath)) {
    const dir = path.dirname(resolvedMapPath)
    const base = path.basename(resolvedMapPath)
    for (const ext of MAP_EXTENSIONS) {
      const candidate = path.join(dir, base + ext)
      if (fs.existsSync(candidate)) { resolvedMapPath = candidate; break }
    }
  }
  const previewPath = getMapPreviewPath(gamePath, resolvedMapPath)

  // Load map INI for metadata
  let waypoints: string[] = []
  let mapInfo = readMapSizeInfo(new CCIniFile()) // 默认尺寸兜底
  let extraTextures: Array<{ textureName: string; x: number; y: number; level: number; toggleable: boolean }> = []
  let briefing = ''
  let isCoop = false

  if (fs.existsSync(resolvedMapPath)) {
    const mapIni = loadIniFile(resolvedMapPath)
    mapInfo = readMapSizeInfo(mapIni)
    waypoints = readWaypoints(mapIni)
    extraTextures = readExtraTextures(mapIni)

    const mapSec = mapIni.getSection('Map')
    briefing = mapSec?.getString('Briefing') ?? ''
    isCoop = mapSec?.getBoolean('IsCoopMission', false) ?? false
  }

  // 出生点换算到"预览 PNG 的实际像素尺寸"，保证和底图同坐标系
  let previewSize = (previewPath ? readPngSize(previewPath) : null) ?? { width: 512, height: 384 }

  // 权威出生点来源是 MentalOmegaMaps.ini 的地图段：
  // 普通多人图 WaypointN 就是全部出生点；挑战/合作图只列【人类可选】的出生点，
  // AI 位置在 EnemyHouse 里预设，不参与选择。另外 PreviewSize 就是预览 PNG 尺寸。
  try {
    const mapsIniPath = path.join(gamePath, 'INI', 'MentalOmegaMaps.ini')
    if (fs.existsSync(mapsIniPath)) {
      const mapsIni = loadIniFile(mapsIniPath)
      const rel = path.relative(gamePath, resolvedMapPath).replace(/\.(map|yrm|mmx|umx)$/i, '')
      const sec = mapsIni.getSection(rel)
      if (sec) {
        const cfgWaypoints: string[] = []
        for (let i = 0; i < 8; i++) {
          const v = sec.getString(`Waypoint${i}`)
          if (!v) break
          cfgWaypoints.push(v)
        }
        if (cfgWaypoints.length > 0) waypoints = cfgWaypoints
        // Size/LocalSize/PreviewSize 也从配置读（配置可能覆盖地图文件，waypoint 与之对应）
        const parseRect = (v?: string): MapRect | null => {
          if (!v) return null
          const p = v.split(',').map(s => parseInt(s.trim(), 10))
          if (p.length >= 4 && !isNaN(p[2]) && !isNaN(p[3])) return { x: p[0] || 0, y: p[1] || 0, w: p[2], h: p[3] }
          return null
        }
        const cfgActual = parseRect(sec.getString('Size'))
        const cfgLocal = parseRect(sec.getString('LocalSize'))
        if (cfgActual) mapInfo = { ...mapInfo, actualSize: cfgActual }
        if (cfgLocal) mapInfo = { ...mapInfo, localSize: cfgLocal }
        const ps = sec.getString('PreviewSize')
        if (ps) {
          const [w, h] = ps.split(',').map(s => parseInt(s.trim(), 10))
          if (w > 0 && h > 0) previewSize = { width: w, height: h }
        }
      }
    }
  } catch { /* 配置缺失时用地图文件自身的 waypoint */ }

  // 如果 .map 文件里没有 briefing，从 MentalOmegaMaps.ini 查找
  if (!briefing) {
    try {
      const iniPath = path.join(gamePath, 'INI', 'MentalOmegaMaps.ini')
      if (fs.existsSync(iniPath)) {
        const mapsIni = loadIniFile(iniPath)
        // 用地图文件名（无扩展名）匹配 section
        const mapBase = path.basename(resolvedMapPath).replace(/\.[^.]+$/, '')
        // 也试路径形式 e.g. MapsMO\Standard\actionreaction
        const relPath = path.relative(path.join(gamePath, 'INI'), resolvedMapPath).replace(/\.[^.]+$/, '').replace(/\\/g, '\\')
        // MultiMaps 的 key 值就是 section 名
        const multiMapsSec = mapsIni.getSection('MultiMaps')
        if (multiMapsSec) {
          for (const key of multiMapsSec.keys_names()) {
            const sectionName = multiMapsSec.getString(key)
            if (sectionName.toLowerCase().includes(mapBase.toLowerCase())) {
              const sec = mapsIni.getSection(sectionName)
              if (sec) {
                briefing = sec.getString('Briefing') ?? ''
                isCoop = sec.getBoolean('IsCoopMission', false) ?? false
                if (briefing) break
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Convert waypoints to preview-pixel coordinates（坐标系 = 预览 PNG 实际像素尺寸）
  const startingLocations = waypoints
    .map((wp, i) => {
      const coords = getIsometricWaypointCoords(wp, mapInfo.actualSize, mapInfo.localSize, previewSize)
      return coords ? { x: coords.x, y: coords.y, waypoint: i + 1 } : null
    })
    .filter((loc): loc is { x: number; y: number; waypoint: number } => loc !== null)

  const previewDataUrl = previewPath ? (() => {
    try {
      const buf = fs.readFileSync(previewPath)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch { return null }
  })() : null

  return {
    previewPath,
    previewDataUrl,
    previewAvailable: previewPath !== null,
    mapWidth: previewSize.width,
    mapHeight: previewSize.height,
    startingLocations,
    extraTextures,
    briefing,
    isCoop
  }
}

/**
 * Find a map file by name or relative path in the game directory.
 * Supports both plain names (searches common dirs) and relative paths (e.g. MapsMO\Standard\foo).
 */
export function findMapFileByName(gamePath: string, mapName: string): string | null {
  // 绝对路径（如地图库 maps/<图名>/<图名>.map）：直接按存在性解析
  if (path.isAbsolute(mapName)) {
    if (fs.existsSync(mapName)) return mapName
    for (const ext of MAP_EXTENSIONS) {
      const candidate = `${mapName}${ext}`
      if (fs.existsSync(candidate)) return candidate
    }
    return null
  }
  // If the name already contains path separators, treat as relative path
  if (mapName.includes('/') || mapName.includes('\\')) {
    for (const ext of MAP_EXTENSIONS) {
      const candidate = path.join(gamePath, `${mapName}${ext}`)
      if (fs.existsSync(candidate)) return candidate
    }
    // Also try with the original extensions (e.g. already has .map)
    const direct = path.join(gamePath, mapName)
    if (fs.existsSync(direct)) return direct
    return null
  }

  // Plain name — search common directories
  const searchDirs = [
    gamePath,
    path.join(gamePath, 'Maps'),
    path.join(gamePath, 'MapsMO'),
    path.join(gamePath, 'MapsMO', 'Standard'),
    path.join(gamePath, 'MapsMO', 'Tournament'),
    path.join(gamePath, 'Resources'),
    path.join(gamePath, 'INI')
  ]

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue
    for (const ext of MAP_EXTENSIONS) {
      const candidate = path.join(dir, `${mapName}${ext}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }

  return null
}

/**
 * 解析地图真实文件路径：支持绝对路径 / 相对游戏目录路径，
 * 缺扩展名时尝试常见地图扩展名（.map/.yrm/.mmx/.umx）。
 */
function resolveMapFilePath(gamePath: string, mapPath: string): string | null {
  const resolved = path.isAbsolute(mapPath) ? mapPath : path.join(gamePath, mapPath)
  if (fs.existsSync(resolved)) return resolved
  if (!path.extname(resolved)) {
    for (const ext of MAP_EXTENSIONS) {
      const candidate = resolved + ext
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

// 地图哈希索引缓存：gamePath -> (sha1 -> 真实文件路径)
const mapHashIndexCache = new Map<string, Map<string, string>>()

/**
 * 按地图内容 SHA1 查找本地地图文件（参考客户端用 Map.SHA1 做主键匹配）。
 * 首次对某游戏目录构建索引（读地图文件算 SHA1），之后命中缓存。
 */
export function findMapByHash(gamePath: string, mapHash: string): string | null {
  if (!gamePath || !mapHash) return null
  let index = mapHashIndexCache.get(gamePath)
  if (!index) {
    index = new Map()
    for (const map of loadMaps(gamePath)) {
      const base = map.baseFilePath || map.filePath
      const resolved = resolveMapFilePath(gamePath, base)
      if (!resolved) continue
      try {
        const sha1 = createHash('sha1').update(fs.readFileSync(resolved)).digest('hex')
        index.set(sha1.toLowerCase(), resolved)
      } catch { /* 文件读取失败跳过 */ }
    }
    mapHashIndexCache.set(gamePath, index)
  }
  return index.get(mapHash.toLowerCase()) ?? null
}

/**
 * 按地图内容 SHA1 查找本地地图信息（description/baseFilePath/filePath）。
 * 跨语言同步用：同一张图在中文/英文客户端 description 不同，但 SHA1 相同，
 * 用 hash 匹配（对齐参考客户端 Map.SHA1 主键），避免按显示名对不上。
 */
export function findMapInfoByHash(
  gamePath: string,
  mapHash: string
): { filePath: string; baseFilePath: string; description: string } | null {
  const resolved = findMapByHash(gamePath, mapHash)
  if (!resolved) return null
  const resolvedLower = resolved.toLowerCase()
  for (const map of loadMaps(gamePath)) {
    const base = map.baseFilePath || map.filePath
    const r = resolveMapFilePath(gamePath, base)
    if (r && r.toLowerCase() === resolvedLower) {
      return { filePath: map.filePath, baseFilePath: map.baseFilePath, description: map.description }
    }
  }
  // 没有 MentalOmegaMaps.ini 配置也返回路径兜底（用文件基础名当显示名）
  return {
    filePath: resolved,
    baseFilePath: resolved,
    description: resolved.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? ''
  }
}

/**
 * 按地图名（显示名/路径）计算 SHA1。L-MAP 请求跨语言同步用：请求方把自己的图 hash 发给房主。
 */
export function findMapHashByName(gamePath: string, mapName: string): string {
  const compute = (resolved: string): string => {
    try {
      return createHash('sha1').update(fs.readFileSync(resolved)).digest('hex')
    } catch {
      return ''
    }
  }
  for (const map of loadMaps(gamePath)) {
    if (map.description === mapName || map.filePath === mapName || map.baseFilePath === mapName) {
      const resolved = resolveMapFilePath(gamePath, map.baseFilePath || map.filePath)
      if (resolved) return compute(resolved)
    }
  }
  const direct = findMapFileByName(gamePath, mapName)
  if (direct) return compute(direct)
  return ''
}

/**
 * Load map preview by map name (resolves file path automatically).
 */
export function loadMapPreviewByName(gamePath: string, mapName: string): MapPreviewData {
  const mapFile = findMapFileByName(gamePath, mapName)
  if (!mapFile) {
    return {
      previewPath: null,
      previewDataUrl: null,
      previewAvailable: false,
      mapWidth: 1024,
      mapHeight: 768,
      startingLocations: [],
      extraTextures: [],
      briefing: '',
      isCoop: false
    }
  }
  return loadMapPreviewData(gamePath, mapFile)
}
