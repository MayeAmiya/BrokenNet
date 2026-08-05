import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile } from './ini-parser'

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
