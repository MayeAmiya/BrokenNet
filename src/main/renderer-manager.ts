import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { loadIniFile, CCIniFile, IniSection } from './ini-parser'

export interface RendererApplyResult {
  ok: boolean
  error?: string
  rendererKey: string
  filesCopied: string[]
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function sha1File(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha1').update(content).digest('hex')
}

function copyOrLink(src: string, dst: string, force = false): boolean {
  if (!fs.existsSync(src)) return false
  ensureDir(dst)
  if (fs.existsSync(dst) && !force) {
    if (sha1File(src) === sha1File(dst)) return true
  }
  try {
      fs.copyFileSync(src, dst, force ? 1 : 0)
    return true
  } catch {
    try {
      fs.linkSync(src, dst)
      return true
    } catch {
      try {
        fs.copyFileSync(src, dst)
        return true
      } catch {
        return false
      }
    }
  }
}

function removeFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch { /* ignore */ }
}

/**
 * Apply renderer: copy DLL as ddraw.dll, copy config files, copy additional files.
 */
export function applyRenderer(
  gamePath: string,
  resourcesPath: string,
  rendererKey: string,
  renderersIni: CCIniFile
): RendererApplyResult {
  const sec = renderersIni.getSection(rendererKey)
  if (!sec) return { ok: false, error: `Renderer section [${rendererKey}] not found`, rendererKey, filesCopied: [] }

  const dllName = sec.getString('DLLName')
  const configFileName = sec.getString('ConfigFileName')
  const resConfigFileName = sec.getString('ResConfigFileName')
  const additionalFilesRaw = sec.getString('AdditionalFiles')

  const filesCopied: string[] = []

  // 1. Copy DLL as ddraw.dll
  if (dllName) {
    const src = path.join(resourcesPath, dllName)
    const dst = path.join(gamePath, 'ddraw.dll')
    if (copyOrLink(src, dst, true)) {
      filesCopied.push('ddraw.dll')
    } else {
      return { ok: false, error: `Failed to copy ${dllName} -> ddraw.dll`, rendererKey, filesCopied }
    }
  }

  // 2. Copy config file (don't overwrite if exists)
  if (configFileName && resConfigFileName) {
    const src = path.join(resourcesPath, resConfigFileName)
    const dst = path.join(gamePath, configFileName)
    if (!fs.existsSync(dst)) {
      if (copyOrLink(src, dst, false)) {
        filesCopied.push(configFileName)
      }
    }
  } else if (configFileName) {
    const src = path.join(resourcesPath, configFileName)
    const dst = path.join(gamePath, configFileName)
    if (!fs.existsSync(dst)) {
      if (copyOrLink(src, dst, false)) {
        filesCopied.push(configFileName)
      }
    }
  }

  // 3. Copy additional files (always overwrite)
  if (additionalFilesRaw) {
    const files = additionalFilesRaw.split(',').map(s => s.trim()).filter(s => s)
    for (const file of files) {
      const src = path.join(resourcesPath, file)
      const dst = path.join(gamePath, path.basename(file))
      if (copyOrLink(src, dst, true)) {
        filesCopied.push(path.basename(file))
      }
    }
  }

  return { ok: true, rendererKey, filesCopied }
}

/**
 * Clean old renderer files when switching renderers.
 */
export function cleanRenderer(
  gamePath: string,
  resourcesPath: string,
  rendererKey: string,
  renderersIni: CCIniFile
): void {
  const sec = renderersIni.getSection(rendererKey)
  if (!sec) return

  const configFileName = sec.getString('ConfigFileName')
  const additionalFilesRaw = sec.getString('AdditionalFiles')

  if (configFileName) {
    removeFile(path.join(gamePath, configFileName))
  }

  if (additionalFilesRaw) {
    const files = additionalFilesRaw.split(',').map(s => s.trim()).filter(s => s)
    for (const file of files) {
      removeFile(path.join(gamePath, path.basename(file)))
    }
  }
}

/**
 * Write windowed/borderless mode to renderer-specific config file.
 * e.g., CnC-DDraw writes to ddraw.ini section [ddraw] key windowed/border
 */
export function writeRendererWindowedMode(
  gamePath: string,
  resourcesPath: string,
  rendererKey: string,
  renderersIni: CCIniFile,
  windowed: boolean,
  borderless: boolean
): boolean {
  const sec = renderersIni.getSection(rendererKey)
  if (!sec) return false

  const windowedSection = sec.getString('WindowedModeSection')
  const windowedKey = sec.getString('WindowedModeKey')
  const borderlessKey = sec.getString('BorderlessWindowedModeKey')
  const isBorderlessReversed = sec.getBoolean('IsBorderlessWindowedModeKeyReversed', false)

  if (!windowedSection || !windowedKey) return false

  const configFileName = sec.getString('ConfigFileName')
  if (!configFileName) return false

  const configPath = path.join(gamePath, configFileName)

  // If config doesn't exist, copy from resources first
  if (!fs.existsSync(configPath)) {
    const resConfigName = sec.getString('ResConfigFileName') || configFileName
    const src = path.join(resourcesPath, resConfigName)
    copyOrLink(src, configPath, false)
  }

  const configIni = loadIniFile(configPath)
  const configSec = configIni.getOrAddSection(windowedSection)

  // Write windowed mode
  configSec.set(windowedKey, windowed ? 'true' : 'false')

  // Write borderless mode if supported
  if (borderlessKey) {
    let borderlessValue = borderless
    if (isBorderlessReversed) borderlessValue = !borderless
    configSec.set(borderlessKey, borderlessValue ? 'true' : 'false')
  }

  // Write back
  const lines: string[] = []
  for (const section of configIni.sections.values()) {
    lines.push(`[${section.name}]`)
    for (const key of section.keys_names()) {
      lines.push(`${key}=${section.getString(key)}`)
    }
    lines.push('')
  }
  fs.writeFileSync(configPath, lines.join('\r\n'), 'utf-8')

  return true
}

/**
 * Read windowed/borderless mode from renderer-specific config file.
 */
export function readRendererWindowedMode(
  gamePath: string,
  rendererKey: string,
  renderersIni: CCIniFile
): { windowed: boolean; borderless: boolean } {
  const sec = renderersIni.getSection(rendererKey)
  if (!sec) return { windowed: false, borderless: false }

  const windowedSection = sec.getString('WindowedModeSection')
  const windowedKey = sec.getString('WindowedModeKey')
  const borderlessKey = sec.getString('BorderlessWindowedModeKey')
  const isBorderlessReversed = sec.getBoolean('IsBorderlessWindowedModeKeyReversed', false)

  if (!windowedSection || !windowedKey) return { windowed: false, borderless: false }

  const configFileName = sec.getString('ConfigFileName')
  if (!configFileName) return { windowed: false, borderless: false }

  const configPath = path.join(gamePath, configFileName)
  if (!fs.existsSync(configPath)) return { windowed: false, borderless: false }

  const configIni = loadIniFile(configPath)
  const configSec = configIni.getSection(windowedSection)
  if (!configSec) return { windowed: false, borderless: false }

  const windowed = configSec.getBoolean(windowedKey, false)
  let borderless = false
  if (borderlessKey) {
    borderless = configSec.getBoolean(borderlessKey, false)
    if (isBorderlessReversed) borderless = !borderless
  }

  return { windowed, borderless }
}

/**
 * Check if a renderer uses custom windowed mode (not the standard Options.ini).
 */
export function rendererUsesCustomWindowedOption(
  rendererKey: string,
  renderersIni: CCIniFile
): boolean {
  const sec = renderersIni.getSection(rendererKey)
  if (!sec) return false
  return !!sec.getString('WindowedModeSection') && !!sec.getString('WindowedModeKey')
}

/**
 * Read resolution from a renderer's config file.
 * Uses WidthKey/HeightKey from Renderers.ini if defined, otherwise tries common key names.
 */
export function readRendererResolution(
  gamePath: string,
  rendererKey: string,
  renderersIni: CCIniFile
): { width: number; height: number } | null {
  const sec = renderersIni.getSection(rendererKey)
  if (!sec) return null

  const configFileName = sec.getString('ConfigFileName')
  if (!configFileName) return null

  const configPath = path.join(gamePath, configFileName)
  if (!fs.existsSync(configPath)) return null

  const configIni = loadIniFile(configPath)

  // Determine the section to look in — use WindowedModeSection or the first section
  let sectionName = sec.getString('WindowedModeSection')
  let configSec: IniSection | undefined
  if (sectionName) {
    configSec = configIni.getSection(sectionName)
  }
  if (!configSec) {
    // Try the first non-empty section
    for (const name of configIni.getSectionNames()) {
      configSec = configIni.getSection(name)
      if (configSec && configSec.keys_names().length > 0) break
    }
  }
  if (!configSec) return null

  // Try explicit WidthKey/HeightKey from renderer definition first
  let widthKey = sec.getString('WidthKey')
  let heightKey = sec.getString('HeightKey')

  // Fall back to common key names
  const commonPairs: Array<[string, string]> = [
    ['width', 'height'],
    ['screen-width', 'screen-height'],
    ['ScreenWidth', 'ScreenHeight'],
    ['resWidth', 'resHeight'],
    ['sWidth', 'sHeight']
  ]

  if (widthKey && heightKey) {
    commonPairs.unshift([widthKey, heightKey])
  }

  for (const [wKey, hKey] of commonPairs) {
    if (configSec.has(wKey) && configSec.has(hKey)) {
      const w = parseInt(configSec.getString(wKey), 10)
      const h = parseInt(configSec.getString(hKey), 10)
      if (w > 0 && h > 0) {
        return { width: w, height: h }
      }
    }
  }

  return null
}

/**
 * Write resolution to a renderer's config file.
 */
export function writeRendererResolution(
  gamePath: string,
  resourcesPath: string,
  rendererKey: string,
  renderersIni: CCIniFile,
  width: number,
  height: number
): boolean {
  const sec = renderersIni.getSection(rendererKey)
  if (!sec) return false

  const configFileName = sec.getString('ConfigFileName')
  if (!configFileName) return false

  const configPath = path.join(gamePath, configFileName)

  // If config doesn't exist, copy from resources first
  if (!fs.existsSync(configPath)) {
    const resConfigName = sec.getString('ResConfigFileName') || configFileName
    const src = path.join(resourcesPath, resConfigName)
    copyOrLink(src, configPath, false)
  }

  const configIni = loadIniFile(configPath)

  // Determine the section
  let sectionName = sec.getString('WindowedModeSection')
  let configSec: IniSection | undefined
  if (sectionName) {
    configSec = configIni.getOrAddSection(sectionName)
  }
  if (!configSec) {
    // Use the first section
    const names = configIni.getSectionNames()
    if (names.length > 0) {
      configSec = configIni.getOrAddSection(names[0])
    }
  }
  if (!configSec) return false

  // Determine keys to use — prefer explicit WidthKey/HeightKey, or find existing keys
  let widthKey = sec.getString('WidthKey')
  let heightKey = sec.getString('HeightKey')

  if (!widthKey || !heightKey) {
    // Try to find existing keys
    const commonPairs: Array<[string, string]> = [
      ['width', 'height'],
      ['screen-width', 'screen-height'],
      ['ScreenWidth', 'ScreenHeight'],
      ['resWidth', 'resHeight'],
      ['sWidth', 'sHeight']
    ]
    for (const [wKey, hKey] of commonPairs) {
      if (configSec.has(wKey) || configSec.has(hKey)) {
        widthKey = wKey
        heightKey = hKey
        break
      }
    }
    // Default to width/height if nothing found
    if (!widthKey) {
      widthKey = 'width'
      heightKey = 'height'
    }
  }

  configSec.set(widthKey, String(width))
  configSec.set(heightKey, String(height))

  // Write back
  const lines: string[] = []
  for (const s of configIni.sections.values()) {
    lines.push(`[${s.name}]`)
    for (const k of s.keys_names()) {
      lines.push(`${k}=${s.getString(k)}`)
    }
    lines.push('')
  }
  fs.writeFileSync(configPath, lines.join('\r\n'), 'utf-8')

  return true
}
