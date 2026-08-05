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

  // 用原始大小写段名（TypeSelect/CombatantSelect...）—— 游戏匹配 KeyboardMD 里的命令名是区分大小写的，
  // 小写会读不到导致重置
  for (const sectionName of ini.getSectionNames_original()) {
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
 *
 * 游戏直接读 KeyboardMD.ini 作为键位表（全量，含默认键）。
 * 传入 settingsDir 时优先读它（全局设置存储，playground 会硬链接进去），
 * 与 writeKeyMappings 的写入目标保持一致；否则回退游戏目录。
 */
export function loadKeyMappings(gamePath: string, settingsDir?: string): Record<string, string> {
  const iniPath = settingsDir
    ? path.join(settingsDir, 'KeyboardMD.ini')
    : path.join(gamePath, 'KeyboardMD.ini')
  if (!fs.existsSync(iniPath)) {
    // 全局设置目录没有覆盖项时，回退看游戏目录（首装/未自定义过）
    if (settingsDir) return loadKeyMappings(gamePath)
    return {}
  }

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
 * 读取游戏本体 KeyboardMD（gamePath 下）的 [Hotkey] 条目，保留键名原始大小写。
 * 这是游戏能读的那份，命令名（FPSCounter 而非 "FPS Counter"）和值都以它为准。
 */
function loadBaseKeyMappings(gamePath: string): Record<string, string> {
  const iniPath = path.join(gamePath, 'KeyboardMD.ini')
  if (!fs.existsSync(iniPath)) return {}
  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('Hotkey')
  if (!sec) return {}
  const out: Record<string, string> = {}
  for (const k of sec.keys_names_original()) {
    out[k] = sec.getString(k)
  }
  return out
}

/**
 * Get keyboard bindings with current mappings applied.
 * 命令名/默认值以游戏本体 KeyboardMD（能读的那份）为准；KeyboardCommands.ini 只当显示参考。
 * settings 用户覆盖优先，但若 settings 值等于 KeyboardCommands 默认（旧播种残留）则用本体值。
 */
export function getKeyboardBindingsWithMappings(gamePath: string, settingsDir?: string): KeyboardBinding[] {
  // 游戏本体 KeyboardMD：命令名 + 游戏实际用的值（原始大小写）
  const base = loadBaseKeyMappings(gamePath)
  // KeyboardCommands.ini：定义（UIName/分类/默认键）做显示参考
  const defs = loadKeyboardBindings(gamePath)
  const byLower = new Map<string, KeyboardBinding>()
  for (const def of defs) byLower.set(def.command.toLowerCase(), def)
  // settings：用户覆盖
  const overrides = loadKeyMappings(gamePath, settingsDir)

  // 只以游戏本体 KeyboardMD 的命令为准（不补 KeyboardCommands 里的），settings 覆盖优先。
  // defaultKey 取 KeyboardCommands 的默认键：「恢复默认」时读它按正确格式重排写入。
  return Object.entries(base).map(([name, key]) => {
    const lower = name.toLowerCase()
    const def = byLower.get(lower)
    return {
      command: name,
      uiName: def?.uiName ?? name,
      category: def?.category ?? '',
      description: def?.description ?? '',
      defaultKey: def?.defaultKey ?? key,
      currentKey: overrides[lower] ?? key
    }
  })
}

/**
 * 确保 KeyboardMD.ini 全量：稀疏/缺失时按完整命令定义播种（保留已有键值）。
 * 游戏直接读 KeyboardMD.ini 作为键位表，必须保持完整。每次构建 playground 时调用。
 */
export function ensureFullKeyboardMap(gamePath: string, settingsDir?: string): void {
  if (!settingsDir) return
  const bindings = getKeyboardBindingsWithMappings(gamePath, settingsDir)
  if (bindings.length === 0) return // 无 KeyboardCommands.ini（非 MO）不处理
  const existing = loadKeyMappings(gamePath, settingsDir)
  if (Object.keys(existing).length < bindings.length) {
    writeKeyMappings(gamePath, bindings, settingsDir)
  }
}

/**
 * Write key mappings to KeyboardMD.ini.
 *
 * 全量同步：把传入的全部绑定写进 [Hotkey] 段（含默认键），
 * 游戏以 KeyboardMD.ini 为准读取完整键位表。
 */
export function writeKeyMappings(
  gamePath: string,
  bindings: Array<{ command: string; currentKey: string; defaultKey: string }>,
  settingsDir?: string
): void {
  // 全局设置：写入 settings/（playground 硬链接，游戏读到）；未给则写安装目录
  const iniPath = path.join(settingsDir || gamePath, 'KeyboardMD.ini')
  if (settingsDir) fs.mkdirSync(path.dirname(iniPath), { recursive: true })
  const ini = fs.existsSync(iniPath) ? loadIniFile(iniPath) : new CCIniFile()

  // 重建 Hotkey 段（全量：每个命令都写当前键，丢弃旧残留）。
  // 游戏读 KeyboardMD 是区分大小写、按 VK 码顺序读的：键名必须保留原始大小写（TypeSelect...），
  // 条目必须按 VK 码升序（Options=27 → TeamSelect_1=49 → ...），否则游戏读不到会重置。
  const hotkey = new IniSection('Hotkey')
  const sorted = [...bindings]
    .filter((b) => b.currentKey)
    .sort((a, b) => (parseInt(a.currentKey, 10) || 0) - (parseInt(b.currentKey, 10) || 0))
  for (const b of sorted) {
    hotkey.set(b.command, b.currentKey)
  }
  ini.sections.set('hotkey', hotkey)

  const lines: string[] = []
  for (const section of ini.sections.values()) {
    lines.push(`[${section.name}]`)
    // keys_names_original 保留键名原始大小写（IniSection.set 已记录），游戏才能匹配到命令
    for (const k of section.keys_names_original()) {
      lines.push(`${k}=${section.getString(k)}`)
    }
    lines.push('')
  }
  fs.writeFileSync(iniPath, lines.join('\r\n'), 'utf-8')
}
