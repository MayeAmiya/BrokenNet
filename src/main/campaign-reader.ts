import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile } from './ini-parser'

export interface CampaignAct {
  id: string
  label: string
}

export interface CampaignMission {
  id: string
  actLabelId: string
  missionIndex: number
  description: string
  summary: string
  scenario: string
  side: number
  sideName: string
  act: number
  longDescription: string
  buildOffAlly: boolean
  cd: number
  finalMovie: string
}

export interface CampaignBranch {
  name: string
  label: string
  acts: CampaignAct[]
  missions: CampaignMission[]
}

/**
 * Load campaign data from BattleClient.ini.
 * This file defines all campaign missions organized by faction and act.
 */
export function loadCampaignData(gamePath: string): CampaignBranch[] {
  const iniPath = path.join(gamePath, 'INI', 'BattleClient.ini')
  if (!fs.existsSync(iniPath)) return []

  const ini = loadIniFile(iniPath)
  const branches: CampaignBranch[] = []

  // Parse the [Battles] section to get mission ordering
  const battlesSec = ini.getSection('Battles')
  if (!battlesSec) return []

  // Group missions by faction based on label section names
  const factionMap: Record<string, { acts: Map<string, CampaignAct>; missions: CampaignMission[] }> = {}

  // Known faction prefixes from label sections
  const factionPrefixes: Record<string, string> = {
    'XACTONEALL': 'allies',
    'XACTTWOALL': 'allies',
    'XACTONESOV': 'soviets',
    'XACTTWOSOV': 'soviets',
    'XACTONEYUR': 'epsilon',
    'XACTTWOYUR': 'epsilon',
    'XORIGINF': 'foehn',
    'XCOVERTOPS': 'special'
  }

  // First pass: identify acts and their factions
  // key 是 xa1/xa2/xs1 等（ini-parser 已小写化），值是 act 标签 section 名（XACTONEALL...），
  // factionPrefixes 的键是【值】，不是 key；section 名匹配时用原大小写
  const actKeys = new Set<string>()
  for (const key of battlesSec.keys_names()) {
    const value = battlesSec.getString(key)
    if (key.startsWith('x')) {
      actKeys.add(key)
      const faction = factionPrefixes[value]
      if (faction) {
        if (!factionMap[faction]) {
          factionMap[faction] = { acts: new Map(), missions: [] }
        }
        const labelSec = ini.getSection(value)
        if (labelSec) {
          factionMap[faction].acts.set(key, {
            id: key,
            label: labelSec.getString('Description', value)
          })
        }
      }
    }
  }

  // Second pass: parse mission sections
  for (const key of battlesSec.keys_names()) {
    const value = battlesSec.getString(key)
    if (actKeys.has(key)) continue // Skip act label references

    const missionSec = ini.getSection(value)
    if (!missionSec) continue

    const sideName = missionSec.getString('SideName', '').toLowerCase()
    // 合作/特殊行动任务（co1-co19 / c10-c19 等 key）归特殊行动分支，不按势力分
    const isCoop = /^co\d+$/i.test(key) || /^c\d+$/i.test(key)
    const faction = isCoop
      ? 'special'
      : sideName === 'allies' ? 'allies'
      : sideName === 'soviets' ? 'soviets'
      : sideName === 'epsilon' ? 'epsilon'
      : sideName === 'foehn' ? 'foehn'
      : 'special'

    if (!factionMap[faction]) {
      factionMap[faction] = { acts: new Map(), missions: [] }
    }

    factionMap[faction].missions.push({
      id: value,
      actLabelId: '',
      missionIndex: parseInt(key, 10) || 0,
      description: missionSec.getString('Description'),
      summary: missionSec.getString('Summary'),
      scenario: missionSec.getString('Scenario'),
      side: missionSec.getInt('Side', 0),
      sideName: missionSec.getString('SideName'),
      act: missionSec.getInt('Act', 1),
      longDescription: missionSec.getString('LongDescription'),
      buildOffAlly: missionSec.getBoolean('BuildOffAlly', true),
      cd: missionSec.getInt('CD', 2),
      finalMovie: missionSec.getString('FinalMovie')
    })
  }

  // Build branch structures
  const branchNames: Record<string, string> = {
    allies: '同盟国联军',
    soviets: '苏维埃联盟',
    epsilon: '厄普西隆军',
    foehn: '焚风反抗军',
    special: '特殊行动'
  }

  for (const [faction, data] of Object.entries(factionMap)) {
    const acts = Array.from(data.acts.values())
    branches.push({
      name: faction,
      label: branchNames[faction] ?? faction,
      acts,
      missions: data.missions.sort((a, b) => a.missionIndex - b.missionIndex)
    })
  }

  return branches
}
