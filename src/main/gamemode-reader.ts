import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile } from './ini-parser'
import { getResourceDir } from './resource-dir'
import { findMapInBundle } from './map-library-ops'
import { readWaypoints, readMapSizeInfo } from './map-preview'
import { readGeneralsVfsBuffer } from './big-reader'
import { decodeText, detectTextEncoding } from './ini-parser'

export interface GameModeConfig {
  name: string
  uiName: string
  mapCodeIniName: string
  randomizedMapCodeININames: string[]
  randomizedMapCodesCount: number
  forcedOptionsSection: string
  minPlayersOverride?: number
  maxPlayersOverride?: number
  disallowedPlayerSides: number[]
  disallowedHumanPlayerSides: number[]
  disallowedComputerPlayerSides: number[]
  forcedCheckBoxValues: Record<string, boolean>
  forcedDropDownValues: Record<string, number>
  forcedSpawnIniOptions: Record<string, string>
  /** 合作/挑战模式的 AI 难度（0=困难 1=普通 2=简单；默认 2），作为 coop HouseHandicaps 值 */
  coopDifficultyLevel: number
}

export interface MapConfig {
  filePath: string
  baseFilePath: string
  description: string
  gameModes: string[]
  minPlayers: number
  maxPlayers: number
  enforceMaxPlayers: boolean
  size: string
  localSize: string
  previewSize: string
  waypoints: Record<number, { x: number; y: number }>
  isCoopMission: boolean
  briefing: string
  unitCount?: number
  disallowedPlayerSides: number[]
  disallowedPlayerColors: number[]
  enemyHouses: string[]
  forcedOptions: Record<string, string>
  forcedSpawnIniOptions: Record<string, string>
  extraIniName?: string
  baseSection?: string
}

function decodeBigMapName(value: string): string {
  return value.replace(/_([0-9a-f]{2})_/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\/g, '/')
}

/** 读取 ZH/TD 的 Maps/MapCache.ini（它通常位于 MapsZH.big，而不是 loose 文件）。 */
export async function loadTdMapCache(gameDirs: string[]): Promise<MapConfig[]> {
  const entries = new Map<string, string>()
  for (const dir of gameDirs) {
    const buffer = await readGeneralsVfsBuffer(dir, 'Maps/MapCache.ini')
    if (!buffer) continue
    const text = decodeText(buffer, detectTextEncoding(buffer))
    let current: { path: string; values: Record<string, string>; waypoints: Record<number, { x: number; y: number }> } | null = null
    const flush = (): void => {
      if (!current || !/^yes$/i.test(current.values.isMultiplayer ?? '')) return
      const mapPath = decodeBigMapName(current.path)
      const max = current.values.extentMax?.match(/X:([\d.-]+)\s+Y:([\d.-]+)/i)
      const players = Math.max(2, Number.parseInt(current.values.numPlayers ?? '2', 10) || 2)
      entries.set(mapPath.toLowerCase(), JSON.stringify({
        filePath: mapPath,
        baseFilePath: mapPath,
        description: (current.values.nameLookupTag ?? '').replace(/^MAP:/i, '') || path.basename(mapPath, '.map'),
        gameModes: [], minPlayers: players, maxPlayers: players, enforceMaxPlayers: true,
        size: max ? `${max[1]}x${max[2]}` : '', localSize: '', previewSize: '',
        waypoints: current.waypoints, isCoopMission: false, briefing: '',
        disallowedPlayerSides: [], disallowedPlayerColors: [], enemyHouses: [], forcedOptions: {}, forcedSpawnIniOptions: {}
      }))
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      const header = line.match(/^MapCache\s+(.+)$/i)
      if (header) { flush(); current = { path: header[1].trim(), values: {}, waypoints: {} }; continue }
      if (/^END$/i.test(line)) { flush(); current = null; continue }
      if (!current) continue
      const waypoint = line.match(/^Player_(\d+)_Start\s*=\s*X:([\d.-]+)\s+Y:([\d.-]+)/i)
      if (waypoint) { current.waypoints[Number(waypoint[1]) - 1] = { x: Number(waypoint[2]), y: Number(waypoint[3]) }; continue }
      const assignment = line.match(/^([^=]+?)\s*=\s*(.*)$/)
      if (assignment) current.values[assignment[1].trim()] = assignment[2].trim()
    }
    flush()
  }
  return [...entries.values()].map((value) => JSON.parse(value) as MapConfig)
}

function parseWaypoints(ini: CCIniFile, sectionName: string): Record<number, { x: number; y: number }> {
  const sec = ini.getSection(sectionName)
  if (!sec) return {}

  const waypoints: Record<number, { x: number; y: number }> = {}
  for (const key of sec.keys_names()) {
    const match = key.match(/^Waypoint(\d+)$/i)
    if (match) {
      const idx = parseInt(match[1], 10)
      const val = sec.getString(key)
      const parts = val.split(',').map(s => parseInt(s.trim(), 10))
      if (parts.length >= 2) {
        waypoints[idx] = { x: parts[0], y: parts[1] }
      }
    }
  }
  return waypoints
}

function parseForcedOptions(ini: CCIniFile, sectionName: string): Record<string, string> {
  const sec = ini.getSection(sectionName)
  if (!sec) return {}

  const result: Record<string, string> = {}
  for (const key of sec.keys_names()) {
    result[key] = sec.getString(key)
  }
  return result
}

function parseForcedSpawnIniOptions(ini: CCIniFile, sectionNames: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of sectionNames) {
    const sec = ini.getSection(name.trim())
    if (!sec) continue
    for (const key of sec.keys_names()) {
      result[key] = sec.getString(key)
    }
  }
  return result
}

function parseNumberList(value: string): number[] {
  if (!value) return []
  return value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
}

/**
 * Load game modes from MentalOmegaMaps.ini [GameModes] section + per-mode sections.
 */
export function loadGameModes(gamePath: string): GameModeConfig[] {
  const iniPath = path.join(gamePath, 'INI', 'MentalOmegaMaps.ini')
  if (!fs.existsSync(iniPath)) return []

  const ini = loadIniFile(iniPath)
  const modesSec = ini.getSection('GameModes')
  if (!modesSec) return []

  const modes: GameModeConfig[] = []
  const keys = modesSec.keys_names().sort((a, b) => {
    return parseInt(a, 10) - parseInt(b, 10)
  })

  for (const key of keys) {
    const modeName = modesSec.getString(key)
    if (!modeName) continue

    const sec = ini.getSection(modeName)
    if (!sec) {
      modes.push({
        name: modeName,
        uiName: modeName,
        mapCodeIniName: modeName + '.ini',
        randomizedMapCodeININames: [],
        randomizedMapCodesCount: 1,
        forcedOptionsSection: '',
        disallowedPlayerSides: [],
        disallowedHumanPlayerSides: [],
        disallowedComputerPlayerSides: [],
        forcedCheckBoxValues: {},
        forcedDropDownValues: {},
        forcedSpawnIniOptions: {},
        coopDifficultyLevel: 2
      })
      continue
    }

    const forcedOptionsSection = sec.getString('ForcedOptions')
    const forcedSpawnSectionName = modeName + 'ForcedSpawnIniOptions'
    const forcedSpawnSec = ini.getSection(forcedSpawnSectionName)

    const randomizedRaw = sec.getString('RandomizedMapCodeIniNames')

    modes.push({
      name: modeName,
      uiName: sec.getString('UIName', modeName),
      mapCodeIniName: sec.getString('MapCodeIniName', modeName + '.ini'),
      randomizedMapCodeININames: randomizedRaw ? randomizedRaw.split(',').map(s => s.trim()) : [],
      randomizedMapCodesCount: sec.getInt('RandomizedMapCodesCount', 1),
      forcedOptionsSection,
      minPlayersOverride: sec.has('MinPlayersOverride') ? sec.getInt('MinPlayersOverride') : undefined,
      maxPlayersOverride: sec.has('MaxPlayersOverride') ? sec.getInt('MaxPlayersOverride') : undefined,
      disallowedPlayerSides: parseNumberList(sec.getString('DisallowedPlayerSides')),
      disallowedHumanPlayerSides: parseNumberList(sec.getString('DisallowedHumanPlayerSides')),
      disallowedComputerPlayerSides: parseNumberList(sec.getString('DisallowedComputerPlayerSides')),
      forcedCheckBoxValues: forcedOptionsSection ? parseForcedOptions(ini, forcedOptionsSection) as any : {},
      forcedDropDownValues: {} as any,
      forcedSpawnIniOptions: forcedSpawnSec
        ? Object.fromEntries(forcedSpawnSec.keys_names().map(k => [k, forcedSpawnSec.getString(k)]))
        : {},
      coopDifficultyLevel: sec.has('CoopDifficultyLevel') ? sec.getInt('CoopDifficultyLevel') : 2
    })
  }

  return modes
}

/**
 * Load maps from MentalOmegaMaps.ini [MultiMaps] section.
 */
export function loadMaps(gamePath: string): MapConfig[] {
  const iniPath = path.join(gamePath, 'INI', 'MentalOmegaMaps.ini')
  if (!fs.existsSync(iniPath)) return []

  const ini = loadIniFile(iniPath)
  const multiMapsSec = ini.getSection('MultiMaps')
  if (!multiMapsSec) return []

  const maps: MapConfig[] = []
  const keys = multiMapsSec.keys_names().sort((a, b) => {
    return parseInt(a, 10) - parseInt(b, 10)
  })

  for (const key of keys) {
    const mapPath = multiMapsSec.getString(key)
    if (!mapPath) continue

    const mapSec = ini.getSection(mapPath)
    if (!mapSec) {
      maps.push({
        filePath: mapPath,
        baseFilePath: mapPath,
        description: mapPath,
        gameModes: [],
        minPlayers: 2,
        maxPlayers: 8,
        enforceMaxPlayers: false,
        size: '',
        localSize: '',
        previewSize: '',
        waypoints: {},
        isCoopMission: false,
        briefing: '',
        disallowedPlayerSides: [],
        disallowedPlayerColors: [],
        enemyHouses: [],
        forcedOptions: {},
        forcedSpawnIniOptions: {}
      })
      continue
    }

    // Parse ForcedSpawnIniOptions (can be comma-separated section names)
    const forcedSpawnSectionsRaw = mapSec.getString('ForcedSpawnIniOptions')
    const forcedSpawnSections = forcedSpawnSectionsRaw
      ? forcedSpawnSectionsRaw.split(',').map(s => s.trim())
      : []

    // Parse ForcedOptions section
    const forcedOptionsSection = mapSec.getString('ForcedOptions')

    // Parse base section inheritance
    const baseSection = mapSec.getString('BaseSection') || undefined

    // Merge with base section if specified
    let effectiveSec = mapSec
    if (baseSection) {
      const baseSec = ini.getSection(baseSection)
      if (baseSec) {
        effectiveSec = baseSec.clone()
        // Override with map-specific values
        for (const k of mapSec.keys_names()) {
          effectiveSec.set(k, mapSec.getString(k))
        }
      }
    }

    const waypointsRaw = effectiveSec.getString('Waypoint0') ? '0' : '' // check if any waypoints exist

    maps.push({
      filePath: mapPath,
      baseFilePath: effectiveSec.getString('BaseFilePath') || mapPath,
      description: effectiveSec.getString('Description', mapPath),
      gameModes: effectiveSec.getString('GameModes').split(',').map(s => s.trim()).filter(s => s),
      minPlayers: effectiveSec.getInt('MinPlayers', 2),
      maxPlayers: effectiveSec.getInt('MaxPlayers', 8),
      enforceMaxPlayers: effectiveSec.getBoolean('EnforceMaxPlayers', false),
      size: effectiveSec.getString('Size'),
      localSize: effectiveSec.getString('LocalSize'),
      previewSize: effectiveSec.getString('PreviewSize'),
      waypoints: parseWaypoints(ini, mapPath),
      isCoopMission: effectiveSec.getBoolean('IsCoopMission', false),
      briefing: effectiveSec.getString('Briefing'),
      unitCount: effectiveSec.has('UnitCount') ? effectiveSec.getInt('UnitCount') : undefined,
      disallowedPlayerSides: parseNumberList(effectiveSec.getString('DisallowedPlayerSides')),
      disallowedPlayerColors: parseNumberList(effectiveSec.getString('DisallowedPlayerColors')),
      enemyHouses: effectiveSec.getString('EnemyHouse0')
        ? Array.from({ length: 10 }, (_, i) => effectiveSec.getString(`EnemyHouse${i}`)).filter(s => s)
        : [],
      forcedOptions: forcedOptionsSection ? parseForcedOptions(ini, forcedOptionsSection) : {},
      forcedSpawnIniOptions: parseForcedSpawnIniOptions(ini, forcedSpawnSections),
      extraIniName: effectiveSec.getString('ExtraININame') || undefined,
      baseSection
    })
  }

  return maps
}

/**
 * 包内可选配置读取（模式/预设，格式 TBD）。
 * 扩展点：后续定了下载地图的配置格式，在这里解析出 gameModes / forcedOptions 等。
 * 当前宽松读取 mode.ini/map.ini 的 [GameMode] Mode|Name 进 gameModes；其余忽略。
 */
function readBundleConfig(pkgDir: string): { gameModes: string[]; forcedOptions: Record<string, string> } {
  const result = { gameModes: [] as string[], forcedOptions: {} as Record<string, string> }
  for (const name of ['mode.ini', 'map.ini', 'preset.ini']) {
    const p = path.join(pkgDir, name)
    if (!fs.existsSync(p)) continue
    try {
      const ini = loadIniFile(p)
      const gm = ini.getSection('GameMode')?.getString('Mode')
        ?? ini.getSection('GameMode')?.getString('Name')
        ?? ini.getSection('General')?.getString('Mode')
      if (gm) result.gameModes = [gm]
      const opts = ini.getSection('Options') ?? ini.getSection('Preset')
      if (opts) {
        for (const key of opts.keys_names()) result.forcedOptions[key] = opts.getString(key)
      }
    } catch { /* 忽略坏配置 */ }
    break
  }
  return result
}

/**
 * 独立地图库读取（下载地图专用）：扫 resourceDir/<gameId>/maps/ 下的文件夹包，
 * 每个包 = <图名>/ 内含 .map + 可选配置。返回 MapConfig 供 lobby 地图列表合并。
 * 原有地图仍走 loadMaps（MentalOmegaMaps.ini），不在此。
 */
export async function loadLibraryMaps(gameId: string): Promise<MapConfig[]> {
  const resourceDir = await getResourceDir()
  if (!resourceDir) return []
  const mapsDir = path.join(resourceDir, gameId, 'maps')

  let entries: fs.Dirent[] = []
  try {
    entries = await fs.promises.readdir(mapsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const result: MapConfig[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const pkgDir = path.join(mapsDir, entry.name)
    const mapFile = await findMapInBundle(pkgDir)
    if (!mapFile) continue

    let mapIni: CCIniFile
    try {
      mapIni = loadIniFile(mapFile)
    } catch {
      continue
    }
    const sizeInfo = readMapSizeInfo(mapIni)
    const waypointCount = readWaypoints(mapIni).length
    const players = Math.max(2, Math.min(waypointCount || 2, 8))
    const { gameModes, forcedOptions } = readBundleConfig(pkgDir)

    result.push({
      filePath: mapFile,
      baseFilePath: mapFile,
      description: entry.name,
      gameModes,
      minPlayers: players,
      maxPlayers: players,
      enforceMaxPlayers: false,
      size: `${sizeInfo.width}x${sizeInfo.height}`,
      localSize: `${sizeInfo.localSize.w}x${sizeInfo.localSize.h}`,
      previewSize: '',
      waypoints: {},
      isCoopMission: false,
      briefing: '',
      disallowedPlayerSides: [],
      disallowedPlayerColors: [],
      enemyHouses: [],
      forcedOptions,
      forcedSpawnIniOptions: {}
    })
  }
  return result
}
