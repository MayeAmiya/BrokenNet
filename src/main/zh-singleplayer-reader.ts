import { readGeneralsVfsFile } from './big-reader'

export type ZhMission = { id: string; map: string; nextMission: string; location: string; generalName: string }
export type ZhCampaign = { id: string; label: string; firstMission: string; playerFaction: string; challenge: boolean; missions: ZhMission[] }
export type ZhGeneral = { index: number; enabled: boolean; name: string; rank: string; branch: string; strategy: string; campaign: string; playerTemplate: string }

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/;.*$/, '').trim()).filter(Boolean)
}

function field(line: string): [string, string] {
  const equal = line.indexOf('=')
  if (equal >= 0) return [line.slice(0, equal).trim(), line.slice(equal + 1).trim()]
  const split = line.search(/\s+/)
  return split < 0 ? [line, ''] : [line.slice(0, split), line.slice(split).trim()]
}

function parseCampaigns(text: string): ZhCampaign[] {
  const result: ZhCampaign[] = []
  let campaign: ZhCampaign | null = null
  let mission: ZhMission | null = null
  for (const line of lines(text)) {
    if (/^Campaign\s+/i.test(line)) {
      campaign = { id: line.replace(/^Campaign\s+/i, ''), label: '', firstMission: '', playerFaction: '', challenge: false, missions: [] }
      result.push(campaign); mission = null; continue
    }
    if (/^Mission\s+/i.test(line) && campaign) {
      mission = { id: line.replace(/^Mission\s+/i, ''), map: '', nextMission: '', location: '', generalName: '' }
      campaign.missions.push(mission); continue
    }
    if (/^End$/i.test(line)) { if (mission) mission = null; else campaign = null; continue }
    const [key, value] = field(line)
    if (mission) {
      if (key === 'Map') mission.map = value
      else if (key === 'NextMission') mission.nextMission = value
      else if (key === 'LocationNameLabel') mission.location = value
      else if (key === 'GeneralName') mission.generalName = value
    } else if (campaign) {
      if (key === 'FirstMission') campaign.firstMission = value
      else if (key === 'CampaignNameLabel') campaign.label = value
      else if (key === 'PlayerFaction') campaign.playerFaction = value
      else if (key === 'IsChallengeCampaign') campaign.challenge = /^(yes|true|1)$/i.test(value)
    }
  }
  return result
}

function parseGenerals(text: string): ZhGeneral[] {
  const result: ZhGeneral[] = []
  let current: ZhGeneral | null = null
  for (const line of lines(text)) {
    const match = line.match(/^GeneralPersona(\d+)$/i)
    if (match) {
      current = { index: Number(match[1]), enabled: false, name: '', rank: '', branch: '', strategy: '', campaign: '', playerTemplate: '' }
      result.push(current); continue
    }
    if (/^End$/i.test(line)) { current = null; continue }
    if (!current) continue
    const [key, value] = field(line)
    if (key === 'StartsEnabled') current.enabled = /^(yes|true|1)$/i.test(value)
    else if (key === 'BioNameString') current.name = value
    else if (key === 'BioRankString') current.rank = value
    else if (key === 'BioBranchString') current.branch = value
    else if (key === 'BioStrategyString') current.strategy = value
    else if (key === 'Campaign') current.campaign = value
    else if (key === 'PlayerTemplate') current.playerTemplate = value
  }
  return result.filter((general) => general.campaign && general.playerTemplate)
}

export async function loadZhSinglePlayer(gameDir: string, includeCampaigns: boolean) {
  const [campaignIni, challengeIni] = await Promise.all([
    readGeneralsVfsFile(gameDir, 'Data/INI/Campaign.ini'),
    readGeneralsVfsFile(gameDir, 'Data/INI/ChallengeMode.ini')
  ])
  const allCampaigns = parseCampaigns(campaignIni)
  return {
    campaigns: includeCampaigns ? allCampaigns.filter((campaign) => ['usa', 'gla', 'china'].includes(campaign.id.toLowerCase())) : [],
    challengeCampaigns: allCampaigns.filter((campaign) => campaign.challenge),
    generals: parseGenerals(challengeIni)
  }
}
