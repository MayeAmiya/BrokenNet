import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile, detectTextEncoding, encodeText } from './ini-parser'

/**
 * MapCodeHelper - applies map code INI files to map INIs.
 * Handles:
 * - [ReplaceMapInfantry], [ReplaceMapUnits], [ReplaceMapAircraft], [ReplaceMapStructures], [ReplaceMapTerrain]
 * - GameModeIncludes section (extra INI per game mode)
 * - Consolidation of map code onto map INI
 */

/**
 * 从对象段的值里取对象类型 ID（对齐 xna MapCodeHelper.GetObjectID）。
 * YR 地图对象段条目格式是 "数量,类型[,…]"，第二个字段才是类型名；
 * Terrain 段的值直接就是类型名。
 */
function getObjectID(value: string, sectionName: string): string {
  if (sectionName !== 'Terrain') {
    const parts = value.split(',')
    if (parts.length < 2) return ''
    return parts[1].trim()
  }
  return value.trim()
}

export function replaceMapObjects(
  mapIni: CCIniFile,
  mapCodeIni: CCIniFile,
  objectType: 'Aircraft' | 'Infantry' | 'Units' | 'Structures' | 'Terrain'
): void {
  const sectionName = `ReplaceMap${objectType}`
  const sec = mapCodeIni.getSection(sectionName)
  if (!sec) return

  const mapSec = mapIni.getSection(objectType)
  if (!mapSec) return

  // 规则格式：旧类型名=新类型名（对齐 xna；注意 keys 被小写化存储，
  // 而 map 段值里的类型名保留原大小写，故比较用小写、替换用原大小写名）
  for (const key of sec.keys_names()) {
    const oldId = key.toLowerCase()
    const newId = sec.getString(key)
    for (const mapKey of mapSec.keys_names()) {
      const mapVal = mapSec.getString(mapKey)
      const objId = getObjectID(mapVal, objectType)
      if (objId.toLowerCase() === oldId) {
        if (newId) {
          // "5,USRanger" -> "5,E3"
          mapSec.set(mapKey, mapVal.replace(objId, newId))
        } else {
          // 空值 = 移除该单位
          mapSec.set(mapKey, '')
        }
      }
    }
  }
}

/**
 * Consolidate map code INI onto map INI (merge sections, overwrite keys).
 * 保留原大小写（对齐参考输出：spawnmap.ini 的段名/键名沿用 map code 文件的大小写）。
 */
export function consolidateIniFiles(target: CCIniFile, source: CCIniFile): void {
  for (const sectionName of source.getSectionNames_original()) {
    // Skip meta sections（段名统一小写比较）
    const lowerName = sectionName.toLowerCase()
    if (lowerName === 'gamemodeincludes') continue
    if (lowerName.startsWith('replacemap')) continue

    const sourceSec = source.getSection(sectionName)
    if (!sourceSec) continue

    const targetSec = target.getOrAddSection(sectionName)
    for (const key of sourceSec.keys_names_original()) {
      targetSec.set(key, sourceSec.getString(key))
    }
  }
}

/**
 * Apply a single map code INI file to a map INI.
 */
export function applyMapCodeToFile(mapIni: CCIniFile, mapCodePath: string): void {
  if (!fs.existsSync(mapCodePath)) return
  const mapCodeIni = loadIniFile(mapCodePath)
  applyMapCodeFromIni(mapIni, mapCodeIni)
}

/**
 * Apply map code from an already-loaded INI.
 */
export function applyMapCodeFromIni(mapIni: CCIniFile, mapCodeIni: CCIniFile): void {
  // Replace objects
  replaceMapObjects(mapIni, mapCodeIni, 'Aircraft')
  replaceMapObjects(mapIni, mapCodeIni, 'Infantry')
  replaceMapObjects(mapIni, mapCodeIni, 'Units')
  replaceMapObjects(mapIni, mapCodeIni, 'Structures')
  replaceMapObjects(mapIni, mapCodeIni, 'Terrain')

  // Consolidate
  consolidateIniFiles(mapIni, mapCodeIni)
}

/**
 * Apply full map code chain for a game mode:
 * 1. Load base map code INI (e.g., INI/Map Code/{modeName}.ini)
 * 2. Check GameModeIncludes for extra INI
 * 3. Apply checkbox custom INI paths
 *
 * 对齐 xna 参考实现的 WriteMap：原 .map 文件只读不改，
 * 应用完 Map Code 后写到 <gamePath>/spawnmap.ini（会话副本），
 * 由 spawn.ini 的 Scenario=spawnmap.ini 让游戏加载这份副本。
 * 写回保持原图编码（GBK/UTF-8…），避免中文乱码。
 */
export function applyMapCode(
  gamePath: string,
  mapIniPath: string,
  gameModeMapCodeIniName: string,
  gameModeName: string,
  customIniPaths: string[] = []
): { ok: boolean; error?: string; spawnMapPath?: string } {
  if (!fs.existsSync(mapIniPath)) return { ok: false, error: `地图文件不存在: ${mapIniPath}` }

  // 一次读入：二进制检测（NUL 字节）+ 编码检测共用同一份 buffer
  let mapBuf: Buffer
  try {
    mapBuf = fs.readFileSync(mapIniPath)
  } catch (e) {
    return { ok: false, error: `读取地图失败: ${(e as Error).message}` }
  }

  // 二进制地图无法安全按文本解析/应用，直接拒绝
  if (mapBuf.includes(0)) {
    return { ok: false, error: '地图含二进制数据（内嵌 Cells 压缩），无法安全应用 Map Code' }
  }

  // 检测原图编码，写回 spawnmap.ini 时保持同一编码
  const mapEncoding = detectTextEncoding(mapBuf)
  const mapIni = loadIniFile(mapIniPath)

  // 1. Load base map code
  const mapCodePath = path.join(gamePath, 'INI', 'Map Code', gameModeMapCodeIniName)
  if (fs.existsSync(mapCodePath)) {
    const mapCodeIni = loadIniFile(mapCodePath)

    // Check for GameModeIncludes extra INI
    const includesSec = mapCodeIni.getSection('GameModeIncludes')
    let extraIniName = ''
    if (includesSec) {
      extraIniName = includesSec.getString(gameModeName)
    }

    // Apply base map code
    applyMapCodeFromIni(mapIni, mapCodeIni)

    // Apply extra INI if specified
    if (extraIniName) {
      const extraPath = path.join(gamePath, 'INI', 'Map Code', extraIniName)
      if (fs.existsSync(extraPath)) {
        applyMapCodeToFile(mapIni, extraPath)
      }
    }
  }

  // 对齐 xna WriteMap：全局 Map Code（存在才应用；MO 无此文件故无影响）
  applyMapCodeToFile(mapIni, path.join(gamePath, 'INI', 'Map Code', 'GlobalCode.ini'))
  applyMapCodeToFile(mapIni, path.join(gamePath, 'INI', 'Map Code', 'MultiplayerGlobalCode.ini'))

  // 2. Apply custom INI paths (from enabled game-option checkboxes / MapCode-mode dropdowns，
  //    对齐 xna chkBox.ApplyMapCode / dd.ApplyMapCode：INI/Game Options/*.ini)
  for (const customPath of customIniPaths) {
    const fullPath = path.join(gamePath, customPath)
    if (fs.existsSync(fullPath)) {
      applyMapCodeToFile(mapIni, fullPath)
    }
  }

  // 对齐 xna WriteMap：MultiplayerDialogSettings 段必须排最前（YR 要求）
  if (mapIni.sections.has('multiplayerdialogsettings')) {
    const sec = mapIni.sections.get('multiplayerdialogsettings')!
    mapIni.sections.delete('multiplayerdialogsettings')
    mapIni.sections = new Map([['multiplayerdialogsettings', sec], ...mapIni.sections])
  }

  // 序列化并写到 spawnmap.ini（gamePath 应传 spawn.ini 所在目录，即游戏运行目录）
  // 段名/键名用原始大小写（对齐 xna 输出；游戏 INI 解析不区分大小写，但参考客户端保留原图大小写）
  const lines: string[] = []
  for (const section of mapIni.sections.values()) {
    lines.push(`[${section.name}]`)
    for (const key of section.keys_names_original()) {
      lines.push(`${key}=${section.getString(key)}`)
    }
    lines.push('')
  }
  const spawnMapPath = path.join(gamePath, 'spawnmap.ini')
  try {
    fs.writeFileSync(spawnMapPath, encodeText(lines.join('\r\n'), mapEncoding))
  } catch (e) {
    return { ok: false, error: `写 spawnmap.ini 失败: ${(e as Error).message}` }
  }
  return { ok: true, spawnMapPath }
}

/**
 * Get map code INI files for a game mode (with randomization support).
 */
export function getMapCodeFiles(
  gamePath: string,
  gameModeMapCodeIniName: string,
  randomizedNames: string[],
  randomizedCount: number
): string[] {
  const result: string[] = []

  // Base map code
  const basePath = path.join(gamePath, 'INI', 'Map Code', gameModeMapCodeIniName)
  if (fs.existsSync(basePath)) {
    result.push(basePath)
  }

  // Randomized map codes
  if (randomizedNames.length > 0 && randomizedCount > 0) {
    const available = randomizedNames.filter(name => {
      return fs.existsSync(path.join(gamePath, 'INI', 'Map Code', name))
    })

    if (available.length > 0) {
      // Shuffle and pick
      const shuffled = [...available].sort(() => Math.random() - 0.5)
      for (let i = 0; i < Math.min(randomizedCount, shuffled.length); i++) {
        result.push(path.join(gamePath, 'INI', 'Map Code', shuffled[i]))
      }
    }
  }

  return result
}
