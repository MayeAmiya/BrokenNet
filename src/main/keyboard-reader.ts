import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile, IniSection } from './ini-parser'

export interface KeyboardBinding {
  command: string
  uiName: string
  category: string
  description: string
  defaultKey: string
  currentKey: string
}

/**
 * Load keyboard bindings from KeyboardCommands.ini.
 */
export function loadKeyboardBindings(gamePath: string): KeyboardBinding[] {
  const iniPath = path.join(gamePath, 'Resources', 'KeyboardCommands.ini')
  if (!fs.existsSync(iniPath)) return []

  const ini = loadIniFile(iniPath)
  const bindings: KeyboardBinding[] = []

  for (const sectionName of ini.getSectionNames()) {
    const sec = ini.getSection(sectionName)
    if (!sec) continue

    bindings.push({
      command: sectionName,
      uiName: sec.getString('UIName', sectionName),
      category: sec.getString('Category'),
      description: sec.getString('Description'),
      defaultKey: sec.getString('DefaultKey'),
      currentKey: sec.getString('DefaultKey') // Initially same as default
    })
  }

  return bindings
}

/**
 * Load current key mappings from KeyboardMD.ini.
 */
export function loadKeyMappings(gamePath: string): Record<string, string> {
  const iniPath = path.join(gamePath, 'KeyboardMD.ini')
  if (!fs.existsSync(iniPath)) return {}

  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('Hotkey')
  if (!sec) return {}

  const mappings: Record<string, string> = {}
  for (const key of sec.keys_names()) {
    mappings[key] = sec.getString(key)
  }
  return mappings
}

/**
 * Get keyboard bindings with current mappings applied.
 */
export function getKeyboardBindingsWithMappings(gamePath: string): KeyboardBinding[] {
  const bindings = loadKeyboardBindings(gamePath)
  const mappings = loadKeyMappings(gamePath)

  for (const binding of bindings) {
    if (mappings[binding.command]) {
      binding.currentKey = mappings[binding.command]
    }
  }

  return bindings
}

/**
 * Write key mappings to KeyboardMD.ini.
 *
 * 整段同步：传入全部绑定，只把「与默认不同」的条目写进 [Hotkey] 段。
 * 改回默认的绑定会被移出文件（旧覆盖不会残留），其余 section 保留。
 */
export function writeKeyMappings(
  gamePath: string,
  bindings: Array<{ command: string; currentKey: string; defaultKey: string }>
): void {
  const iniPath = path.join(gamePath, 'KeyboardMD.ini')
  const ini = fs.existsSync(iniPath) ? loadIniFile(iniPath) : new CCIniFile()

  // 重建 Hotkey 段（只保留覆盖项，丢弃旧残留）
  const hotkey = new IniSection('Hotkey')
  for (const b of bindings) {
    if (b.currentKey && b.currentKey !== b.defaultKey) {
      hotkey.set(b.command, b.currentKey)
    }
  }
  ini.sections.set('hotkey', hotkey)

  const lines: string[] = []
  for (const section of ini.sections.values()) {
    lines.push(`[${section.name}]`)
    for (const k of section.keys_names()) {
      lines.push(`${k}=${section.getString(k)}`)
    }
    lines.push('')
  }
  fs.writeFileSync(iniPath, lines.join('\r\n'), 'utf-8')
}
