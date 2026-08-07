import { readGeneralsVfsFile, readGeneralsVfsBuffer } from './big-reader'
import { decodeText, detectTextEncoding } from './ini-parser'

export type ZhMission = { id: string; map: string; nextMission: string; location: string; generalName: string }
export type ZhCampaign = { id: string; label: string; firstMission: string; playerFaction: string; challenge: boolean; missions: ZhMission[] }
export type ZhGeneral = { index: number; enabled: boolean; name: string; rank: string; branch: string; strategy: string; campaign: string; playerTemplate: string; side: string; baseSide: string }

function parseCsfLabels(data: Buffer): Map<string, string> {
  const labels = new Map<string, string>()
  if (data.length < 20 || data.toString('ascii', 0, 4) !== ' FSC') return labels
  // FSC header: magic, version, label count, string count, language ID.
  let p = 20
  const count = data.readUInt32LE(8)
  for (let i = 0; i < count && p + 8 <= data.length; i++) {
    if (data.toString('ascii', p, p + 4) !== ' LBL') break
    const chars = data.readUInt32LE(p + 4); p += 8
    if (chars > 4096 || p + chars * 2 > data.length) break
    const key = data.subarray(p, p + chars * 2).toString('utf16le').replace(/\0/g, '')
    p += chars * 2
    if (data.toString('ascii', p, p + 4) !== ' RTS') break
    const bytes = data.readUInt32LE(p + 4); p += 8
    if (bytes > data.length - p) break
    labels.set(key.toLowerCase(), data.subarray(p, p + bytes).toString('utf16le').replace(/\0/g, ''))
    p += bytes
  }
  return labels
}

function lines(text: string): string[] {
  // 对齐 MD INI::readLine：遇 `;` 截断整行（`//` 不是注释，靠分词天然忽略）。
  return text.split(/\r?\n/).map((line) => {
    const semi = line.indexOf(';')
    return (semi < 0 ? line : line.slice(0, semi)).trim()
  }).filter(Boolean)
}

/** EA 分词语义：值/名字只取第一个 token（对齐 parseAsciiString，其余 token 原版直接忽略）。 */
function firstToken(value: string): string {
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1)
    return end < 0 ? value.slice(1) : value.slice(1, end)
  }
  return value.split(/\s+/)[0] ?? ''
}

function field(line: string): [string, string] {
  const equal = line.indexOf('=')
  if (equal >= 0) return [line.slice(0, equal).trim(), firstToken(line.slice(equal + 1).trim())]
  const split = line.search(/\s+/)
  return split < 0 ? [line, ''] : [line.slice(0, split), firstToken(line.slice(split).trim())]
}

function parseCampaigns(text: string): ZhCampaign[] {
  const result: ZhCampaign[] = []
  let campaign: ZhCampaign | null = null
  let mission: ZhMission | null = null
  for (const line of lines(text)) {
    if (/^Campaign\s+/i.test(line)) {
      campaign = { id: firstToken(line.replace(/^Campaign\s+/i, '')), label: '', firstMission: '', playerFaction: '', challenge: false, missions: [] }
      result.push(campaign); mission = null; continue
    }
    if (/^Mission\s+/i.test(line) && campaign) {
      mission = { id: firstToken(line.replace(/^Mission\s+/i, '')), map: '', nextMission: '', location: '', generalName: '' }
      campaign.missions.push(mission); continue
    }
    if (/^End$/i.test(line)) { if (mission) mission = null; else campaign = null; continue }
    const [rawKey, value] = field(line)
    const key = normalizedKey(rawKey)
    if (mission) {
      if (key === 'map') mission.map = value
      else if (key === 'nextmission') mission.nextMission = value
      else if (key === 'locationnamelabel') mission.location = value
      else if (key === 'generalname') mission.generalName = value
    } else if (campaign) {
      if (key === 'firstmission') campaign.firstMission = value
      else if (key === 'campaignnamelabel') campaign.label = value
      else if (key === 'playerfaction') campaign.playerFaction = value
      else if (key === 'ischallengecampaign') campaign.challenge = /^(yes|true|1)$/i.test(value)
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
      current = { index: Number(match[1]), enabled: false, name: '', rank: '', branch: '', strategy: '', campaign: '', playerTemplate: '', side: '', baseSide: '' }
      result.push(current); continue
    }
    if (/^End$/i.test(line)) { current = null; continue }
    if (!current) continue
    const [rawKey, value] = field(line)
    const key = normalizedKey(rawKey)
    if (key === 'startsenabled') current.enabled = /^(yes|true|1)$/i.test(value)
    else if (key === 'bionamestring') current.name = value
    else if (key === 'biorankstring') current.rank = value
    else if (key === 'biobranchstring') current.branch = value
    else if (key === 'biostrategystring') current.strategy = value
    else if (key === 'campaign') current.campaign = value
    else if (key === 'playertemplate') current.playerTemplate = value
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

function parsePlayerTemplates(text: string): Map<string, { side: string; baseSide: string }> {
  const result = new Map<string, { side: string; baseSide: string }>()
  let name = ''; let side = ''; let baseSide = ''
  for (const line of lines(text)) {
    if (/^PlayerTemplate\s+/i.test(line)) { name = firstToken(line.replace(/^PlayerTemplate\s+/i, '')); side = ''; baseSide = ''; continue }
    if (/^End$/i.test(line) && name) { result.set(name.toLowerCase(), { side, baseSide }); name = ''; continue }
    if (!name) continue
    const [rawKey, value] = field(line); const key = normalizedKey(rawKey)
    if (key === 'side') side = value
    else if (key === 'baseside') baseSide = value
  }
  return result
}

function normalizedKey(value: string): string { return value.trim().toLowerCase() }

/** TD 三层目录的单人配置：ZH 本体 BIG，最后叠加 MOD playground。 */
export async function loadZhSinglePlayerLayers(gameDirs: string[], includeCampaigns: boolean) {
  const campaignLayers: ZhCampaign[] = []
  const generalLayers: ZhGeneral[] = []
  // 原版读取 ZH 基础层；MOD 播放集只读取最后的 playground 覆盖层，
  // 不能把原版挑战混进 MOD 的挑战列表，也不能在 MOD 缺配置时静默回退原版。
  const effectiveDirs = includeCampaigns ? gameDirs : gameDirs.slice(-1)
  for (const dir of effectiveDirs) {
    const [campaignData, challengeData, templateData] = await Promise.all([
      readGeneralsVfsBuffer(dir, 'Data/INI/Campaign.ini'),
      readGeneralsVfsBuffer(dir, 'Data/INI/ChallengeMode.ini'),
      readGeneralsVfsBuffer(dir, 'Data/INI/PlayerTemplate.ini')
    ])
    if (campaignData) campaignLayers.push(...parseCampaigns(decodeText(campaignData, detectTextEncoding(campaignData))))
    if (challengeData) generalLayers.push(...parseGenerals(decodeText(challengeData, detectTextEncoding(challengeData))))
    if (templateData) {
      const templates = parsePlayerTemplates(decodeText(templateData, detectTextEncoding(templateData)))
      for (const general of generalLayers) {
        const identity = templates.get(general.playerTemplate.toLowerCase())
        if (identity) { general.side = identity.side; general.baseSide = identity.baseSide }
      }
    }
  }
  // 后加载层按 id/index 覆盖同名条目，同时保留 MOD 新增条目。
  const campaignMap = new Map<string, ZhCampaign>()
  for (const campaign of campaignLayers) campaignMap.set(campaign.id.toLowerCase(), campaign)
  const generalMap = new Map<number, ZhGeneral>()
  for (const general of generalLayers) generalMap.set(general.index, general)
  const allCampaigns = [...campaignMap.values()]
  const csfData = (await readGeneralsVfsBuffer(gameDirs[gameDirs.length - 1], 'Data/Chinese/generals.csf'))
    ?? (await readGeneralsVfsBuffer(gameDirs[gameDirs.length - 1], 'Data/English/generals.csf'))
    ?? (await readGeneralsVfsBuffer(gameDirs[gameDirs.length - 1], 'generals.csf'))
  const csf = parseCsfLabels(csfData ?? Buffer.alloc(0))
  for (const general of generalMap.values()) {
    const key = general.name.toLowerCase()
    if (csf.has(key)) general.name = csf.get(key)!
  }
  // MOD 挑战配置的 Campaign.ini 有时不写 IsChallengeCampaign；
  // ChallengeMode.ini 中 GeneralPersona 的 Campaign 引用才是实际生效的挑战路线。
  const referencedChallengeIds = new Set(
    [...generalMap.values()].map((general) => general.campaign.trim().toLowerCase()).filter(Boolean)
  )
  const effectiveChallengeCampaigns = allCampaigns.filter((campaign) =>
    campaign.challenge || referencedChallengeIds.has(campaign.id.trim().toLowerCase())
  )
  return {
    campaigns: includeCampaigns ? allCampaigns.filter((campaign) => ['usa', 'gla', 'china'].includes(campaign.id.toLowerCase())) : [],
    challengeCampaigns: effectiveChallengeCampaigns,
    generals: [...generalMap.values()].filter((general) => general.campaign && general.playerTemplate)
  }
}
