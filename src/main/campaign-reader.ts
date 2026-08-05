import path from 'path'
import fs from 'fs'
import { loadIniFile, IniSection } from './ini-parser'

/**
 * BattleClient.ini 战役数据。
 *
 * [Battles] 段的**键序**就是排布顺序，逐行解析：
 * - 键以 X 开头 = 分组标签引用（值是标签 section 名）
 *   - 值匹配 /^XACT/i（XACTONE…/XACTTWO…）= 一幕（act），后续分组属于这一幕
 *   - 其余（XEU1/XUS1/XCHALL 等）= 一个分组（group），归属当前幕；无幕时是独立分组
 * - 其余键 = 关卡引用（值是关卡 section 名，如 O.B-MKALL1）
 * - XNULL = 空位占位符，跳过
 *
 * 关卡归属：
 * - 在某个分组之后 → 属于该分组
 * - 在幕内但没有打开的分组 → 直接挂在幕上（missions，无子分割就不套"其他"）
 * - 幕外又没有分组 → 收进独立"其他"（极少见）
 *
 * Enabled=False 的关卡不可游玩，由 renderer 置灰显示（保留排布位置）。
 */

export interface CampaignMission {
  id: string
  description: string
  summary: string
  scenario: string
  side: number
  sideName: string
  longDescription: string
  buildOffAlly: boolean
  cd: number
  finalMovie: string
  /** BattleClient.ini 的 Enabled 字段，False 表示未开放/不可游玩 */
  enabled: boolean
}

export interface CampaignGroup {
  id: string
  label: string
  missions: CampaignMission[]
}

export interface CampaignAct {
  id: string
  label: string
  /** 幕内子分组（国家/势力），可为空 */
  groups: CampaignGroup[]
  /** 直接挂在幕下的关卡（没有子分组时），可为空 */
  missions: CampaignMission[]
}

export interface CampaignLayout {
  /** 按幕分组（每幕内含国家/势力分组或直接关卡） */
  acts: CampaignAct[]
  /** 幕外的独立分组（如挑战关卡、废弃战役） */
  standalone: CampaignGroup[]
}

/** 空布局（无 BattleClient.ini 或 [Battles] 段） */
const EMPTY_LAYOUT: CampaignLayout = { acts: [], standalone: [] }

/**
 * 幕外的独立分组（section 名），MO 惯例：挑战/废案/秘密行动等。
 * 即使出现在某幕的关卡之后，也不归入该幕。
 */
const STANDALONE_GROUP_SECS = new Set([
  'XCHALL', 'XCHALLENGE', 'XDUST', 'XFEIAN',
  'XCOVERTOPS', 'XORIGINF', 'XSURVIVAL', 'XNIGHT'
])

/**
 * [Battles] 段的值是 section 引用，值本身不会含 ';'。
 * 但 ini-parser 只剥 `; `（分号+空白）注释，`;Endless`/`;Aurora` 这类
 * 注释会残留到值上导致查不到 section，这里统一从第一个 ';' 截断。
 */
function stripInlineComment(v: string): string {
  const idx = v.indexOf(';')
  return idx >= 0 ? v.substring(0, idx).trim() : v
}

/** 清理标签文案：去掉装饰性的 "—/—— xxx —/——" 头尾 */
function cleanLabel(raw: string): string {
  return raw.replace(/^\s*—+\s*/, '').replace(/\s*—+\s*$/, '').trim()
}

function makeMission(id: string, sec: IniSection): CampaignMission {
  return {
    id,
    description: sec.getString('Description'),
    summary: sec.getString('Summary'),
    scenario: sec.getString('Scenario'),
    side: sec.getInt('Side', 0),
    sideName: sec.getString('SideName'),
    longDescription: sec.getString('LongDescription'),
    buildOffAlly: sec.getBoolean('BuildOffAlly', true),
    cd: sec.getInt('CD', 2),
    finalMovie: sec.getString('FinalMovie'),
    enabled: sec.getBoolean('Enabled', true)
  }
}

/**
 * Load campaign data from BattleClient.ini,
 * reproducing the [Battles] section order faithfully (acts → groups → missions).
 */
export function loadCampaignData(gamePath: string): CampaignLayout {
  const iniPath = path.join(gamePath, 'INI', 'BattleClient.ini')
  if (!fs.existsSync(iniPath)) return EMPTY_LAYOUT

  const ini = loadIniFile(iniPath)
  const battlesSec = ini.getSection('Battles')
  if (!battlesSec) return EMPTY_LAYOUT

  const layout: CampaignLayout = { acts: [], standalone: [] }
  let currentAct: CampaignAct | null = null
  let currentGroup: CampaignGroup | null = null
  // 幕外又没有分组的游离关卡兜底（极少数异常 ini）
  let standaloneOther: CampaignGroup | null = null

  for (const key of battlesSec.keys_names()) {
    const rawValue = battlesSec.getString(key)
    if (!rawValue) continue
    const value = stripInlineComment(rawValue)
    // XNULL 是空位占位符，跳过
    if (value.toUpperCase() === 'XNULL') continue

    if (key.startsWith('x')) {
      // 分组/幕标签引用；标签 section 不存在（占位/废弃）则跳过
      const labelSec = ini.getSection(value)
      if (!labelSec) {
        currentGroup = null
        continue
      }
      const label = cleanLabel(labelSec.getString('Description', value)) || value
      if (/^XACT/i.test(value)) {
        // 一幕开始
        currentAct = { id: value, label, groups: [], missions: [] }
        layout.acts.push(currentAct)
        currentGroup = null
      } else {
        // 分组开始（属于当前幕；无幕则独立分组）
        currentGroup = { id: value, label, missions: [] }
        if (currentAct && !STANDALONE_GROUP_SECS.has(value.toUpperCase())) {
          currentAct.groups.push(currentGroup)
        } else {
          // 独立分组（挑战关卡/废弃战役等），不进当前幕
          layout.standalone.push(currentGroup)
        }
      }
      continue
    }

    // 关卡引用
    const missionSec = ini.getSection(value)
    if (!missionSec) continue

    const mission = makeMission(value, missionSec)
    if (currentGroup) {
      currentGroup.missions.push(mission)
    } else if (currentAct) {
      // 幕下没有打开的分组：直接挂在幕上（无子分割就不套"其他"）
      currentAct.missions.push(mission)
    } else {
      // 顶层游离关卡
      if (!standaloneOther) {
        standaloneOther = { id: 'other', label: '其他', missions: [] }
        layout.standalone.push(standaloneOther)
      }
      standaloneOther.missions.push(mission)
    }
  }

  return layout
}
