import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile, IniSection } from './ini-parser'
import type { IniControlDef, IniControlType, IniPosition, IniSize } from '../shared/types/ini-layout'

function parseLocation(value: string): IniPosition {
  if (!value) return { x: 0, y: 0 }
  const parts = value.split(',').map(s => parseInt(s.trim(), 10))
  return { x: parts[0] || 0, y: parts[1] || 0 }
}

function parseSize(value: string): IniSize {
  if (!value) return { width: 0, height: 0 }
  const parts = value.split(',').map(s => parseInt(s.trim(), 10))
  return { width: parts[0] || 0, height: parts[1] || 0 }
}

function mapControlType(typeStr: string): IniControlType {
  const lower = typeStr.toLowerCase()
  if (lower.includes('button') || lower.includes('linkbutton')) return 'button'
  if (lower.includes('checkbox')) return 'checkbox'
  if (lower.includes('dropdown') || lower.includes('combobox')) return 'dropdown'
  if (lower.includes('label') || lower.includes('linklabel')) return 'label'
  if (lower.includes('textbox') || lower.includes('chattextbox')) return 'textbox'
  if (lower.includes('listbox') || lower.includes('multicolumnlistbox') || lower.includes('chatlistbox')) return 'listbox'
  if (lower.includes('trackbar') || lower.includes('slider')) return 'trackbar'
  if (lower.includes('extrapanel')) return 'extrapanel'
  if (lower.includes('panel')) return 'panel'
  return 'panel'
}

function buildControlFromSection(
  ini: CCIniFile,
  sectionName: string,
  section: IniSection
): IniControlDef {
  const controlName = section.name || sectionName
  const typeGuess = sectionName.toLowerCase().includes('btn')
    ? 'button'
    : sectionName.toLowerCase().includes('lbl')
      ? 'label'
      : sectionName.toLowerCase().includes('chk')
        ? 'checkbox'
        : sectionName.toLowerCase().includes('cmb') || sectionName.toLowerCase().includes('dd')
          ? 'dropdown'
          : sectionName.toLowerCase().includes('tb')
            ? 'textbox'
            : sectionName.toLowerCase().includes('lb')
              ? 'listbox'
              : sectionName.toLowerCase().includes('trb')
                ? 'trackbar'
                : 'panel'

  const extra: Record<string, string> = {}
  for (const key of section.keys_names()) {
    const lower = key.toLowerCase()
    if (![
      'location', 'size', 'visible', 'enabled', 'text', 'tooltip',
      'backgroundtexture', 'drawmode', 'distancefromrightborder',
      'distancefrombottomborder', 'fillwidth', 'fillheight',
      'remapcolor', 'idlecolor', 'hovercolor', 'font', 'url'
    ].includes(lower)) {
      extra[key] = section.getString(key)
    }
  }

  return {
    name: controlName,
    type: typeGuess,
    location: parseLocation(section.getString('Location')),
    size: parseSize(section.getString('Size')),
    visible: section.has('Visible') ? section.getBoolean('Visible', true) : undefined,
    enabled: section.has('Enabled') ? section.getBoolean('Enabled', true) : undefined,
    text: section.getString('Text') || undefined,
    toolTip: section.getString('ToolTip') || undefined,
    url: section.getString('URL') || undefined,
    backgroundTexture: section.getString('BackgroundTexture') || undefined,
    drawMode: (section.getString('DrawMode').toLowerCase() as any) || undefined,
    distanceFromRightBorder: section.has('DistanceFromRightBorder')
      ? section.getInt('DistanceFromRightBorder')
      : undefined,
    distanceFromBottomBorder: section.has('DistanceFromBottomBorder')
      ? section.getInt('DistanceFromBottomBorder')
      : undefined,
    fillWidth: section.has('FillWidth') ? section.getInt('FillWidth') : undefined,
    fillHeight: section.has('FillHeight') ? section.getInt('FillHeight') : undefined,
    remapColor: section.getString('RemapColor') || undefined,
    font: section.getString('Font') || undefined,
    children: [],
    extra: Object.keys(extra).length > 0 ? extra : undefined
  }
}

function parseExtraControls(ini: CCIniFile, windowSection: string): IniControlDef[] {
  const controls: IniControlDef[] = []

  // Try both [ExtraControls] and [$ExtraControls]
  for (const listKey of ['ExtraControls', '$ExtraControls']) {
    const listSec = ini.getSection(listKey)
    if (!listSec) continue

    for (const key of listSec.keys_names()) {
      const value = listSec.getString(key)
      // Format: "ControlName:ControlType" or "ControlName:ControlType"
      const colonIdx = value.lastIndexOf(':')
      if (colonIdx < 0) continue

      const controlName = value.substring(0, colonIdx).trim()
      // const controlType = value.substring(colonIdx + 1).trim()

      const controlSec = ini.getSection(controlName)
      if (controlSec) {
        const ctrl = buildControlFromSection(ini, controlName, controlSec)
        controls.push(ctrl)
      }
    }
  }

  return controls
}

/**
 * Parse a window INI file (e.g., SkirmishLobby.ini, MultiplayerGameLobby.ini)
 * into a structured layout definition.
 */
export function parseWindowLayout(
  iniPath: string,
  windowName?: string
): { size?: IniSize; controls: IniControlDef[] } {
  if (!fs.existsSync(iniPath)) {
    return { controls: [] }
  }

  const ini = loadIniFile(iniPath)
  return parseWindowLayoutFromIni(ini, windowName)
}

export function parseWindowLayoutFromIni(
  ini: CCIniFile,
  windowName?: string
): { size?: IniSize; controls: IniControlDef[] } {
  // Find the main window section
  // 注意：getSectionNames() 返回全小写段名（ini-parser 按小写存储），
  // 这里必须用小写字符串比较，否则 'INISystem'/'Background' 等永远排除不掉。
  const sectionNames = ini.getSectionNames()
  const mainSectionName = windowName
    ?? sectionNames.find(n =>
      !n.startsWith('$') &&
      n !== 'inisystem' &&
      n !== 'extracontrols' &&
      n !== '$extracontrols' &&
      !n.startsWith('rab') &&
      !n.startsWith('ract') &&
      !n.startsWith('racb') &&
      !n.startsWith('winbar') &&
      !n.startsWith('bar_') &&
      n !== 'background'
    )
    ?? sectionNames[0]

  const mainSection = mainSectionName ? ini.getSection(mainSectionName) : undefined
  const windowSize = mainSection?.has('Size')
    ? parseSize(mainSection.getString('Size'))
    : undefined

  // Parse ExtraControls
  const extraControls = parseExtraControls(ini, mainSectionName ?? '')

  // Parse known child controls (any section that has Location or Size and isn't a known meta-section)
  // 段名统一小写（getSectionNames() 返回小写）
  const metaSections = new Set([
    'inisystem', 'extracontrols', '$extracontrols', 'background',
    ...(mainSectionName ? [mainSectionName] : [])
  ])

  const childControls: IniControlDef[] = []
  for (const name of sectionNames) {
    if (metaSections.has(name)) continue
    if (name.startsWith('rab') || name.startsWith('ract') || name.startsWith('racb')) continue
    if (name.startsWith('winbar_') || name.startsWith('bar_')) continue

    const sec = ini.getSection(name)
    if (!sec) continue

    // Only include sections that look like UI controls
    if (sec.has('Location') || sec.has('Size') || sec.has('Text') || sec.has('BackgroundTexture')) {
      const ctrl = buildControlFromSection(ini, name, sec)
      childControls.push(ctrl)
    }
  }

  return {
    size: windowSize,
    controls: [...extraControls, ...childControls]
  }
}

/**
 * Load and parse a window layout with BasedOn chain.
 * E.g., MultiplayerGameLobby.ini -> GameLobbyBase.ini -> GenericWindow.ini
 */
export function loadWindowLayout(
  gamePath: string,
  windowIniName: string,
  windowName?: string
): { size?: IniSize; controls: IniControlDef[] } {
  const iniPath = path.join(gamePath, 'Resources', windowIniName)
  return parseWindowLayout(iniPath, windowName)
}
