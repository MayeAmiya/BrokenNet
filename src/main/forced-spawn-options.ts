import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile } from './ini-parser'

export interface SpawnIniOverride {
  key: string
  value: string
}

/**
 * 3-level ForcedSpawnIniOptions system:
 * Level 1: Global from GameOptions.ini [ForcedSpawnIniOptions]
 * Level 2: Game mode from MentalOmegaMaps.ini [{modeName}ForcedSpawnIniOptions]
 * Level 3: Map from MentalOmegaMaps.ini per-map ForcedSpawnIniOptions key
 */

export function readGlobalForcedSpawnOptions(gamePath: string): SpawnIniOverride[] {
  const iniPath = path.join(gamePath, 'Resources', 'GameOptions.ini')
  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('ForcedSpawnIniOptions')
  if (!sec) return []

  return sec.keys_names().map(key => ({
    key,
    value: sec.getString(key)
  }))
}

export function readGameModeForcedSpawnOptions(
  gamePath: string,
  gameModeName: string
): SpawnIniOverride[] {
  const iniPath = path.join(gamePath, 'INI', 'MentalOmegaMaps.ini')
  if (!fs.existsSync(iniPath)) return []

  const ini = loadIniFile(iniPath)

  // Try direct section name first: "{gameModeName}ForcedSpawnIniOptions"
  let sectionName = ini.getStringValue(gameModeName, 'ForcedSpawnIniOptions', '')

  // Fallback to "{gameModeName}ForcedSpawnIniOptions"
  if (!sectionName) {
    sectionName = gameModeName + 'ForcedSpawnIniOptions'
  }

  const sec = ini.getSection(sectionName)
  if (!sec) return []

  return sec.keys_names().map(key => ({
    key,
    value: sec.getString(key)
  }))
}

export function readMapForcedSpawnOptions(
  gamePath: string,
  mapFilePath: string
): SpawnIniOverride[] {
  const ini = loadIniFile(mapFilePath)
  const sec = ini.getSection('ForcedSpawnIniOptions')
  if (!sec) return []

  return sec.keys_names().map(key => ({
    key,
    value: sec.getString(key)
  }))
}

/**
 * Apply all 3 levels of forced spawn.ini options to the spawn.ini content.
 * Later levels override earlier levels for the same key.
 */
export function applyAllForcedSpawnOptions(
  gamePath: string,
  gameModeName: string,
  mapFilePath: string | undefined,
  existingOptions: Record<string, string>
): Record<string, string> {
  const result = { ...existingOptions }

  // Level 1: Global
  const global = readGlobalForcedSpawnOptions(gamePath)
  for (const opt of global) {
    result[opt.key] = opt.value
  }

  // Level 2: Game mode
  if (gameModeName) {
    const modeOptions = readGameModeForcedSpawnOptions(gamePath, gameModeName)
    for (const opt of modeOptions) {
      result[opt.key] = opt.value
    }
  }

  // Level 3: Map
  if (mapFilePath && fs.existsSync(mapFilePath)) {
    const mapOptions = readMapForcedSpawnOptions(gamePath, mapFilePath)
    for (const opt of mapOptions) {
      result[opt.key] = opt.value
    }
  }

  return result
}

/**
 * Generate spawn.ini content with all forced options applied.
 */
export function generateSpawnIni(
  gamePath: string,
  gameModeName: string,
  mapFilePath: string | undefined,
  baseOptions: Record<string, string>
): string {
  const options = applyAllForcedSpawnOptions(gamePath, gameModeName, mapFilePath, baseOptions)

  const lines: string[] = ['[Settings]']
  for (const [key, value] of Object.entries(options)) {
    lines.push(`${key}=${value}`)
  }
  return lines.join('\r\n') + '\r\n'
}
