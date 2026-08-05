/**
 * spawn.ini 生成器
 *
 * 支持三种模式：
 * - campaign: 单人战役
 * - skirmish: 遭遇战（单人 vs AI）
 * - multiplayer: 多人联机（CnCNet / LAN）
 *
 * 参考 CnCNet 客户端的 CampaignSelector + GameLobbyBase 实现。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type GameMode = 'campaign' | 'skirmish' | 'multiplayer'

export interface SpawnIniBase {
  /** 游戏根目录 */
  gameDir: string
  /** 玩家名称 */
  playerName: string
  /** 地图路径（相对于游戏目录） */
  scenario: string
  /** 势力索引 (0=GDI, 1=Nod, ...) */
  side: number
  /** 颜色索引 */
  color: number
  /** 地图 SHA1 哈希 */
  mapSha1?: string
  /** 自定义加载画面 */
  customLoadScreen?: string
  /** 游戏速度 */
  gameSpeed?: number
  /** 自定义地图目录（写 [Settings] MPMapsPath，游戏从这里读下载/导入的地图） */
  mpMapsPath?: string
}

export interface CampaignSpawnOptions extends SpawnIniBase {
  mode: 'campaign'
  /** 战役 ID */
  campaignId?: number
  /** 是否为资料片模式 */
  requiredAddon?: boolean
  /** 人类难度 (0=Easy, 1=Normal, 2=Hard) */
  difficultyHuman: number
  /** AI 难度 (反转: Easy=2, Normal=1, Hard=0) */
  difficultyComputer: number
  /** BuildOffAlly */
  buildOffAlly?: boolean
  /** 自定义关卡 ID */
  customMissionId?: number
  /** 是否为 YR/Ares 模式（写 Ra2Mode） */
  useYrMode?: boolean
  /** SidebarHack（XNA 客户端写入） */
  sidebarHack?: boolean
  /** ReadMissionSection（XNA 客户端写入） */
  readMissionSection?: boolean
}

export interface SkirmishSpawnOptions extends SpawnIniBase {
  mode: 'skirmish'
  /** 玩家数（含 AI） */
  playerCount: number
  /** AI 玩家数 */
  aiPlayers: number
  /** 随机种子 */
  seed: number
  /** 是否旁观 */
  isSpectator?: boolean
  /** 模式 UI 名（写 [Settings] UIGameMode，供游戏内加载大厅显示） */
  uiGameMode?: string
  /** 地图 UI 名（写 [Settings] UIMapName） */
  uiMapName?: string
  /** AI 配置 */
  aiPlayersConfig?: Array<{
    name: string
    side: number
    color: number
    aiLevel: number
    waypoint: number
  }>
  /** 额外 Settings 键值对 */
  extraSettings?: Record<string, string>
  /** 合作/挑战模式：AI（enemyHouses）互相结盟（对齐 xna Map.ApplySpawnIniCode coop 联盟段） */
  isCoop?: boolean
}

export interface MultiplayerSpawnOptions extends SpawnIniBase {
  mode: 'multiplayer'
  /** 玩家数 */
  playerCount: number
  /** 随机种子 */
  seed: number
  /** 是否为房主 */
  isHost: boolean
  /** 帧发送率 */
  frameSendRate?: number
  /** 最提前帧数 */
  maxAhead?: number
  /** 协议版本 */
  protocol?: number
  /** 游戏 ID */
  gameId?: number
  /** 端口 */
  port?: number
  /** 我的队伍/起始位置（spawn.ini [Settings]） */
  myTeam?: number
  myStart?: number
  /** 地图/模式显示信息 */
  uiGameMode?: string
  uiMapName?: string
  mapId?: string
  /** 隧道服务器 */
  tunnel?: { ip: string; port: number }
  /** 其他玩家（人类） */
  otherPlayers?: Array<{
    name: string
    side: number
    color: number
    team?: number
    startIndex?: number
    ip: string
    port: number
    isSpectator?: boolean
  }>
  /** AI 玩家数 */
  aiPlayers?: number
  /** AI 玩家配置（对齐 xna：写 HouseHandicaps/HouseCountries/HouseColors，不写 Other 段） */
  aiPlayersConfig?: Array<{
    name: string
    side: number
    color: number
    aiLevel: number
    waypoint: number
  }>
  /** 额外 Settings 键值对 */
  extraSettings?: Record<string, string>
  /** 合作/挑战模式：AI（enemyHouses）互相结盟（对齐 xna Map.ApplySpawnIniCode coop 联盟段） */
  isCoop?: boolean
}

export type SpawnIniOptions = CampaignSpawnOptions | SkirmishSpawnOptions | MultiplayerSpawnOptions

// ─── INI 写入工具 ──────────────────────────────────────

function escapeIniValue(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

class IniWriter {
  private sections = new Map<string, Array<[string, string]>>()

  set(section: string, key: string, value: string | number | boolean): void {
    if (!this.sections.has(section)) this.sections.set(section, [])
    this.sections.get(section)!.push([key, escapeIniValue(value)])
  }

  toString(): string {
    const lines: string[] = []
    for (const [section, entries] of this.sections) {
      lines.push(`[${section}]`)
      for (const [k, v] of entries) {
        lines.push(`${k}=${v}`)
      }
      lines.push('')
    }
    return lines.join('\r\n')
  }
}

// MultiN_Alliances 的 HouseAlly 键名：One/Two/Three...（对齐 xna HouseAllyIndexToString，数字键游戏不识别）
const HOUSE_ALLY_KEYS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight']

function houseAllyKey(idx: number): string {
  return `HouseAlly${HOUSE_ALLY_KEYS[idx] ?? idx}`
}

/**
 * 合作/挑战：敌军互相结盟（对齐 xna Map.ApplySpawnIniCode coop 联盟段）。
 * humansCount = 人类玩家数，AI 从 Multi{humansCount+1} 起，互相结盟。
 */
function writeCoopEnemyAlliances(ini: IniWriter, humansCount: number, aiCount: number): void {
  for (let i = 0; i < aiCount; i++) {
    const eMultiId = humansCount + i + 1
    let allyIdx = 0
    for (let j = 0; j < aiCount; j++) {
      if (j === i) continue
      ini.set(`Multi${eMultiId}_Alliances`, houseAllyKey(allyIdx), humansCount + j)
      allyIdx++
    }
  }
}

// ─── 公共 keys ─────────────────────────────────────────

function writeBaseSettings(ini: IniWriter, opts: SpawnIniBase): void {
  ini.set('Settings', 'Name', opts.playerName)
  ini.set('Settings', 'Scenario', opts.scenario)
  ini.set('Settings', 'Side', opts.side)
  ini.set('Settings', 'Color', opts.color)
  if (opts.mapSha1) ini.set('Settings', 'MapSHA1', opts.mapSha1)
  if (opts.customLoadScreen) ini.set('Settings', 'CustomLoadScreen', opts.customLoadScreen)
  if (opts.gameSpeed !== undefined) ini.set('Settings', 'GameSpeed', opts.gameSpeed)
  if (opts.mpMapsPath) ini.set('Settings', 'MPMapsPath', opts.mpMapsPath)
}

// ─── Campaign ──────────────────────────────────────────

function buildCampaignIni(opts: CampaignSpawnOptions): string {
  const ini = new IniWriter()

  writeBaseSettings(ini, opts)
  ini.set('Settings', 'IsSinglePlayer', 'Yes')
  ini.set('Settings', 'DifficultyModeHuman', opts.difficultyHuman)
  ini.set('Settings', 'DifficultyModeComputer', opts.difficultyComputer)
  if (opts.campaignId !== undefined) ini.set('Settings', 'CampaignID', opts.campaignId)
  if (opts.buildOffAlly) ini.set('Settings', 'BuildOffAlly', true)
  if (opts.customMissionId !== undefined) ini.set('Settings', 'CustomMissionID', opts.customMissionId)
  if (opts.sidebarHack !== undefined) ini.set('Settings', 'SidebarHack', opts.sidebarHack)
  if (opts.readMissionSection !== undefined) ini.set('Settings', 'ReadMissionSection', opts.readMissionSection)
  if (opts.customLoadScreen) ini.set('Settings', 'CustomLoadScreen', opts.customLoadScreen)
  if (opts.gameSpeed !== undefined) ini.set('Settings', 'GameSpeed', opts.gameSpeed)

  // YR/Ares: Ra2Mode = !RequiredAddon; TS: Firestorm = RequiredAddon
  if (opts.useYrMode) {
    ini.set('Settings', 'Ra2Mode', !opts.requiredAddon)
  } else {
    ini.set('Settings', 'Firestorm', !!opts.requiredAddon)
  }

  return ini.toString()
}

// ─── Skirmish ──────────────────────────────────────────

function buildSkirmishIni(opts: SkirmishSpawnOptions): string {
  const ini = new IniWriter()

  writeBaseSettings(ini, opts)
  ini.set('Settings', 'PlayerCount', opts.playerCount)
  ini.set('Settings', 'AIPlayers', opts.aiPlayers)
  ini.set('Settings', 'Seed', opts.seed)
  ini.set('Settings', 'IsSpectator', opts.isSpectator ?? false)
  if (opts.uiGameMode) ini.set('Settings', 'UIGameMode', opts.uiGameMode)
  if (opts.uiMapName) ini.set('Settings', 'UIMapName', opts.uiMapName)

  if (opts.extraSettings) {
    for (const [k, v] of Object.entries(opts.extraSettings)) {
      ini.set('Settings', k, v)
    }
  }

  // AI 玩家段 + 房屋配置（人类=Multi1，AI 从 Multi2 起；HouseHandicaps 难度对齐 xna）
  // 注意：coop（合作/挑战）的敌军只写 House* 段，不写 Other 段——Other 会被 spawner 当作人类玩家等连接导致黑屏。
  opts.aiPlayersConfig?.forEach((ai, i) => {
    if (!opts.isCoop) {
      const key = `Other${i + 1}`
      ini.set(key, 'Name', ai.name)
      ini.set(key, 'Side', ai.side)
      ini.set(key, 'Color', ai.color)
      ini.set(key, 'IsSpectator', false)
      ini.set(key, 'Ip', '0.0.0.0')
      ini.set(key, 'Port', 0)
    }
    const multiId = i + 2
    const handicap = ai.aiLevel != null ? 3 - ai.aiLevel : 1
    ini.set('HouseHandicaps', `Multi${multiId}`, handicap)
    ini.set('HouseCountries', `Multi${multiId}`, ai.side)
    ini.set('HouseColors', `Multi${multiId}`, ai.color)
    if (ai.waypoint !== undefined && ai.waypoint >= 0) {
      ini.set('SpawnLocations', `Multi${multiId}`, ai.waypoint)
    }
  })

  // 合作/挑战：敌军互相结盟（人类=Multi1，AI 从 Multi2 起）
  if (opts.isCoop) {
    writeCoopEnemyAlliances(ini, 1, opts.aiPlayersConfig?.length ?? 0)
  }

  return ini.toString()
}

// ─── Multiplayer ───────────────────────────────────────

function buildMultiplayerIni(opts: MultiplayerSpawnOptions): string {
  const ini = new IniWriter()

  writeBaseSettings(ini, opts)
  ini.set('Settings', 'PlayerCount', opts.playerCount)
  ini.set('Settings', 'Seed', opts.seed)
  ini.set('Settings', 'IsSpectator', false)
  ini.set('Settings', 'Host', opts.isHost)
  if (opts.aiPlayers !== undefined) ini.set('Settings', 'AIPlayers', opts.aiPlayers)
  if (opts.uiGameMode) ini.set('Settings', 'UIGameMode', opts.uiGameMode)
  if (opts.uiMapName) ini.set('Settings', 'UIMapName', opts.uiMapName)
  if (opts.mapId) ini.set('Settings', 'MapID', opts.mapId)
  if (opts.gameId !== undefined) ini.set('Settings', 'GameID', opts.gameId)
  if (opts.port !== undefined) ini.set('Settings', 'Port', opts.port)
  if (opts.frameSendRate !== undefined) ini.set('Settings', 'FrameSendRate', opts.frameSendRate)
  if (opts.maxAhead !== undefined && opts.maxAhead > 0) ini.set('Settings', 'MaxAhead', opts.maxAhead)
  if (opts.protocol !== undefined) ini.set('Settings', 'Protocol', opts.protocol)

  if (opts.extraSettings) {
    for (const [k, v] of Object.entries(opts.extraSettings)) {
      ini.set('Settings', k, v)
    }
  }

  // 隧道
  if (opts.tunnel) {
    ini.set('Tunnel', 'Ip', opts.tunnel.ip)
    ini.set('Tunnel', 'Port', opts.tunnel.port)
  }

  // 其他玩家段（原版格式：Name/Side/IsSpectator/Color/Ip/Port）
  opts.otherPlayers?.forEach((p, i) => {
    const key = `Other${i + 1}`
    ini.set(key, 'Name', p.name)
    ini.set(key, 'Side', p.side)
    ini.set(key, 'Color', p.color)
    ini.set(key, 'IsSpectator', p.isSpectator ?? false)
    ini.set(key, 'Ip', p.ip)
    ini.set(key, 'Port', p.port)
  })

  // 起始位置：[SpawnLocations] MultiN = waypoint（含我的）
  const allPlayers = [
    { startIndex: opts.myStart, team: opts.myTeam },
    ...(opts.otherPlayers ?? []).map((p) => ({ startIndex: p.startIndex, team: p.team }))
  ]
  allPlayers.forEach((p, i) => {
    if (p.startIndex !== undefined && p.startIndex >= 0) {
      ini.set('SpawnLocations', `Multi${i + 1}`, p.startIndex)
    }
  })

  // 队伍/联盟：[MultiN_Alliances] HouseAllyX = 同队玩家的 house id（原版联盟机制）
  // team=0 表示"未分配队伍/自由混战"（TEAMS = ['-','A','B','C','D']），
  // 不能默认 0 后全员结盟——未分队的玩家应各自为战，不写任何 MultiN_Alliances。
  const teams = new Map<number, number[]>()
  allPlayers.forEach((p, i) => {
    const t = p.team ?? 0
    if (t <= 0) return // 自由混战：独立队伍
    if (!teams.has(t)) teams.set(t, [])
    teams.get(t)!.push(i + 1)
  })
  for (const [, members] of teams) {
    for (const houseId of members) {
      let allyIdx = 0
      for (const ally of members) {
        if (ally !== houseId) {
          ini.set(`Multi${houseId}_Alliances`, houseAllyKey(allyIdx), ally - 1)
          allyIdx++
        }
      }
    }
  }

  // AI 玩家（对齐 xna：不写 Other 段，按房屋 ID 写 HouseHandicaps/HouseCountries/HouseColors + 出生点）
  // 房屋号在所有人类玩家之后：我(1) + otherPlayers → humansCount，AI 从 humansCount+1 开始
  const humansCount = 1 + (opts.otherPlayers?.length ?? 0)
  ;(opts.aiPlayersConfig ?? []).forEach((ai, i) => {
    const multiId = humansCount + i + 1
    if (ai.waypoint !== undefined && ai.waypoint >= 0) {
      ini.set('SpawnLocations', `Multi${multiId}`, ai.waypoint)
    }
    // aiLevel：1=简单 2=普通 3=困难 → HouseHandicaps 值是反的（2=简单 1=普通 0=困难，对齐 xna）
    const handicap = ai.aiLevel != null ? 3 - ai.aiLevel : 1 // 默认普通
    ini.set('HouseHandicaps', `Multi${multiId}`, handicap)
    ini.set('HouseCountries', `Multi${multiId}`, ai.side)
    ini.set('HouseColors', `Multi${multiId}`, ai.color)
  })

  // 合作/挑战：敌军互相结盟（对齐 xna coop 联盟段）
  if (opts.isCoop) {
    writeCoopEnemyAlliances(ini, humansCount, opts.aiPlayersConfig?.length ?? 0)
  }

  return ini.toString()
}

// ─── 导出 ──────────────────────────────────────────────

export function generateSpawnIni(opts: SpawnIniOptions): string {
  switch (opts.mode) {
    case 'campaign': return buildCampaignIni(opts)
    case 'skirmish': return buildSkirmishIni(opts)
    case 'multiplayer': return buildMultiplayerIni(opts)
  }
}

export function writeSpawnIni(gameDir: string, opts: SpawnIniOptions): string {
  const content = generateSpawnIni(opts)
  const spawnPath = join(gameDir, 'spawn.ini')
  mkdirSync(dirname(spawnPath), { recursive: true })
  writeFileSync(spawnPath, content, 'utf-8')
  return spawnPath
}
