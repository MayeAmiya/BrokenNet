// ─── Lobby Types (XNA CnCNet aligned) ─────────────────

export interface Room {
  id: string
  name: string
  host: string
  hostId: string
  gameId: string
  gameMode: string
  map: string
  mapFilePath?: string
  maxPlayers: number
  currentPlayers: number
  hasPassword: boolean
  isLocked: boolean
  status: 'waiting' | 'starting' | 'in-game'
  createdAt: number
  modSetId?: string
  modSetName?: string
  tunnelServer?: string
  skillLevel?: number
  channelName?: string
  channelPassword?: string
  /** 游戏版本（GAME 广播字段，供预览显示） */
  gameVersion?: string
  /** 地图文件内容 SHA1（GAME 广播字段，真实客户端用它匹配本地地图） */
  mapHash?: string
  /** 打包的游戏选项（R14 广播字段，位布局私有，不做解码） */
  packedOptions?: string
  /** CnCNet 协议版本（R8/R14） */
  protocolRevision?: string
  /** 帧发送率（order lag，房主经 /framesendrate 设置并广播，写入 spawn.ini [Settings]） */
  frameSendRate?: number
  /** 随机种子：房主生成，GO 广播 + spawn.ini [Settings] Seed 必须一致，全员同步否则 desync */
  randomSeed?: number
  /** 房间内玩家（广播数据；Room 为名称列表，RoomDetail 为详细对象） */
  players?: string[] | RoomPlayer[]
}

export interface RoomPlayer {
  id: string
  name: string
  isReady: boolean
  isHost: boolean
  isAI: boolean
  color: string
  colorIndex: number
  faction: string
  factionIndex: number
  team: string
  teamIndex: number
  /** 起始位置：-1=随机/未分配，0=位置1，N=位置N+1（协议 wire 字节 = startIndex+1，0=随机） */
  startIndex: number
  sideName: string
  /** 该玩家禁用的随机阵营（具体阵营索引 0-11，launcher 专属 ban 随机功能） */
  bannedFactions?: number[]
  /** AI 难度（1=简单 2=普通 3=困难；仅 AI 玩家用，房主设置） */
  aiLevel?: number
  /** 到隧道服务器的延迟 ms（launcher 专属 L-PING 上报） */
  ping?: number
}

export interface RoomDetail extends Room {
  players: RoomPlayer[]
}

export interface ChatMessage {
  id: string
  roomId: string
  userId: string
  userName: string
  content: string
  timestamp: number
  type: 'message' | 'system' | 'join' | 'leave' | 'map-request'
  /** 附加数据（如 L-MAP 的 mapHash，跨语言同步用） */
  data?: string
  /** IRC 颜色 id（原版客户端聊天消息前缀 \x03NN，用于给消息着色） */
  colorId?: number
}

/** IRC 颜色 id → 显示用 hex（对齐 IRC 标准色板） */
// 对齐参考客户端色板（CnCNetManager ircChatColors）：接收 \x03NN 消息时按原版客户端实际显示的颜色渲染，
// 和发送端 CHAT_COLOR_IRC_IDS 保持一致，避免收到 \x0305 却显示成标准 mIRC 的棕色
export const IRC_COLOR_HEX: Record<number, string> = {
  0: '#FFFFFF', 1: '#FFFFFF', 2: '#ADD8E6', 3: '#228B22', 4: '#B40000',
  5: '#FF0000', 6: '#9370DB', 7: '#FFA500', 8: '#FFFF00', 9: '#32CD32',
  10: '#40E0D0', 11: '#87CEFB', 12: '#4169E1', 13: '#FF1493', 14: '#D3D3D3', 15: '#808080'
}

export interface Friend {
  id: string
  name: string
  status: 'online' | 'offline' | 'in-game'
  gameId?: string
  roomId?: string
}


export interface CreateRoomParams {
  name: string
  gameId: string
  gameMode: string
  map: string
  maxPlayers: number
  password?: string
  skillLevel?: number
  tunnelServer?: string
  modSetId?: string
  modSetName?: string
}

export interface TunnelServer {
  name: string
  url: string
  ping: number
  players: number
  country: string
  official: boolean
}

// ─── Constants (XNA CnCNet aligned) ──────────────────

export const MP_COLORS = [
  { name: 'Gold', r: 255, g: 223, b: 94, hex: '#FFDF5E' },
  { name: 'Red', r: 222, g: 0, b: 0, hex: '#DE0000' },
  { name: 'Blue', r: 39, g: 60, b: 179, hex: '#273CB3' },
  { name: 'Green', r: 12, g: 150, b: 12, hex: '#0C960C' },
  { name: 'Orange', r: 255, g: 145, b: 0, hex: '#FF9100' },
  { name: 'Cyan', r: 20, g: 177, b: 255, hex: '#14B1FF' },
  { name: 'Purple', r: 185, g: 20, b: 255, hex: '#B914FF' },
  { name: 'Pink', r: 255, g: 94, b: 199, hex: '#FF5EC7' }
]

export const SIDES = ['Random', 'America', 'China', 'GLA', 'Spectator']

export const TEAMS = ['-', 'A', 'B', 'C', 'D']

export const GAME_SPEED_OPTIONS = [
  { label: '60 FPS', value: 60 },
  { label: '52 FPS', value: 52 },
  { label: '45 FPS', value: 45 },
  { label: '40 FPS', value: 40 },
  { label: '30 FPS', value: 30 },
  { label: '20 FPS', value: 20 },
  { label: '15 FPS', value: 15 }
]

export const TECH_LEVEL_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]

export const CREDIT_OPTIONS = [20000, 15000, 12500, 10000, 7500, 5000, 2500]

export const UNIT_COUNT_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]

export const SKILL_LEVEL_OPTIONS = ['Unspecified', 'Beginner', 'Intermediate', 'Advanced', 'Expert']

export const CHAT_COLORS = [
  { name: 'Default', value: '#FFFFFF' },
  { name: 'Light Gray', value: '#C0C0C0' },
  { name: 'Dark Gray', value: '#808080' },
  { name: 'Red', value: '#FF0000' },
  { name: 'Green', value: '#00FF00' },
  { name: 'Blue', value: '#0000FF' },
  { name: 'Yellow', value: '#FFFF00' },
  { name: 'Cyan', value: '#00FFFF' },
  { name: 'Orange', value: '#FF8800' },
  { name: 'Purple', value: '#BB00FF' }
]

/** CHAT_COLORS 各色对应的 IRC 颜色 id（发送消息前缀 \x03NN 用，对齐原版客户端色板 CnCNetManager ircChatColors） */
export const CHAT_COLOR_IRC_IDS = [0, 14, 15, 5, 9, 2, 8, 11, 7, 6]

/** 选中的聊天 hex 颜色 → IRC 颜色 id；取不到默认 0 */
export function chatColorToIrcId(hex: string): number {
  const idx = CHAT_COLORS.findIndex((c) => c.value.toUpperCase() === String(hex).toUpperCase())
  return idx >= 0 ? CHAT_COLOR_IRC_IDS[idx] : 0
}
