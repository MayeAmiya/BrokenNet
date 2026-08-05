/**
 * 读取 Mental Omega GameOptions.ini 中多人游戏大厅的选项定义。
 * 解析 [MultiplayerGameLobby] section 里的 CheckBoxes / DropDowns 列表，
 * 然后逐个读取每个控件的 section（如 [cmbCredits]、[chkShortGame]），
 * 返回结构化的选项数据供前端动态渲染。
 */

import fs from 'fs'
import path from 'path'
import { loadIniFile, type CCIniFile } from './ini-parser'

export interface MPOptionDropDown {
  /** 控件名 e.g. "cmbCredits" */
  name: string
  /** 显示名 e.g. "初始资金" — 从对应 lbl section 的 Text 读取 */
  label: string
  /** INI section 定义的 OptionName */
  optionName: string
  /** 下拉项的值列表 e.g. ["50000","40000",...] */
  items: string[]
  /** 下拉项的显示文本 e.g. ["50000","40000",...] 或 ["标准","双倍",...] */
  itemLabels: string[]
  /** 默认选中索引 */
  defaultIndex: number
  /** 写入 spawn.ini 的 key */
  spawnIniOption: string
  /** 写入模式: "String"=直接写值, "Index"=写下标, "Boolean"=布尔, "MapCode"=不写ini而是应用地图代码 */
  dataWriteMode: string
  /** 工具提示 */
  toolTip: string
}

export interface MPOptionCheckBox {
  /** 控件名 e.g. "chkShortGame" */
  name: string
  /** 显示名 e.g. "快速游戏" — 从 INI 的 Text 读取 */
  text: string
  /** INI section 定义的 OptionName */
  optionName: string
  /** 默认勾选状态 */
  checked: boolean
  /** 写入 spawn.ini 的 key */
  spawnIniOption: string
  /** 关联的 MapCode INI 文件路径（可选） */
  customIniPath?: string
  /** 反选：勾选时写 DisabledSpawnIniValue（对齐 xna Reversed） */
  reversed: boolean
  /** 勾选（反选框为未勾选）时连带禁用的阵营索引（对齐 xna GameLobbyCheckBox.DisallowedSideIndices） */
  disallowedSideIndices: number[]
  /** 勾选时写入 spawn.ini 的值（默认 "True"） */
  enabledSpawnIniValue: string
  /** 未勾选时写入 spawn.ini 的值（默认 "False"） */
  disabledSpawnIniValue: string
  /** 工具提示 */
  toolTip: string
  /** 是否可见（默认 true） */
  visible: boolean
}

export interface MultiplayerLobbyOptions {
  sides: Array<{ name: string; icon: string }>
  mpColors: Array<{ name: string; r: number; g: number; b: number; hex: string; gameColorIndex: number }>
  dropdowns: MPOptionDropDown[]
  checkboxes: MPOptionCheckBox[]
  randomSelectors: Record<string, number[]>
  randomSelectorCount: number
  factionCount: number
  /** GameOptions.ini [ForcedSpawnIniOptions]：始终写入 spawn.ini [Settings] */
  forcedSpawnIniOptions: Record<string, string>
}

function parseDropDown(ini: CCIniFile, name: string): MPOptionDropDown | null {
  const sec = ini.getSection(name)
  if (!sec) return null

  const items = sec.getStringList('Items')
  const itemLabels = sec.has('ItemLabels') ? sec.getStringList('ItemLabels') : items

  // 读取 label: 找对应的 lbl section
  const lblName = name.replace(/^cmb/, 'lbl')
  const lblSec = ini.getSection(lblName)
  const label = lblSec?.getString('Text') ?? sec.getString('OptionName')

  return {
    name,
    label,
    optionName: sec.getString('OptionName'),
    items,
    itemLabels,
    defaultIndex: sec.getInt('DefaultIndex', 0),
    spawnIniOption: sec.getString('SpawnIniOption'),
    dataWriteMode: sec.getString('DataWriteMode', 'String'),
    toolTip: sec.getString('ToolTip')
  }
}

function parseCheckBox(ini: CCIniFile, name: string): MPOptionCheckBox | null {
  const sec = ini.getSection(name)
  if (!sec) return null

  return {
    name,
    text: sec.getString('Text') || sec.getString('OptionName'),
    optionName: sec.getString('OptionName'),
    checked: sec.getBoolean('Checked', false),
    spawnIniOption: sec.getString('SpawnIniOption'),
    customIniPath: sec.getString('CustomIniPath') || undefined,
    // 对齐 xna GameSessionCheckBox：Reversed 勾选时写 disabled 值；enabled/disabled 默认 True/False
    reversed: sec.getBoolean('Reversed', false),
    // 对齐 xna GameLobbyCheckBox.ParseControlINIAttribute：DisallowedSideIndex / DisallowedSideIndices
    // 是空格分隔的阵营索引，勾选（反选框为未勾选）时把这些阵营从随机池禁用
    disallowedSideIndices: (sec.getString('DisallowedSideIndex') || sec.getString('DisallowedSideIndices') || '')
      .trim().split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n)),
    enabledSpawnIniValue: sec.getString('EnabledSpawnIniValue') || 'True',
    disabledSpawnIniValue: sec.getString('DisabledSpawnIniValue') || 'False',
    toolTip: sec.getString('ToolTip'),
    visible: sec.getInt('Visible', 1) !== 0
  }
}

/**
 * 读取多人游戏大厅选项。
 * @param gamePath 游戏根目录 e.g. "E:\Mental Omega"
 */
export function readMultiplayerLobbyOptions(gamePath: string): MultiplayerLobbyOptions {
  const iniPath = path.join(gamePath, 'Resources', 'GameOptions.ini')
  const ini = loadIniFile(iniPath)

  // 真实阵营列表 + 图标（读取为 base64 data URL）
  const generalSec = ini.getSection('General')
  const rawSides = generalSec?.getStringList('Sides', []) ?? []

  // 阵营/选择器图标映射：优先读游戏 GameOptions.ini [FactionIcons]（数据驱动），否则回退内置表
  const sideIconMap: Record<string, string> = {
    '任一盟军': 'Any Alliesicon.png',
    '任一苏联': 'Any Sovietsicon.png',
    '任一厄普西隆': 'Any Epsilonicon.png',
    '任一焚风': 'Any Foehnicon.png',
    '美国': 'United Statesicon.png',
    '欧洲联盟': 'Euro Allianceicon.png',
    '太平洋阵线': 'Pacific Fronticon.png',
    '苏俄': 'Russiaicon.png',
    '拉丁同盟': 'Confederationicon.png',
    '中国': 'Chinaicon.png',
    '心灵军团': 'PsiCorpsicon.png',
    '天蝎组织': 'Scorpion Cellicon.png',
    '总部守卫': 'Epsilon HQicon.png',
    '狂鲨先锋': 'Haiheadicon.png',
    '科洛尼亚侧翼': 'Coroniaicon.png',
    '最后堡垒': 'Last Bastionicon.png'
  }
  const iconSec = ini.getSection('FactionIcons')
  if (iconSec) {
    for (const k of iconSec.keys_names()) {
      const v = iconSec.getString(k)
      if (v) sideIconMap[k] = v
    }
  }
  const resourcesPath = path.join(gamePath, 'Resources')

  function readIconAsDataUrl(filename: string): string {
    try {
      const buf = fs.readFileSync(path.join(resourcesPath, filename))
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch { return '' }
  }

  // [RandomSelectors] 子阵营随机选择器（任一盟军/任一苏军等）——参考客户端把它们排在阵营前面，
  // 缺了它们阵营索引会整体偏移，OR/PO 与真实 MO 客户端对不上
  const randomSelectorsSec = ini.getSection('RandomSelectors')
  const randomSelectorNames: string[] = []
  const randomSelectors: Record<string, number[]> = {}
  if (randomSelectorsSec) {
    // 参考只收录值含 >1 个阵营的选择器（对齐 GetRandomSelectors）
    for (const key of randomSelectorsSec.keys_names()) {
      const val = randomSelectorsSec.getString(key) ?? ''
      const n = val.split(',').map(s => parseInt(s.trim(), 10)).filter(x => !isNaN(x))
      if (n.length > 1) {
        randomSelectorNames.push(key)
        randomSelectors[key] = n
      }
    }
  }
  const randomSelectorCount = 1 + randomSelectorNames.length
  const factionCount = rawSides.length

  // 参考阵营下拉顺序：Random → 子阵营随机 → 阵营 → 观察者
  const sides: Array<{ name: string; icon: string }> = [
    { name: 'Random', icon: readIconAsDataUrl('randomicon.png') },
    ...randomSelectorNames.map(s => ({ name: s, icon: readIconAsDataUrl(sideIconMap[s] ?? 'randomicon.png') })),
    ...rawSides.map(s => ({
      name: s,
      icon: readIconAsDataUrl(sideIconMap[s] ?? 'randomicon.png')
    })),
    { name: '观察者', icon: readIconAsDataUrl('randomicon.png') }
  ]

  // 真实 MP 颜色（条目格式 R,G,B,GameColorIndex——GameColorIndex 是游戏内颜色索引，spawn.ini 写它，对齐参考 MultiplayerColor）
  const mpColorsSec = ini.getSection('MPColors')
  const mpColors: Array<{ name: string; r: number; g: number; b: number; hex: string; gameColorIndex: number }> = [{ name: 'Random', r: -1, g: -1, b: -1, hex: '', gameColorIndex: 0 }]
  if (mpColorsSec) {
    let seq = 0
    for (const key of mpColorsSec.keys_names()) {
      const parts = mpColorsSec.getString(key).split(',').map(s => parseInt(s.trim(), 10))
      if (parts.length >= 3) {
        seq++
        const hex = '#' + [parts[0], parts[1], parts[2]].map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase()
        // 第 4 字段缺失时按 UI 顺序兜底（对齐参考默认 GameColorIndex = 顺序）
        mpColors.push({ name: key, r: parts[0], g: parts[1], b: parts[2], hex, gameColorIndex: parts.length >= 4 ? parts[3] : seq - 1 })
      }
    }
  }

  // GameOptions.ini [ForcedSpawnIniOptions]：始终写入 spawn.ini [Settings]（如 FogOfWar=No、MultiEngineer=Yes）
  const forcedSpawnIniOptions: Record<string, string> = {}
  const forcedSec = ini.getSection('ForcedSpawnIniOptions')
  if (forcedSec) {
    for (const k of forcedSec.keys_names_original()) {
      forcedSpawnIniOptions[k] = forcedSec.getString(k)
    }
  }

  const lobbySection = ini.getSection('MultiplayerGameLobby')
  if (!lobbySection) {
    return { sides, mpColors, dropdowns: [], checkboxes: [], randomSelectors, randomSelectorCount, factionCount, forcedSpawnIniOptions }
  }

  const dropDownNames = lobbySection.getStringList('DropDowns')
  const checkBoxNames = lobbySection.getStringList('CheckBoxes')

  const dropdowns: MPOptionDropDown[] = []
  for (const name of dropDownNames) {
    const dd = parseDropDown(ini, name)
    if (dd) dropdowns.push(dd)
  }

  const checkboxes: MPOptionCheckBox[] = []
  for (const name of checkBoxNames) {
    const cb = parseCheckBox(ini, name)
    if (cb) checkboxes.push(cb)
  }

  return { sides, mpColors, dropdowns, checkboxes, randomSelectors, randomSelectorCount, factionCount, forcedSpawnIniOptions }
}

// ─── 旧接口：给 game-options:load IPC 用 ──────────────

export function readGameOptions(gamePath: string) {
  const iniPath = path.join(gamePath, 'Resources', 'GameOptions.ini')
  const ini = loadIniFile(iniPath)

  // General section
  const generalSec = ini.getSection('General')
  const sides = generalSec?.getStringList('Sides', []) ?? []

  // MPColors
  const mpColorsSec = ini.getSection('MPColors')
  const mpColors: Array<{ name: string; r: number; g: number; b: number; uiColorId: number }> = []
  if (mpColorsSec) {
    for (const key of mpColorsSec.keys_names()) {
      const parts = mpColorsSec.getString(key).split(',').map(s => parseInt(s.trim(), 10))
      if (parts.length >= 4) {
        mpColors.push({ name: key, r: parts[0], g: parts[1], b: parts[2], uiColorId: parts[3] })
      }
    }
  }

  // ForcedSpawnIniOptions
  const forcedSec = ini.getSection('ForcedSpawnIniOptions')
  const forcedSpawnIniOptions: Record<string, string> = {}
  if (forcedSec) {
    for (const k of forcedSec.keys_names_original()) {
      forcedSpawnIniOptions[k] = forcedSec.getString(k)
    }
  }

  // MultiplayerGameLobby
  const mpLobby = readLobbySection(ini, 'MultiplayerGameLobby')

  // SkirmishLobby
  const skLobby = readLobbySection(ini, 'SkirmishLobby')

  return { sides, mpColors, forcedSpawnIniOptions, multiplayerLobby: mpLobby, skirmishLobby: skLobby }
}

function readLobbySection(ini: CCIniFile, sectionName: string) {
  const sec = ini.getSection(sectionName)
  if (!sec) return { checkBoxes: [], dropDowns: [], labels: [], sharpenImages: false, defaultWindowSize: '' }

  const cbNames = sec.getStringList('CheckBoxes')
  const ddNames = sec.getStringList('DropDowns')
  const lblNames = sec.getStringList('Labels')

  const checkBoxes = cbNames.map(name => {
    const s = ini.getSection(name)
    if (!s) return null
    return {
      controlName: name,
      optionName: s.getString('OptionName'),
      text: s.getString('Text') || s.getString('OptionName'),
      spawnIniOption: s.getString('SpawnIniOption'),
      checked: s.getBoolean('Checked', false),
      location: parseLocation(s.getString('Location')),
      toolTip: s.getString('ToolTip'),
      customIniPath: s.getString('CustomIniPath') || undefined
    }
  }).filter(Boolean)

  const dropDowns = ddNames.map(name => {
    const s = ini.getSection(name)
    if (!s) return null
    return {
      controlName: name,
      optionName: s.getString('OptionName'),
      items: s.getStringList('Items'),
      itemLabels: s.has('ItemLabels') ? s.getStringList('ItemLabels') : undefined,
      defaultIndex: s.getInt('DefaultIndex', 0),
      spawnIniOption: s.getString('SpawnIniOption'),
      dataWriteMode: s.getString('DataWriteMode', 'String'),
      location: parseLocation(s.getString('Location')),
      size: parseSize(s.getString('Size')),
      toolTip: s.getString('ToolTip')
    }
  }).filter(Boolean)

  const labels = lblNames.map(name => {
    const s = ini.getSection(name)
    if (!s) return null
    return {
      controlName: name,
      text: s.getString('Text'),
      location: parseLocation(s.getString('Location'))
    }
  }).filter(Boolean)

  return {
    checkBoxes,
    dropDowns,
    labels,
    sharpenImages: sec.getString('SharpenImages').toLowerCase() === 'yes',
    defaultWindowSize: sec.getString('DefaultWindowSize')
  }
}

function parseLocation(val: string): { x: number; y: number } {
  const parts = val.split(',').map(s => parseInt(s.trim(), 10))
  return { x: parts[0] || 0, y: parts[1] || 0 }
}

function parseSize(val: string): { width: number; height: number } {
  const parts = val.split(',').map(s => parseInt(s.trim(), 10))
  return { width: parts[0] || 0, height: parts[1] || 0 }
}
