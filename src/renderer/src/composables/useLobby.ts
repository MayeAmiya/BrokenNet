import { ref, computed } from 'vue'
import type { Room, RoomDetail, RoomPlayer, ChatMessage, CreateRoomParams } from '@renderer/types/lobby'
import { TEAMS } from '@renderer/types/lobby'
import { useNickname } from './useNickname'
import { computeLaunchGameOptions } from './gameOptions'
import { chatColorToIrcId } from '@renderer/types/lobby'
import { setGameStarted } from './useGameSession'
import {
  rooms, currentRoom, realModeNameMap, realModesData, friends, isLoading,
  cncnetConnected, onlineCount, currentGameId, currentGamePath, currentModSetId,
  playerCount, connState, connMessage, connServer, connAttempt, connTotal, lastConnError,
  connLogs, connAttempts, chatMode, privateTarget, lobbyMessages, roomMessages, privateMessages,
  chatColorHex, autoReady, realDropdowns, realCheckboxes, allRealCheckboxes,
  dropdownValues, checkboxValues, forcedSpawnIniOptions, launcherPlayers, channelError,
  realRandomSelectors, realRandomSelectorCount, realFactionCount, realSides, realMpColors,
  roomSubsRegistered, cleanupFns,
  type ChatMode, type PrivateChatTarget, type ConnLogEntry, type ConnAttemptEntry
} from './lobby-state'
export type { ChatMode, PrivateChatTarget } from './lobby-state'

export interface LaunchInfo {
  room: RoomDetail
  modSetMatch: boolean
}

/** RA2 联机玩家总数上限（人类 + AI） */
const MAX_PLAYERS = 8

let connLogSeq = 0
function logConn(text: string, kind: ConnLogEntry['kind'] = 'info'): void {
  const d = new Date()
  connLogs.value.push({
    id: ++connLogSeq,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
    text,
    kind
  })
}

function setAttempt(server: string | undefined, status: ConnAttemptEntry['status']): void {
  if (!server) return
  const existing = connAttempts.value.find((a) => a.server === server)
  if (existing) existing.status = status
  else connAttempts.value.push({ server, status })
}

// 当前显示的消息列表
const currentMessages = computed<ChatMessage[]>(() => {
  if (chatMode.value === 'lobby') return lobbyMessages.value
  if (chatMode.value === 'room') return roomMessages.value
  if (chatMode.value === 'private' && privateTarget.value) {
    return privateMessages.value.get(privateTarget.value.userId) ?? []
  }
  return []
})

let msgSeq = 0
function genMsg(roomId: string, userId: string, userName: string, content: string, type: ChatMessage['type'] = 'message'): ChatMessage {
  return {
    id: `m${++msgSeq}`,
    roomId,
    userId,
    userName,
    content,
    timestamp: Date.now(),
    type
  }
}

function genLobbyMsg(userId: string, userName: string, content: string, type: ChatMessage['type'] = 'message'): ChatMessage {
  return {
    id: `m${++msgSeq}`,
    roomId: 'lobby',
    userId,
    userName,
    content,
    timestamp: Date.now(),
    type
  }
}

let nextColorIdx = 0
function makePlayer(id: string, name: string, isHost: boolean, team?: string): RoomPlayer {
  const displayName = id === 'current' ? useNickname().getNickname() : name
  return {
    id,
    name: displayName,
    isReady: isHost,
    isHost,
    isAI: false,
    color: '',
    colorIndex: -1,
    faction: 'Random',
    factionIndex: 0,
    team: team ?? '',
    teamIndex: -1,
    startIndex: -1, // 默认未分配位置（显示 '-'）
    sideName: 'Random'
  }
}

// ─── 房间内协同：阵营/颜色映射 + 打包（对齐参考 CnCNetGameLobby）───

function sideIndex(name: string): number {
  const i = realSides.value.findIndex((s) => s.name === name)
  return i >= 0 ? i : 0
}
function sideName(idx: number): string {
  return realSides.value[idx]?.name ?? 'Random'
}
function colorIndex(hex: string): number {
  const i = realMpColors.value.findIndex((c) => c.hex === hex)
  return i >= 0 ? i : 0
}
function colorHex(idx: number): string {
  return realMpColors.value[idx]?.hex ?? ''
}
function teamIndex(t: string): number {
  return Math.max(0, TEAMS.indexOf(t))
}
function teamName(idx: number): string {
  return TEAMS[idx] ?? '-'
}

/** start 字节编码对齐参考：0=随机(-1)，1=位置1(0)，N+1=位置N+1 */
function packStartByte(startIndex: number): number {
  return (startIndex + 1) & 0xFF
}
/** 反向：wire start 字节 → 本地 startIndex（0=随机(-1)，N+1=位置N） */
function unpackStartIndex(startByte: number): number {
  return startByte - 1
}
/** 本地 AI 难度(1=简单 2=普通 3=困难) → 协议 AILevel(0=简单 1=普通 2=困难) */
function aiLevelToRef(aiLevel?: number): number {
  return (aiLevel ?? 2) - 1
}
/** 协议 AILevel(0/1/2) → 本地(1/2/3) */
function refToAiLevel(ref: number): number {
  return ref + 1
}
/** OR（客户端→主机）：byte0=side,byte1=color,byte2=start,byte3=team */
function packOrRequest(p: RoomPlayer): number {
  return (sideIndex(p.faction) & 0xFF) | ((colorIndex(p.color) & 0xFF) << 8) | (packStartByte(p.startIndex) << 16) | ((teamIndex(p.team) & 0xFF) << 24)
}
/** PO（主机→全员）：byte0=team,byte1=start,byte2=color,byte3=side */
function packPo(p: RoomPlayer): number {
  return (teamIndex(p.team) & 0xFF) | (packStartByte(p.startIndex) << 8) | ((colorIndex(p.color) & 0xFF) << 16) | ((sideIndex(p.faction) & 0xFF) << 24)
}
function unpackOr(packed: number): { side: number; color: number; start: number; team: number } {
  return { side: packed & 0xFF, color: (packed >> 8) & 0xFF, start: (packed >> 16) & 0xFF, team: (packed >> 24) & 0xFF }
}
function unpackPo(packed: number): { team: number; start: number; color: number; side: number } {
  return { team: packed & 0xFF, start: (packed >> 8) & 0xFF, color: (packed >> 16) & 0xFF, side: (packed >> 24) & 0xFF }
}

/** 房间内系统提示（输出到房间聊天栏） */
function pushRoomNotice(content: string): void {
  if (currentRoom.value) {
    roomMessages.value.push(genMsg(currentRoom.value.id, 'system', '系统', content, 'system'))
  }
}

/** 房间内显示一次掷骰结果 */
function pushRollResult(nick: string, sides: number, rolls: number[]): void {
  const total = rolls.reduce((a, b) => a + b, 0)
  const detail = rolls.length > 1 ? `（${rolls.join(' + ')}）` : ''
  pushRoomNotice(`${nick} 掷出 ${rolls.length}d${sides} = ${total} ${detail}`)
}

/** 主机把全员玩家选项广播出去（对齐参考 BroadcastPlayerOptions） */
function broadcastPlayerOptions(): void {
  const room = currentRoom.value
  if (!room?.channelName) return
  // 人类 = name;packed;ready（ready 可 2=自动准备）；AI = AILevel;packed（2 字段无 ready，AILevel 0=简单 1=普通 2=困难）
  const parts = room.players.map((p) => {
    if (p.isAI) {
      return `${aiLevelToRef(p.aiLevel)};${packPo(p)}`
    }
    return `${p.name};${packPo(p)};${p.isReady ? 1 : 0}`
  })
  window.api.cncnet.sendCtcp(room.channelName, 'PO', parts.join(';'))
}

// ─── 游戏选项状态（GameOptions.ini 的复选框/下拉，供完整 GO 打包/解析）───

/** 设置当前聊天颜色（hex，发送消息时转成 \x03NN 前缀对齐原版客户端） */
function setChatColor(hex: string): void {
  chatColorHex.value = hex
}

/** 开启/关闭"自动准备"：收到主机 GETREADY 时自动回 R 1 */
function setAutoReady(v: boolean): void {
  autoReady.value = v
  // 开启且还没准备 → 立即准备
  if (v && currentRoom.value) {
    const me = currentRoom.value.players.find((p) => p.id === 'current')
    if (me && !me.isHost && !me.isReady) {
      me.isReady = true
      window.api.cncnet.sendCtcp(currentRoom.value.channelName ?? '', 'R', '1')
    }
  }
}

// ─── launcher 专属：握手确认 + ban 随机阵营 ───

const LAUNCHER_VERSION = '1'

/** 当前房间是否全员 launcher（ban 功能启用条件） */
function isAllLauncher(): boolean {
  const room = currentRoom.value
  if (!room) return false
  const humanPlayers = room.players.filter((p) => !p.isAI)
  return humanPlayers.length > 0 && humanPlayers.every((p) => launcherPlayers.has(p.name))
}

/** 某阵营（下拉名）覆盖的具体阵营索引（game 索引 0..factionCount-1）；Random 覆盖全部，具体阵营返回空 */
function coveredFactionsForSide(faction: string): number[] {
  if (faction === 'Random') return Array.from({ length: realFactionCount.value }, (_, i) => i)
  return realRandomSelectors.value[faction] ?? []
}

/** 复选框 → 打包整数（8 bool/字节，LSB 在前，补到 4 字节后按小端读 int，对齐参考 BoolArrayIntoBytes） */
function packCheckboxes(bools: boolean[]): number[] {
  const intCount = Math.ceil(Math.ceil(bools.length / 8) / 4)
  const ints: number[] = []
  for (let i = 0; i < intCount; i++) {
    let v = 0
    for (let bit = 0; bit < 32; bit++) {
      const idx = i * 32 + bit
      if (idx < bools.length && bools[idx]) v |= (1 << bit)
    }
    ints.push(v)
  }
  return ints
}

// GO 固定字段的协议常量（对齐参考：mapOfficial;mapSHA1;gameMode;FrameSendRate;MaxAhead;ProtocolVersion;RandomSeed;RemoveStartingLocations;mapName）
const GO_MAX_AHEAD = 0
const GO_PROTOCOL_VERSION = 2
const GO_RANDOM_SEED = 0
const GO_REMOVE_STARTING_LOCATIONS = 0

/** 构建完整 GO（对齐参考 CnCNetGameLobby ApplyGameOptions 字段序） */
function buildGameOptionsData(): string {
  const room = currentRoom.value
  if (!room) return ''
  const cbInts = packCheckboxes(realCheckboxes.value.map((cb) => checkboxValues.value[cb.name] ?? cb.checked))
  const ddIdx = realDropdowns.value.map((dd) => dropdownValues.value[dd.name] ?? dd.defaultIndex ?? 0)
  // GO 的模式字段必须是内部 Name（如 "Standard"），真实客户端按 GameMode.Name 匹配；
  // 创建房间时 room.gameMode 存的是 UI 名（如 "常规作战"），这里转成内部名。
  const internalMode = realModeNameMap.value[room.gameMode] ?? room.gameMode
  return [
    ...cbInts,
    ...ddIdx,
    '0', // mapOfficial
    room.mapHash ?? '', // mapSHA1
    internalMode, // gameMode（内部名）
    room.frameSendRate ?? 3, // FrameSendRate
    GO_MAX_AHEAD,
    GO_PROTOCOL_VERSION,
    room.randomSeed ?? GO_RANDOM_SEED, // RandomSeed：房主生成后广播，spawn.ini Seed 与之一致
    GO_REMOVE_STARTING_LOCATIONS,
    room.map // mapName
  ].join(';')
}

/** 更新某个选项值（房主改选项时同步本地 + 广播 GO）；未知选项名记录告警便于排查 */
function updateOption(name: string, value: number | boolean): void {
  if (name in dropdownValues.value) dropdownValues.value[name] = value as number
  else if (name in checkboxValues.value) checkboxValues.value[name] = value as boolean
  else console.warn(`[Lobby] updateOption 未知选项: ${name}`)
  broadcastGameOptions()
}

/** 主机广播完整 GO */
function broadcastGameOptions(): void {
  const room = currentRoom.value
  if (!room?.channelName) return
  window.api.cncnet.sendCtcp(room.channelName, 'GO', buildGameOptionsData())
}

/**
 * 换图/换模式后的 GO：延迟发出（主进程 GAME 节流 1.5s 先到，GO 晚一点保证原版客户端先收 GAME 再收 GO）；
 * 连续变更合并为一次（防 Excess Flood）。普通选项变更仍走 broadcastGameOptions 即时发。
 */
const ROOM_GO_DELAY_MS = 1700
let pendingRoomGoTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRoomGo(): void {
  if (pendingRoomGoTimer) clearTimeout(pendingRoomGoTimer)
  pendingRoomGoTimer = setTimeout(() => {
    pendingRoomGoTimer = null
    broadcastGameOptions()
  }, ROOM_GO_DELAY_MS)
}

// ─── CnCNet 数据转换 ──────────────────────────────────

function cncnetRoomToRoom(cncnetRoom: any): Room {
  return {
    id: cncnetRoom.roomId,
    name: cncnetRoom.roomName,
    host: cncnetRoom.host,
    hostId: cncnetRoom.hostId,
    gameId: cncnetRoom.gameId,
    gameMode: cncnetRoom.gameMode,
    map: cncnetRoom.map,
    mapFilePath: cncnetRoom.mapFilePath,
    maxPlayers: cncnetRoom.maxPlayers,
    currentPlayers: cncnetRoom.currentPlayers,
    hasPassword: cncnetRoom.hasPassword,
    isLocked: cncnetRoom.isLocked ?? false,
    status: cncnetRoom.status === 'in-game' ? 'in-game' : 'waiting',
    createdAt: cncnetRoom.createdAt,
    channelName: cncnetRoom.channelName,
    channelPassword: cncnetRoom.channelPassword,
    gameVersion: cncnetRoom.gameVersion,
    skillLevel: cncnetRoom.skillLevel,
    mapHash: cncnetRoom.mapHash,
    packedOptions: cncnetRoom.packedOptions,
    protocolRevision: cncnetRoom.protocolRevision,
    tunnelServer: cncnetRoom.tunnelAddress,
    players: cncnetRoom.players ?? []
  }
}

function cncnetMsgToChatMsg(cncnetMsg: any): ChatMessage {
  return {
    id: cncnetMsg.id,
    roomId: cncnetMsg.roomId,
    userId: cncnetMsg.userId,
    userName: cncnetMsg.userName,
    content: cncnetMsg.content,
    timestamp: cncnetMsg.timestamp,
    type: cncnetMsg.type as ChatMessage['type']
  }
}

// ─── 房间/消息订阅（模块级注册一次，始终活跃）───────────
// 不放进 connectCncnet 的 cleanupFns —— 否则离开大厅（cleanup）后
// 房间列表/聊天就收不到事件，重进也不一定重新订阅。
// roomSubsRegistered 放在 lobby-state，热更新 useLobby 时保持，避免重复注册导致事件双发。

function registerRoomSubscriptions(): void {
  if (roomSubsRegistered.value || typeof window === 'undefined' || !window.api?.cncnet) return
  roomSubsRegistered.value = true
  const { getNickname } = useNickname()

  window.api.cncnet.onRoomUpdated((room) => {
    const converted = cncnetRoomToRoom(room)
    const idx = rooms.value.findIndex(r => r.id === converted.id)
    if (idx >= 0) {
      rooms.value[idx] = converted
    } else {
      rooms.value.unshift(converted)
    }
    // 防御去重：避免某些情况下同一房间 id 出现两次（Vue key 冲突）
    if (rooms.value.length > 1) {
      const seen = new Set<string>()
      rooms.value = rooms.value.filter((r) => {
        if (seen.has(r.id)) return false
        seen.add(r.id)
        return true
      })
    }
    onlineCount.value = rooms.value.length

    // 如果是我们托管的房间，更新 currentRoom
    if (currentRoom.value && currentRoom.value.id === converted.id) {
      const existingPlayers = currentRoom.value.players
      currentRoom.value = {
        ...converted,
        players: existingPlayers.length > 0 ? existingPlayers : [
          makePlayer('current', getNickname(), true)
        ]
      }
    }
  })

  window.api.cncnet.onRoomRemoved((data) => {
    rooms.value = rooms.value.filter(r => r.id !== data.roomId)
    onlineCount.value = rooms.value.length
    if (currentRoom.value?.id === data.roomId) {
      currentRoom.value = null
      roomMessages.value = []
      chatMode.value = 'lobby'
    }
  })

  window.api.cncnet.onMessage((msg) => {
    const converted = cncnetMsgToChatMsg(msg)
    // 路由：当前房间频道 → roomMessages；其余（大厅频道等）→ lobbyMessages
    // 注意 roomId 是频道名（#cncnet-mo-gameXXX），不能用 startsWith('cncnet_') 判断，否则房间消息全进大厅
    const room = currentRoom.value
    const isRoomChannel = !!room && (converted.roomId === room.channelName || converted.roomId === room.id)
    if (isRoomChannel) {
      roomMessages.value.push(converted)
    } else {
      lobbyMessages.value.push(converted)
    }
    // 有人加入我的房间 → 房主广播 GO + PO，把游戏设置/玩家状态同步给新成员（对齐参考 Channel_UserAdded）
    if (converted.type === 'join' && isRoomChannel && room?.players.some(p => p.id === 'current' && p.isHost)) {
      // 人类加入：若玩家总数已达上限且房间里有 AI，踢掉一个 AI 腾位（人类优先）
      if (room.players.length >= MAX_PLAYERS) {
        const aiIdx = room.players.findIndex((p) => p.isAI)
        if (aiIdx >= 0) {
          const kicked = room.players[aiIdx]
          room.players.splice(aiIdx, 1)
          pushRoomNotice(`${kicked.name} 已被移除以腾出位置给新玩家`)
        }
      }
      setTimeout(() => {
        broadcastPlayerOptions()
        broadcastGameOptions()
      }, 500)
    }
  })

  window.api.cncnet.onNames((data) => {
    // 大厅频道的用户数
    if (data.channel && !data.channel.includes('-game')) {
      onlineCount.value = data.users.length
    }
    // 游戏房间频道的玩家列表 — 只匹配当前加入的频道
    if (currentRoom.value && currentRoom.value.channelName === data.channel) {
      // 房主 = 房间的 host 名（不是 NAMES 第一个人）
      const hostName = currentRoom.value.host
      const players = data.users.map((nick, i) => {
        const isMe = nick === getNickname()
        return makePlayer(
          isMe ? 'current' : `irc_${nick.toLowerCase()}`,
          nick,
          nick === hostName,
          isMe ? undefined : ''
        )
      })
      currentRoom.value = { ...currentRoom.value, players }
    }
  })

  // ─── 房间内协同协议 ──────────────────────────────────

  // R：某玩家就绪/取消就绪 → 全员更新就绪灯 + 房间聊天提示
  window.api.cncnet.onPlayerReady?.((data) => {
    const room = currentRoom.value
    if (!room || room.channelName !== data.channel) return
    const player = room.players.find((p) => p.name === data.nick)
    if (!player) return
    player.isReady = data.ready > 0
    pushRoomNotice(data.ready > 0 ? `${data.nick} 已准备` : `${data.nick} 取消准备`)
  })

  // OR：某玩家改了阵营/颜色/队伍/位置 → 全员更新该玩家；房主再广播 PO 协调
  window.api.cncnet.onPlayerOptions?.((data) => {
    const room = currentRoom.value
    if (!room || room.channelName !== data.channel) return
    const u = unpackOr(data.options)
    const player = room.players.find((p) => p.name === data.nick)
    if (!player) return
    player.faction = sideName(u.side); player.factionIndex = u.side
    player.color = colorHex(u.color); player.colorIndex = u.color
    player.team = teamName(u.team); player.teamIndex = u.team
    player.startIndex = unpackStartIndex(u.start)
    pushRoomNotice(`${data.nick} 修改了选项`)
    if (room.players.some((p) => p.id === 'current' && p.isHost)) broadcastPlayerOptions()
  })

  // PO：房主广播的全员玩家选项 → 重建玩家表
  window.api.cncnet.onPlayerOptionsBroadcast?.((data) => {
    const room = currentRoom.value
    if (!room || room.channelName !== data.channel) return
    const parts = data.data.split(';')
    const existing = room.players
    const players: RoomPlayer[] = []
    // 参考格式：人类 = name;packed;ready（3 字段），AI = AILevel;packed（2 字段，AILevel 0=简单 1=普通 2=困难）
    for (let i = 0; i + 1 < parts.length;) {
      const name = parts[i]
      // 空名：参考广播末尾带分号，split 会多出空串，跳过（对齐参考忽略空名）
      if (!name) { i += 3; continue }
      const u = unpackPo(parseInt(parts[i + 1], 10) || 0)
      const aiLevelNum = parseInt(name, 10)
      if (!isNaN(aiLevelNum)) {
        // 参考客户端 AI 条目（2 字段，无 ready）
        players.push({
          id: `ai-${players.length}`,
          name: `Computer${players.length + 1}`,
          isReady: true,
          isHost: false,
          isAI: true,
          aiLevel: refToAiLevel(aiLevelNum),
          color: colorHex(u.color), colorIndex: u.color,
          faction: sideName(u.side), factionIndex: u.side,
          team: teamName(u.team), teamIndex: u.team,
          startIndex: unpackStartIndex(u.start),
          sideName: sideName(u.side)
        })
        i += 2
        continue
      }
      // 人类条目（含我们旧格式的 ComputerN）：ready 可为 2=自动准备
      const isMe = name === useNickname().getNickname()
      const ex = existing.find((e) => e.name === name)
      players.push({
        id: isMe ? 'current' : `irc_${name.toLowerCase()}`,
        name,
        isReady: parseInt(parts[i + 2] ?? '0', 10) > 0,
        isHost: ex?.isHost ?? false,
        isAI: /^computer/i.test(name),
        aiLevel: ex?.aiLevel,
        color: colorHex(u.color), colorIndex: u.color,
        faction: sideName(u.side), factionIndex: u.side,
        team: teamName(u.team), teamIndex: u.team,
        startIndex: unpackStartIndex(u.start),
        sideName: sideName(u.side)
      })
      i += 3
    }
    currentRoom.value = { ...room, players }
  })

  // GO：房主广播完整游戏设置（对齐参考字段序）→ 应用复选框/下拉/地图/模式并提示
  window.api.cncnet.onGameOptions?.((data) => {
    const room = currentRoom.value
    if (!room || room.channelName !== data.channel) return
    void applyGameOptionsAsync(data)
  })
  async function applyGameOptionsAsync(data: { channel: string; data: string }): Promise<void> {
    const room = currentRoom.value
    if (!room || room.channelName !== data.channel) return
    const parts = data.data.split(';')
    const cbCount = realCheckboxes.value.length
    const ddCount = realDropdowns.value.length
    const cbIntCount = Math.ceil(Math.ceil(cbCount / 8) / 4)
    const ddStart = cbIntCount
    const fixedStart = ddStart + ddCount
    // 复选框
    if (cbCount && parts.length > cbIntCount) {
      const packed = parts.slice(0, cbIntCount).map((s) => parseInt(s, 10) || 0)
      realCheckboxes.value.forEach((cb, i) => {
        const intIdx = i >> 5
        const bit = i & 31
        checkboxValues.value[cb.name] = ((packed[intIdx] ?? 0) & (1 << bit)) !== 0
      })
    }
    // 下拉索引
    if (ddCount) {
      realDropdowns.value.forEach((dd, i) => {
        const v = parseInt(parts[ddStart + i] ?? '', 10)
        if (!isNaN(v)) dropdownValues.value[dd.name] = v
      })
    }
    // 固定字段：mapOfficial;mapSHA1;gameMode;FrameSendRate;MaxAhead;ProtocolVersion;RandomSeed;RemoveStartingLocations;mapName
    const fixed = parts.slice(fixedStart)
    const [, mapSha1, gameMode, fsr] = fixed
    const mapName = fixed[8]
    // RandomSeed（fixed[6]）：房主广播的种子，客户端启动时 spawn.ini Seed 用它，与房主一致
    const randomSeed = parseInt(fixed[6] ?? '', 10)
    if (!isNaN(randomSeed)) room.randomSeed = randomSeed
    const changed: string[] = []
    // 地图同步：先用广播图名即时设置（不阻塞 GO 应用——findByHash 首次要建全图索引，可能 1-2s），
    // 再异步按内容哈希解析本地图替换（跨语言 host 图名可能对不上，SHA1 是权威）。
    if (mapSha1) room.mapHash = mapSha1
    if (mapName && mapName !== room.map) {
      room.map = mapName
      changed.push(`地图: ${mapName}`)
    }
    if (mapSha1 && currentGamePath.value) {
      void window.api.maps.findByHash(currentGamePath.value, mapSha1)
        .then((local) => {
          // 解析期间地图可能又变了，只替换仍显示广播名的场景
          if (!local?.description || !currentRoom.value) return
          if (currentRoom.value.map === mapName && currentRoom.value.map !== local.description) {
            currentRoom.value.map = local.description
            pushRoomNotice(`地图按内容哈希匹配为本地图：${local.description}`)
          }
        })
        .catch(() => { /* 解析失败用广播名 */ })
    }
    // GO 里 mode 是内部名（如 Challenge Easy），本地 room.gameMode 存 UI 名（挑战-简单）；
    // 用 realModeNameMap（UI→内部）反查转成 UI 名再比较，否则房主自己的 GO 回显会一直误报"模式变更"
    const uiMode = (Object.entries(realModeNameMap.value).find(([, v]) => v === gameMode)?.[0]) ?? gameMode
    if (gameMode && uiMode !== room.gameMode) { room.gameMode = uiMode; changed.push(`模式: ${uiMode}`) }
    if (fsr) {
      const newFsr = parseInt(fsr, 10)
      if (!isNaN(newFsr) && newFsr !== room.frameSendRate) {
        room.frameSendRate = newFsr
        changed.push(`帧发送率: ${newFsr}`)
      }
    }
    if (changed.length) pushRoomNotice(`房主更新了设置（${changed.join('，')}）`)
  }

  // MODE ±i：房主锁定/解锁 → 全员更新锁定状态
  window.api.cncnet.onMode?.((data) => {
    const room = currentRoom.value
    if (!room || room.channelName !== data.channel) return
    const locked = data.mode.includes('+i')
    if (locked !== !!room.isLocked) {
      room.isLocked = locked
      pushRoomNotice(locked ? '房间已锁定' : '房间已解锁')
    }
  })

  // STRTD：某玩家已进入游戏
  window.api.cncnet.onPlayerStarted?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    pushRoomNotice(`${data.nick} 已进入游戏`)
  })

  // GETREADY：主机要求玩家就绪
  window.api.cncnet.onGetReady?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    pushRoomNotice('主机要求所有玩家准备')
    // 自动准备：开启时非房主自动回 R 1
    if (autoReady.value) {
      const me = currentRoom.value.players.find((p) => p.id === 'current')
      if (me && !me.isHost && !me.isReady) {
        me.isReady = true
        window.api.cncnet.sendCtcp(currentRoom.value.channelName ?? '', 'R', '1')
        pushRoomNotice('已自动准备')
      }
    }
  })

  // LCKGME：主机提示需要先锁定房间
  window.api.cncnet.onLockRequired?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    pushRoomNotice('主机需要先锁定房间才能开始游戏')
  })

  // DR：某玩家掷骰子（参考格式：面数,结果1,结果2...）→ 房间聊天显示
  window.api.cncnet.onDiceRoll?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    const parts = data.data.split(',')
    const sides = parseInt(parts[0], 10) || 6
    const rolls = parts.slice(1).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n))
    if (rolls.length) pushRollResult(data.nick, sides, rolls)
  })

  // 未识别的房间 CTCP —— launcher 间自定义命令的扩展点（XNA 不认识的 tag 都走这里）
  window.api.cncnet.onRoomCtcp?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    console.log('[Lobby] 未识别的房间命令:', data.tag, data.data)
  })

  // launcher 握手：收到 L-HI → 标记对方 launcher；我是主机则回 L-OK 确认
  window.api.cncnet.onLauncherHi?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    launcherPlayers.add(data.nick)
    if (currentRoom.value.players.some((p) => p.id === 'current' && p.isHost)) {
      window.api.cncnet.sendChatCommand(currentRoom.value.channelName, 'L-OK', '')
    }
  })

  // 收到 L-OK → 标记对方（主机）为 launcher
  window.api.cncnet.onLauncherOk?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    launcherPlayers.add(data.nick)
  })

  // 收到 L-BAN → 存到该玩家的禁用随机阵营清单
  window.api.cncnet.onLauncherBan?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    const player = currentRoom.value.players.find((p) => p.name === data.nick)
    if (player) {
      player.bannedFactions = data.data.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    }
  })

  // 收到 L-MAP → 房间聊天显示"X 想玩 Y"（房主可点击切换）
  window.api.cncnet.onMapRequest?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    roomMessages.value.push(genMsg(currentRoom.value.id, data.nick, data.nick, data.data, 'map-request'))
  })

  // 收到 L-PING → 记录该玩家延迟（显示在玩家行最右）+ 房间聊天提示
  window.api.cncnet.onLauncherPing?.((data) => {
    if (!currentRoom.value || currentRoom.value.channelName !== data.channel) return
    const [address, pingStr] = data.data.split(';')
    const ping = parseInt(pingStr ?? '', 10)
    const valid = !isNaN(ping) && ping >= 0
    const player = currentRoom.value.players.find((p) => p.name === data.nick)
    if (player) player.ping = valid ? ping : undefined
    const txt = valid ? `${ping}ms` : '未知'
    pushRoomNotice(`${data.nick} 到服务器 ${address} 的延迟: ${txt}`)
  })

  // 加入频道失败（被拉黑/频道满/仅邀请等）→ 记录并提示，连接横幅显示警告
  window.api.cncnet.onChannelError?.((data) => {
    const text = `无法加入频道 ${data.channel}：${data.message}（${data.code}）`
    channelError.value = text
    lobbyMessages.value.push(genLobbyMsg('system', '系统', text, 'system'))
  })

  // 游戏进程退出 → 广播 RETURN 返回大厅
  window.api.game?.onExited?.(() => {
    setGameStarted(false) // 游戏退出 → 解除锁定
    if (currentRoom.value?.channelName) {
      window.api.cncnet.sendCtcp(currentRoom.value.channelName, 'RETURN', '')
    }
  })
}
registerRoomSubscriptions()

// ─── API ───────────────────────────────────────────────

export function useLobby() {
  // 确保房间订阅已注册（幂等；模块加载时 window.api 可能还没就绪）
  registerRoomSubscriptions()

  // ─── 连接 CnCNet ──────────────────────────────────────

  async function connectCncnet(gamePath?: string, gameId?: string, modSetId?: string): Promise<void> {
    if (!window.api?.cncnet) {
      console.warn('CnCNet API not available')
      return
    }
    // 记录游戏路径/播放集/游戏 id，连接成功后 join 对应频道（对照原版：连接成功后才 join）。
    // 游戏路径与播放集是客户端收到 START 后启动游戏的依据（见 clientLaunch），
    // 之前只在 hostLaunch 里赋值，导致非房主客户端永远启动不了游戏。
    if (gamePath) currentGamePath.value = gamePath
    if (modSetId) currentModSetId.value = modSetId
    if (gameId) currentGameId.value = gameId

    // 清掉上一次连接注册的监听器，避免重连/切游戏后监听器叠加。
    // 叠加会导致事件被重复处理（重复系统消息、重复 joinChannel），
    // onGameStart 挂多份时甚至会多次启动游戏。
    for (const fn of cleanupFns) fn()
    cleanupFns.length = 0

    // 注：不因 cncnetConnected 早退——即使已连接也要重新注册订阅（切换 tab 后 cleanup 清了订阅）

    const { getNickname } = useNickname()
    const nickname = getNickname()

    connState.value = 1
    connMessage.value = '正在连接...'
    lastConnError.value = ''
    logConn(`开始连接 CnCNet (昵称: ${nickname})...`)
    lobbyMessages.value.push(genLobbyMsg('system', '系统', `正在连接 CnCNet (昵称: ${nickname})...`, 'system'))

    cleanupFns.push(
      window.api.cncnet.onConnecting((data) => {
        connState.value = 1
        connServer.value = data.server
        connAttempt.value = data.attempt
        connTotal.value = data.total
        // 重试时带上上次失败原因，方便判断卡在哪
        connMessage.value = lastConnError.value
          ? `连接 ${data.server} (${data.attempt}/${data.total})，上次失败: ${lastConnError.value}`
          : `连接 ${data.server} (${data.attempt}/${data.total})...`
        // 连接尝试也显示在大厅聊天界面（对照 DTA：尝试连接 X）
        setAttempt(data.server, 'trying')
        logConn(`尝试连接 ${data.server} (${data.attempt}/${data.total})...`)
        lobbyMessages.value.push(genLobbyMsg('system', '系统', `尝试连接 ${data.server} (${data.attempt}/${data.total})...`, 'system'))
      }),
      window.api.cncnet.onConnected(() => {
        // TCP 连通 ≠ 连接完成：还要等 001 Welcome（对照原版 welcomeMessageReceived）
        // 这里保持「连接中」，收到 Welcome 才真正变绿
        connState.value = 1
        connMessage.value = '已连接，正在注册...'
        lastConnError.value = ''
        logConn('已建立连接，等待服务器确认...', 'info')
        lobbyMessages.value.push(genLobbyMsg('system', '系统', '已建立连接，等待服务器确认...', 'system'))
      }),
      window.api.cncnet.onDisconnected(() => {
        cncnetConnected.value = false
        // 重试耗尽才判定失败；无错误记录则是正常断线
        if (lastConnError.value) {
          connState.value = 3
          connMessage.value = lastConnError.value
          logConn(`连接失败: ${lastConnError.value}`, 'error')
        } else {
          connState.value = 0
          connMessage.value = ''
          logConn('连接已断开', 'info')
        }
        lobbyMessages.value.push(genLobbyMsg('system', '系统', '已断开 CnCNet 连接', 'system'))
      }),
      window.api.cncnet.onError((data) => {
        console.error('CnCNet error:', data.message)
        // 只记录原因，不直接跳失败态（重试还在进行，避免状态闪烁）
        lastConnError.value = data.message ?? '连接失败'
        if (connState.value !== 2) {
          connState.value = 1
          connMessage.value = `连接失败: ${lastConnError.value}，正在重试...`
        }
        setAttempt(data.server, 'failed')
        logConn(`连接服务器失败,原因:${data.message ?? '未知错误'}`, 'error')
        lobbyMessages.value.push(genLobbyMsg('system', '系统', `连接服务器失败,原因:${data.message ?? '未知错误'}`, 'system'))
      }),
      window.api.cncnet.onPlayerCount?.((data) => {
        playerCount.value = data.count
      }),
      window.api.cncnet.onLatencyTested?.((data) => {
        // 对照 DTA：当前网络质量较好的服务器数量
        const msg = `当前网络质量较好的服务器数量：${data.fast}（共 ${data.available} 个）`
        logConn(msg, 'success')
        lobbyMessages.value.push(genLobbyMsg('system', '系统', msg, 'system'))
      }),
      window.api.cncnet.onWelcome?.((data) => {
        // 收到 001 Welcome 才算真正连接成功（对照原版）→ 变绿
        connState.value = 2
        connMessage.value = '已连接'
        cncnetConnected.value = true
        for (const a of connAttempts.value) a.status = 'ok'
        logConn(`已成功连接CnCNet：${data.text}`, 'success')
        lobbyMessages.value.push(genLobbyMsg('system', '系统', data.text, 'system'))

        // 连接成功后才 join 游戏频道（对照原版 OnConnected 后 join）
        if (currentGameId.value) {
          window.api.cncnet.joinChannel(currentGameId.value)
        }
      }),
      window.api.cncnet.onServerMessage?.((data) => {
        logConn(data.text, 'info')
        lobbyMessages.value.push(genLobbyMsg('system', '系统', data.text, 'system'))
      }),
      window.api.cncnet.onNickChange((data) => {
        lobbyMessages.value.push(genLobbyMsg('system', '系统', `昵称已被占用，已切换为 ${data.nick}`, 'system'))
      }),
      // 房间内 CTCP 事件（玩家就绪/选项/游戏选项已移到 registerRoomSubscriptions 持久订阅）
      window.api.cncnet.onGameStart?.((data) => {
        setGameStarted(true) // 进入游戏 → 锁定启动器（不能再开始/切单人/改播放集）
        void clientLaunch(data)
      }),
      window.api.cncnet.onReturnToLobby?.((data) => {
        setGameStarted(false)
        if (currentRoom.value && (currentRoom.value.channelName === data.channel || currentRoom.value.id === data.channel)) {
          pushRoomNotice(`${data.nick} 返回了大厅`)
        } else {
          lobbyMessages.value.push(genLobbyMsg('system', '系统', `${data.nick} 返回了大厅`, 'system'))
        }
      }),
      window.api.cncnet.onGameSettings?.((data) => {
        console.log('[CnCNet] Game settings:', data)
      }),
      window.api.cncnet.onKicked?.((data) => {
        const myNick = useNickname().getNickname()
        if (data.nick === myNick) {
          // 我被踢了 → 离开房间
          pushRoomNotice('你已被房主踢出房间')
          void leaveRoom()
        } else if (currentRoom.value && currentRoom.value.channelName === data.channel) {
          // 其他玩家被踢 → 从房间移除
          currentRoom.value.players = currentRoom.value.players.filter((p) => p.name !== data.nick)
        }
      })
    )

    await window.api.cncnet.connect(gamePath ?? '', nickname)
  }

  function disconnectCncnet(): void {
    if (!window.api?.cncnet) return
    // 先清 lastConnError：onDisconnected 会据此把状态翻成"连接失败"，
    // 手动断开是正常断线，不能显示红色失败横幅。
    lastConnError.value = ''
    window.api.cncnet.disconnect()
    cncnetConnected.value = false
    connState.value = 0
    connMessage.value = ''
  }

  // ─── 联机启动游戏 ──────────────────────────────────────

  /**
   * 大厅阵营 UI 索引 → 游戏内部阵营索引（对齐 xna PlayerHouseInfo.InternalSideIndex）。
   * MO 未配置 InternalSideIndices → InternalSideIndex = SideIndex = UI索引 - randomCount；
   * Random(0)/随机选择器(1..rc-1) 在启动时随机化到具体阵营（对齐 xna RandomizeSide）。
   */
  function resolveInternalSide(factionIndex: number): number {
    const rc = realRandomSelectorCount.value
    const fc = realFactionCount.value
    // 合作/挑战图禁用的内部阵营：随机/选择器不能随机到被 AI 占用的阵营（对齐 xna RandomizeSide 排除 disallowedSideArray）
    const disallowed = getDisallowedInternalSides()
    const allFactions = Array.from({ length: fc }, (_, i) => i)
    const globallyAllowed = allFactions.filter((f) => !disallowed.has(f))
    const pickAllowed = (candidates: number[]): number => {
      const allowed = candidates.filter((c) => !disallowed.has(c))
      // 覆盖阵营全被禁（如只允许美国、选了任一苏联）→ 回退到全局可用阵营；全禁的极端情况才用原列表
      const pool = allowed.length ? allowed : (globallyAllowed.length ? globallyAllowed : candidates)
      return pool[Math.floor(Math.random() * pool.length)]
    }
    if (factionIndex <= 0) {
      // Random → 随机一个具体阵营（0..fc-1），排除被禁的
      return fc > 0 ? pickAllowed(allFactions) : 0
    }
    if (factionIndex < rc) {
      // 子阵营随机选择器（任一盟军等）→ 从覆盖列表随机一个（排除被禁）
      const covered = realRandomSelectors.value[sideName(factionIndex)] ?? []
      return covered.length ? pickAllowed(covered) : 0
    }
    // 具体阵营 → 内部索引 = UI 索引 - 选择器数（UI 已禁用/换图已重置，这里兜底排除）
    const direct = factionIndex - rc
    if (disallowed.has(direct)) {
      return pickAllowed(allFactions)
    }
    return direct
  }

  /**
   * 大厅颜色 UI 索引 → 游戏内部颜色索引（对齐 xna RandomizeColor）。
   * realMpColors 下标 0=Random、1..N=具体颜色；spawn.ini Color 写的是该颜色的 GameColorIndex
   * （MPColors 条目第 4 字段，MO 恰好 = UI索引-1，但非连续配置时必须用真实值）。
   * colorIndex<=0（Random）→ 随机一个具体颜色。
   */
  function resolveGameColor(colorIndex: number): number {
    const count = realMpColors.value.length - 1 // 去掉 Random
    // 合作/挑战图禁用的内部颜色：Random 颜色不能随机到被 AI 占用的（对齐 xna RandomizeColor）
    const disallowed = getDisallowedInternalColors()
    const allColors = Array.from({ length: count }, (_, i) => i)
    const globallyAllowed = allColors.filter((c) => !disallowed.has(c))
    const pickAllowed = (candidates: number[]): number => {
      const allowed = candidates.filter((c) => !disallowed.has(c))
      const pool = allowed.length ? allowed : (globallyAllowed.length ? globallyAllowed : candidates)
      return pool[Math.floor(Math.random() * pool.length)]
    }
    if (colorIndex <= 0) {
      return count > 0 ? pickAllowed(allColors) : 0
    }
    // 用 GameColorIndex（配置缺失时按 UI-1 兜底）
    const direct = realMpColors.value[colorIndex]?.gameColorIndex ?? colorIndex - 1
    if (disallowed.has(direct)) {
      return pickAllowed(allColors)
    }
    return direct
  }

  /**
   * 房主启动前解析所有玩家的随机选项为具体值（阵营 Random/选择器 → 具体阵营，颜色 Random → 空闲颜色）。
   * 广播最终 PO 后全员用同一套解析结果，避免各客户端用无种子 RNG 各自随机导致阵营/颜色不一致。
   * （参考客户端是"同种子各自随机"；我们当房主直接用"房主随机+分发"更稳。）
   */
  function resolveRandomOptions(): void {
    const room = currentRoom.value
    if (!room) return
    const rc = realRandomSelectorCount.value
    const fc = realFactionCount.value
    const disallowed = getDisallowedInternalSides()
    // 具体阵营池（排除地图禁用）
    const concretePool = Array.from({ length: fc }, (_, i) => i).filter((f) => !disallowed.has(f))
    const pickFrom = (pool: number[]): number => pool.length ? pool[Math.floor(Math.random() * pool.length)] : 0
    // 空闲颜色池：去掉已占用的具体颜色（含 AI）
    const usedColors = new Set(room.players.filter((p) => p.colorIndex > 0).map((p) => p.colorIndex))
    const freeColors = realMpColors.value.map((_, i) => i).filter((i) => i > 0 && !usedColors.has(i))

    for (const p of room.players) {
      if (p.isAI) continue
      // 阵营：Random/选择器 → 具体阵营 UI 索引（游戏侧 = ui - rc）
      if (p.factionIndex <= 0 || p.factionIndex < rc) {
        const covered = p.factionIndex <= 0
          ? concretePool
          : (realRandomSelectors.value[sideName(p.factionIndex)] ?? []).filter((f) => !disallowed.has(f))
        const gameSide = pickFrom(covered.length ? covered : concretePool)
        const ui = rc + gameSide
        p.factionIndex = ui
        p.faction = sideName(ui)
      }
      // 颜色：Random → 分配空闲具体颜色
      if (p.colorIndex <= 0) {
        const ci = freeColors.length ? pickFrom(freeColors) : 1
        const at = freeColors.indexOf(ci)
        if (at >= 0) freeColors.splice(at, 1)
        p.colorIndex = ci
        p.color = colorHex(ci)
      }
    }
  }

  /**
   * 合作/挑战地图：把地图 enemyHouses（"side,color,start"，side/color 已是游戏内部索引）转为 AI 配置。
   * 返回 isCoop=false 表示非合作地图。aiLevel 由模式 coopDifficultyLevel 反推（0=困难 1=普通 2=简单）。
   */
  function buildCoopAiConfig(room: RoomDetail): {
    isCoop: boolean
    aiConfig: Array<{ name: string; side: number; color: number; aiLevel: number; waypoint: number }>
    aiCount: number
  } {
    const mapData = realMapsData.value.find((m: any) => m.description === room.map || m.filePath === room.map)
    if (!mapData || mapData.isCoopMission !== true) return { isCoop: false, aiConfig: [], aiCount: 0 }
    const internalMode = realModeNameMap.value[room.gameMode] ?? room.gameMode
    const modeData = realModesData.value.find(
      (m: any) => (m.name || m.uiName) === internalMode || (m.name || m.uiName) === room.gameMode
    )
    const coopDiff = modeData?.coopDifficultyLevel ?? 2
    const aiConfig = (mapData.enemyHouses ?? []).map((raw: string, i: number) => {
      const [side, color, start] = String(raw).split(',').map((x) => parseInt(x.trim(), 10))
      return {
        name: `Computer${i + 1}`,
        side: isNaN(side) ? 0 : side,
        color: isNaN(color) ? 0 : color,
        aiLevel: 3 - coopDiff, // coopDifficulty 直接作为 HouseHandicaps；aiLevel 反推
        waypoint: isNaN(start) ? -1 : start
      }
    })
    return { isCoop: true, aiConfig, aiCount: aiConfig.length }
  }

  /**
   * 构建 multiplayer spawnOptions 并启动游戏（host 和 client 共用）。
   * MO 用 Syringe.exe（Ares 加载器）启动 gamemd，写 spawn.ini 含 [Tunnel]+[Other]。
   */
  async function launchMultiplayer(
    gamePath: string,
    gameId: string,
    modSetId: string,
    room: RoomDetail,
    tunIp: string,
    tunPort: number,
    portsByPlayer: Record<string, number>,
    isHost: boolean,
    sessionId: string
  ): Promise<void> {
    if (!gamePath || !gameId) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', '缺少游戏目录信息，无法启动', 'system'))
      return
    }
    const applyResult = await window.api.playground.apply(gameId, modSetId)
    console.log('[launchMultiplayer] playground 构建结果:', applyResult)
    if (!applyResult.ok || !applyResult.playgroundPath) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', `工作区构建失败: ${applyResult.error ?? ''}`, 'system'))
      return
    }
    const gameDir = applyResult.playgroundPath
    const playerName = useNickname().getNickname()

    // AI 玩家不占隧道端口，也不进 Other 段（对齐 xna：AI 按房屋 ID 写 HouseHandicaps/HouseCountries/HouseColors）
    const humans = room.players.filter((p) => !p.isAI)
    const aiList = room.players.filter((p) => p.isAI)

    // 找"我"的玩家（host 或昵称匹配），取其队伍/起始/阵营/颜色；端口按名字查 START 分配
    const myPlayer = humans.find((p) => p.isHost || p.name === playerName) ?? humans[0]
    const myPort = portsByPlayer[myPlayer?.name ?? ''] ?? 0
    console.log(`[launchMultiplayer] 我=${myPlayer?.name} 阵营索引=${myPlayer?.factionIndex}(名=${myPlayer?.faction}) -> 游戏Side=${resolveInternalSide(myPlayer?.factionIndex ?? 0)} | 颜色索引=${myPlayer?.colorIndex} -> 游戏Color=${resolveGameColor(myPlayer?.colorIndex ?? 0)} | 隧道=${tunIp}:${tunPort} rc=${realRandomSelectorCount.value}`)

    // 其他玩家（人类，排除自己），Ip 一律 0.0.0.0（全走隧道），Port 用各自分配的隧道端口
    // side 用游戏内部阵营索引（对齐 xna InternalSideIndex）
    const otherPlayers = humans
      .filter((p) => p !== myPlayer)
      .map((p) => ({
        name: p.name,
        side: resolveInternalSide(p.factionIndex ?? 0),
        color: resolveGameColor(p.colorIndex ?? 0),
        team: p.teamIndex ?? 0,
        startIndex: p.startIndex ?? 0,
        ip: '0.0.0.0',
        port: portsByPlayer[p.name] ?? 0,
        isSpectator: false
      }))

    // 合作/挑战地图：AI 用地图预设的 enemyHouses（正确阵营/颜色/起点/难度）
    const coop = buildCoopAiConfig(room)
    // AI 玩家配置（普通：难度取玩家表选的 aiLevel；合作：用地图预设，覆盖房间 AI）
    const aiPlayersConfig = coop.isCoop
      ? coop.aiConfig
      : aiList.map((p) => ({
          name: p.name,
          side: resolveInternalSide(p.factionIndex ?? 0),
          color: resolveGameColor(p.colorIndex ?? 0),
          aiLevel: p.aiLevel ?? 2,
          waypoint: p.startIndex ?? -1
        }))

    // 游戏选项 → spawn.ini 设置 + 选项 MapCode 文件（对齐 xna ApplySpawnIniCode/ApplyMapCode）
    const { spawnIniSettings, customIniPaths } = computeLaunchGameOptions(
      allRealCheckboxes.value, realDropdowns.value,
      checkboxValues.value, dropdownValues.value, forcedSpawnIniOptions.value
    )
    // 生成 spawnmap.ini（应用 Map Code；原图只读）
    const spawnMap = await prepareSpawnMap(gameDir, room, customIniPaths)
    if (!spawnMap.ok) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', `生成 spawnmap 失败: ${spawnMap.error ?? ''}`, 'system'))
      return
    }

    // 启动失败必须上报：成功后 host/client 才会继续发 STRTD，失败时不能假装已启动
    const launchResult = await window.api.game.launch({
      gameDir,
      exe: 'Syringe.exe',
      args: ['"gamemd.exe"', '-SPAWN', '-CD', '-SPEEDCONTROL', '-LOG', '-AFFINITY:65535'],
      spawnOptions: {
        mode: 'multiplayer',
        gameDir,
        playerName,
        scenario: 'spawnmap.ini', // 地图由 prepareSpawnMap 生成到 gameDir/spawnmap.ini
        side: resolveInternalSide(myPlayer?.factionIndex ?? 0),
        color: resolveGameColor(myPlayer?.colorIndex ?? 0),
        myTeam: myPlayer?.teamIndex,
        myStart: myPlayer?.startIndex,
        uiGameMode: room.gameMode,
        uiMapName: room.map,
        frameSendRate: room.frameSendRate ?? 3,
        protocol: 2,
        playerCount: humans.length, // PlayerCount = 人类数（对齐 xna Players.Count；AI 只在 AIPlayers）
        aiPlayers: coop.isCoop ? coop.aiCount : aiList.length,
        aiPlayersConfig,
        isCoop: coop.isCoop,
        // Seed 必须与 GO 广播的 RandomSeed 一致（客户端也从 GO 收到同一种子）
        seed: room.randomSeed ?? Math.floor(Math.random() * 99999999),
        isHost,
        gameId: sessionId ? (parseInt(sessionId, 10) || undefined) : undefined,
        port: myPort || undefined,
        tunnel: { ip: tunIp, port: tunPort },
        otherPlayers,
        extraSettings: spawnIniSettings
      }
    })
    console.log('[launchMultiplayer] 启动结果:', launchResult, { customIniPaths })
    if (!launchResult?.ok) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', `游戏启动失败: ${launchResult?.error ?? '未知错误'}`, 'system'))
      return
    }
    lobbyMessages.value.push(genLobbyMsg('system', '系统', '游戏已启动', 'system'))
  }

  /** 启动前生成 spawnmap.ini：解析地图文件 + 应用游戏模式/游戏选项的 Map Code（对齐 xna WriteMap，原图只读） */
  async function prepareSpawnMap(gameDir: string, room: RoomDetail, customIniPaths: string[] = []): Promise<{ ok: boolean; error?: string }> {
    if (!room.map) return { ok: true } // 无地图则跳过
    const mapRelPath = getMapFilePath(room.map)
    const internalMode = realModeNameMap.value[room.gameMode] ?? room.gameMode
    const mode = realModesData.value.find((m: any) => (m.name || m.uiName) === internalMode || (m.name || m.uiName) === room.gameMode)
    const mapCodeIniName = mode?.mapCodeIniName || ''
    // customIniPaths：已生效游戏选项的 MapCode 文件（对齐 xna chkBox.ApplyMapCode / dd.ApplyMapCode）
    const res = await window.api.cncnet.writeSpawnMap(gameDir, mapRelPath, mapCodeIniName, internalMode, customIniPaths)
    console.log('[prepareSpawnMap]', { mapRelPath, mapCodeIniName, internalMode, customIniPaths, res })
    return res ?? { ok: false, error: '生成 spawnmap.ini 失败' }
  }

  /** 只有 1 个人类玩家时：按单人模式（skirmish）启动，无需隧道 */
  async function launchSkirmish(
    gamePath: string,
    gameId: string,
    modSetId: string,
    room: RoomDetail,
    me: RoomPlayer | null,
    aiList: RoomPlayer[]
  ): Promise<void> {
    if (!gamePath || !gameId) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', '缺少游戏目录信息，无法启动', 'system'))
      return
    }
    const applyResult = await window.api.playground.apply(gameId, modSetId)
    if (!applyResult.ok || !applyResult.playgroundPath) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', `工作区构建失败: ${applyResult.error ?? ''}`, 'system'))
      return
    }
    const gameDir = applyResult.playgroundPath
    // 合作/挑战地图：AI 用地图预设的 enemyHouses
    const coop = buildCoopAiConfig(room)
    // 游戏选项 → spawn.ini 设置 + 选项 MapCode 文件（对齐 xna ApplySpawnIniCode/ApplyMapCode）
    const { spawnIniSettings, customIniPaths } = computeLaunchGameOptions(
      allRealCheckboxes.value, realDropdowns.value,
      checkboxValues.value, dropdownValues.value, forcedSpawnIniOptions.value
    )
    // 生成 spawnmap.ini（应用 Map Code；原图只读）
    const spawnMap = await prepareSpawnMap(gameDir, room, customIniPaths)
    if (!spawnMap.ok) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', `生成 spawnmap 失败: ${spawnMap.error ?? ''}`, 'system'))
      return
    }
    const launchResult = await window.api.game.launch({
      gameDir,
      exe: 'Syringe.exe',
      args: ['"gamemd.exe"', '-SPAWN', '-CD', '-SPEEDCONTROL', '-LOG', '-AFFINITY:65535'],
      spawnOptions: {
        mode: 'skirmish',
        gameDir,
        playerName: me?.name ?? useNickname().getNickname(),
        scenario: 'spawnmap.ini', // 地图由 prepareSpawnMap 生成到 gameDir/spawnmap.ini
        side: resolveInternalSide(me?.factionIndex ?? 0),
        color: resolveGameColor(me?.colorIndex ?? 0),
        playerCount: coop.isCoop ? 1 : room.players.length, // coop 的 PlayerCount = 人类数（参考=1）；普通遭遇战保持原样
        aiPlayers: coop.isCoop ? coop.aiCount : aiList.length,
        isCoop: coop.isCoop,
        aiPlayersConfig: coop.isCoop
          ? coop.aiConfig
          : aiList.map((p) => ({
              name: p.name,
              side: resolveInternalSide(p.factionIndex ?? 0),
              color: resolveGameColor(p.colorIndex ?? 0),
              aiLevel: p.aiLevel ?? 2,
              waypoint: p.startIndex ?? -1
            })),
        uiGameMode: room.gameMode,
        uiMapName: room.map,
        extraSettings: spawnIniSettings,
        seed: Math.floor(Math.random() * 99999999)
      }
    })
    console.log('[launchSkirmish] 结果:', launchResult, { customIniPaths })
    if (!launchResult?.ok) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', `游戏启动失败: ${launchResult?.error ?? '未知错误'}`, 'system'))
      return
    }
    lobbyMessages.value.push(genLobbyMsg('system', '系统', '游戏已启动（单人模式）', 'system'))
  }

  /** host 点"开始"：校验锁定/就绪 → 分配隧道端口 → 广播 START（参考格式） → 启动自己 */
  async function hostLaunch(gamePath: string, gameId: string, modSetId: string): Promise<void> {
    if (!currentRoom.value) return
    currentGamePath.value = gamePath
    currentModSetId.value = modSetId
    const room = currentRoom.value

    // 对齐参考：启动前需锁定房间 + 非房主玩家全部就绪
    if (!room.isLocked) {
      pushRoomNotice('请先锁定房间再开始游戏')
      await window.api.cncnet.sendCtcp(room.channelName ?? '', 'LCKGME', '')
      return
    }
    const notReady = room.players.filter((p) => p.id !== 'current' && !p.isReady)
    if (notReady.length > 0) {
      pushRoomNotice(`${notReady.length} 名玩家未准备`)
      await window.api.cncnet.sendCtcp(room.channelName ?? '', 'GETREADY', '')
      return
    }

    // launcher ban 随机：对每个随机/选择器阵营，从"覆盖 − 禁用(玩家ban + 地图禁用)"里随机选具体阵营，PO 广播给全员
    if (isAllLauncher()) {
      const mapDisallowed = getDisallowedInternalSides()
      const globalAllowed = Array.from({ length: realFactionCount.value }, (_, i) => i)
        .filter((f) => !mapDisallowed.has(f))
      for (const p of room.players) {
        const covered = coveredFactionsForSide(p.faction)
        if (covered.length === 0) continue // 具体阵营，无需解析
        const banned = new Set(p.bannedFactions ?? [])
        const allowed = covered.filter((f) => !banned.has(f) && !mapDisallowed.has(f))
        // 覆盖全禁（含玩家 ban + 地图禁用）→ 回退全局可用；全部禁用才保持原随机侧
        const pool = allowed.length ? allowed : globalAllowed
        if (pool.length === 0) continue
        const chosen = pool[Math.floor(Math.random() * pool.length)]
        const factionName = realSides.value[realRandomSelectorCount.value + chosen]?.name
        if (!factionName) continue
        p.faction = factionName
        p.factionIndex = sideIndex(factionName)
      }
      broadcastPlayerOptions()
    }

    // 只给人类玩家分配隧道端口（AI 不联机）
    const humanPlayers = room.players.filter((p) => !p.isAI)
    const aiList = room.players.filter((p) => p.isAI)

    // 只有 1 个人类玩家 → 启动单人模式（skirmish，无需隧道）
    if (humanPlayers.length < 2) {
      await launchSkirmish(gamePath, gameId, modSetId, room, humanPlayers[0] ?? null, aiList)
      return
    }

    // 隧道必须由房主在房间里明确选定（全员共用同一个服务器）；没选不给启动
    if (!selectedTunnel.value) {
      pushRoomNotice('请先在"选择服务器"里选定一个隧道服务器')
      return
    }
    // 房主随机选项：把所有玩家 Random/选择器阵营、Random 颜色解析为具体值，广播最终 PO
    resolveRandomOptions()
    broadcastPlayerOptions()
    // 选隧道时发的 CHTNL 可能早于客户端加入（空房间没人收），启动前再广播一次确保全员 CurrentTunnel 正确
    window.api.cncnet.sendCtcp(room.channelName ?? '', 'CHTNL', selectedTunnel.value)
    const r = await window.api.cncnet.hostStart(room.channelName ?? '', humanPlayers.map((p) => ({ name: p.name })), selectedTunnel.value)
    console.log('[hostLaunch] hostStart 结果:', r)
    if (!r.ok || !r.tunnel) {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', `启动失败: ${r.error ?? '隧道分配失败'}`, 'system'))
      return
    }
    const [tunIp, tunPortStr] = r.tunnel.split(':')
    // 玩家名 → 分配的隧道端口（r.ports 与 humanPlayers 一一对应，可能是 address:port 或纯 port）
    const portsByPlayer: Record<string, number> = {}
    humanPlayers.forEach((p, i) => {
      portsByPlayer[p.name] = parseInt(r.ports?.[i]?.split(':').pop() ?? '0', 10) || 0
    })
    await launchMultiplayer(gamePath, gameId, modSetId, room, tunIp, parseInt(tunPortStr, 10) || 0, portsByPlayer, true, r.gameId ?? '')
    // 进入游戏信号
    await window.api.cncnet.sendCtcp(room.channelName ?? '', 'STRTD', '')
  }

  /** 客户端收到 host 的 START：解析隧道/端口 → 启动游戏 */
  async function clientLaunch(data: { data: string }): Promise<void> {
    lobbyMessages.value.push(genLobbyMsg('system', '系统', '游戏正在启动...', 'system'))
    if (!currentRoom.value) return
    const room = currentRoom.value

    // 参考格式：START <UniqueGameID>;<name>;<tunnelAddress:assignedPort>;<name>;<...>
    const parts = (data.data || '').split(';')
    const sessionId = parts[0] ?? ''
    const portsByPlayer: Record<string, number> = {}
    let tunIp = ''
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const ipPort = parts[i + 1].split(':')
      tunIp = tunIp || (ipPort[0] ?? '')
      portsByPlayer[parts[i]] = parseInt(ipPort[ipPort.length - 1], 10) || 0
    }

    // START 里隧道可能是 0.0.0.0（房主隧道分配失败/未选隧道）→ 回退到房间广播（GAME）的隧道
    if (!tunIp || tunIp === '0.0.0.0') {
      tunIp = room.tunnelServer ? room.tunnelServer.split(':')[0] : ''
    }

    // 隧道控制端口：按地址从隧道列表解析（客户端不是房主，getHostedGame 拿不到）
    let tunPort = 0
    try {
      const tunnels = await window.api.tunnel.servers()
      const t = tunnels?.find((x) => x.address === tunIp)
      tunPort = t?.port ?? 0
    } catch { /* 无隧道列表 */ }

    console.log(`[clientLaunch] START=${data.data} START隧道=${tunIp} 房间广播隧道=${room.tunnelServer} -> 最终=${tunIp}:${tunPort}`)
    await launchMultiplayer(currentGamePath.value, currentGameId.value, currentModSetId.value, room, tunIp, tunPort, portsByPlayer, false, sessionId)
    // 进入游戏信号
    await window.api.cncnet.sendCtcp(room.channelName ?? '', 'STRTD', '')
  }

  // ─── 房间操作 ──────────────────────────────────────────

  async function fetchRooms(gameId: string): Promise<void> {
    isLoading.value = true

    if (window.api?.cncnet) {
      // 确保频道已加入（同一游戏重复 join 不再清空房间，只是重新 JOIN 补漏）
      await window.api.cncnet.joinChannel(gameId)

      // 读取主进程当前已知的房间列表（即时返回，不用等广播重收）
      try {
        const existingRooms = await window.api.cncnet.getRooms()
        if (existingRooms && Array.isArray(existingRooms)) {
          rooms.value = existingRooms.map((r: any) => cncnetRoomToRoom(r))
          onlineCount.value = rooms.value.length
        }
      } catch {
        // ignore
      }
    }

    isLoading.value = false
  }

  async function createRoom(params: CreateRoomParams): Promise<Room> {
    const { getNickname } = useNickname()
    const nickname = getNickname()

    let mapFilePath = ''
    // params.map 是地图显示名（来自 getMaps()），在完整地图数据里找对应文件路径
    // 地图哈希由主进程 createRoom 用文件内容 SHA1 计算，这里不需要
    const map = realMapsData.value.find((m: any) => m.description === params.map || m.filePath === params.map)
    if (map) {
      mapFilePath = map.filePath || map.baseFilePath
    }
    // 初始一致性：地图与模式必须兼容（CreateRoomModal 用 maps[0]/gameModes[0]，可能是挑战图+标准模式）
    if (map?.gameModes?.length) {
      const internalMode = realModeNameMap.value[params.gameMode] ?? params.gameMode
      if (!map.gameModes.includes(internalMode)) {
        const target = realModesData.value.find((m: any) => map.gameModes.includes(m.name))
        if (target) params.gameMode = target.uiName || target.name
      }
    }

    if (window.api?.cncnet) {
      try {
        const result = await window.api.cncnet.createRoom({
          roomName: params.name,
          maxPlayers: params.maxPlayers,
          map: params.map,
          mapFilePath,
          gameMode: params.gameMode,
          password: params.password
        })

        const room: Room = {
          // 主进程 createRoom 生成的 roomId 是 cncnet_${channelName}，
          // 必须一致，否则 onRoomUpdated/room-removed 匹配不上（列表重复/不消失）
          id: result.roomId,
          name: params.name,
          host: nickname,
          hostId: 'current',
          gameId: params.gameId,
          gameMode: params.gameMode,
          map: params.map,
          mapFilePath,
          mapHash: result.mapHash ?? '',
          // 随机种子：创建房间时生成一次，GO 广播 + 启动 spawn.ini 用它，保证全员一致
          randomSeed: Math.floor(Math.random() * 99999999),
          maxPlayers: params.maxPlayers,
          currentPlayers: 1,
          hasPassword: !!params.password,
          isLocked: false,
          status: 'waiting',
          createdAt: Date.now(),
          channelName: result.channelName,
          channelPassword: result.channelPassword
        }
        rooms.value.unshift(room)
        currentRoom.value = { ...room, players: [makePlayer('current', nickname, true)] }
        roomMessages.value = [
          genMsg(room.id, 'system', '系统', `房间「${room.name}」已创建，等待玩家加入...`, 'system')
        ]
        chatMode.value = 'room'
        sendLauncherHandshake()
        startPingLoop()
        return room
      } catch (err: any) {
        throw new Error(`创建房间失败: ${err.message}`)
      }
    }

    throw new Error('未连接 CnCNet，无法创建房间')
  }

  async function joinRoom(room: Room, password?: string): Promise<{ ok: boolean; error?: string }> {
    if (room.status === 'in-game') {
      return { ok: false, error: '游戏已开始，无法加入' }
    }
    if (room.currentPlayers >= MAX_PLAYERS) {
      return { ok: false, error: `房间已满（最多 ${MAX_PLAYERS} 人）` }
    }
    if (room.currentPlayers >= room.maxPlayers) {
      return { ok: false, error: '房间已满' }
    }

    if (window.api?.cncnet) {
      try {
        // channelName 优先；回退到 id 时去掉 cncnet_ 前缀
        const channelName = room.channelName || room.id.replace(/^cncnet_/, '')
        const game = {
          channelName,
          mapFilePath: room.mapFilePath || '',
          mapHash: '00000000000000000000000000000000'
        }
        await window.api.cncnet.joinRoom(game, password)

        room.currentPlayers++
        const { getNickname } = useNickname()
        const nickname = getNickname()
        // 立即用广播里的玩家名列表建玩家表（等 NAMES 回执前就能看到其他成员）
        const nameList = Array.isArray(room.players) ? room.players.filter((p): p is string => typeof p === 'string') : []
        // 房主 = 广播的 host 名（不是列表第一个人，NAMES 顺序不保证房主在前）
        const players: RoomPlayer[] = nameList.map((name, i) => makePlayer(
          name === nickname ? 'current' : `irc_${name.toLowerCase()}`,
          name,
          name === room.host,
          name === nickname ? undefined : ''
        ))
        // 广播里的玩家列表不含"我"（加入前 host 还没把我广播出去），手动补上自己
        if (!nameList.includes(nickname)) {
          players.push(makePlayer('current', nickname, nickname === room.host))
        }
        if (players.length === 0) players.push(makePlayer(room.hostId, room.host, true))
        currentRoom.value = { ...room, players }
        roomMessages.value = [
          genMsg(room.id, 'system', '系统', `${room.host} 创建了房间`, 'system'),
          genMsg(room.id, 'current', nickname, `${nickname} 加入了房间`, 'join')
        ]
        chatMode.value = 'room'
        sendLauncherHandshake()
        startPingLoop()
        return { ok: true }
      } catch (err: any) {
        return { ok: false, error: err.message || '加入失败' }
      }
    }

    return { ok: false, error: '未连接 CnCNet' }
  }

  async function leaveRoom(): Promise<void> {
    const leavingRoom = currentRoom.value
    if (!leavingRoom) return

    if (window.api?.cncnet) {
      try {
        await window.api.cncnet.leaveRoom()
      } catch {
        // ignore
      }
    }

    // await 期间 currentRoom 可能被事件清空，用进入时的引用
    const room = rooms.value.find(r => r.id === leavingRoom.id)
    if (room && room.currentPlayers > 0) room.currentPlayers--
    stopPingLoop()
    currentRoom.value = null
    roomMessages.value = []
    chatMode.value = 'lobby'
  }

  // ─── 房主：添加 AI / 踢出 / 封禁 ────────────────────

  /** 房主添加一个 AI 玩家（本地加入 + 广播 PO 同步全员）；玩家总数上限 8 */
  function addAiPlayer(): void {
    const room = currentRoom.value
    if (!room) return
    if (!room.players.some((p) => p.id === 'current' && p.isHost)) {
      pushRoomNotice('只有房主可以添加 AI')
      return
    }
    if (room.players.length >= MAX_PLAYERS) {
      pushRoomNotice(`玩家总数已达上限 ${MAX_PLAYERS} 人`)
      return
    }
    const aiCount = room.players.filter((p) => p.isAI).length
    const aiName = `Computer${aiCount + 1}`
    const ai = makePlayer(`ai-${Date.now()}`, aiName, false)
    ai.isAI = true
    ai.isReady = true
    ai.aiLevel = 2 // 默认普通（1=简单 2=普通 3=困难）
    room.players.push(ai)
    broadcastPlayerOptions()
    pushRoomNotice(`已添加 AI 玩家 ${aiName}`)
  }

  /** 房主踢出玩家：IRC KICK + 本地移除 + 广播 PO */
  function kickPlayer(playerId: string): void {
    const room = currentRoom.value
    if (!room) return
    // 防御：只有房主能踢人
    if (!room.players.some((p) => p.id === 'current' && p.isHost)) {
      pushRoomNotice('只有房主可以踢人')
      return
    }
    const player = room.players.find((p) => p.id === playerId)
    if (!player || player.isHost || player.isAI) return
    window.api?.cncnet?.kick(room.channelName ?? '', player.name)
    room.players = room.players.filter((p) => p.id !== playerId)
    broadcastPlayerOptions()
    pushRoomNotice(`已踢出 ${player.name}`)
  }

  /** 房主封禁玩家：MODE +b + KICK + 本地移除 + 广播 PO */
  function banPlayer(playerId: string): void {
    const room = currentRoom.value
    if (!room) return
    // 防御：只有房主能封禁
    if (!room.players.some((p) => p.id === 'current' && p.isHost)) {
      pushRoomNotice('只有房主可以封禁玩家')
      return
    }
    const player = room.players.find((p) => p.id === playerId)
    if (!player || player.isHost || player.isAI) return
    window.api?.cncnet?.ban(room.channelName ?? '', player.name)
    room.players = room.players.filter((p) => p.id !== playerId)
    broadcastPlayerOptions()
    pushRoomNotice(`已封禁并踢出 ${player.name}`)
  }

  // 更新玩家属性（改自己 → 发 OR；房主改别人 → PO 广播，对齐参考）
  function updatePlayerAttr(playerId: string, attr: Partial<Pick<RoomPlayer, 'color' | 'faction' | 'team' | 'startIndex' | 'aiLevel'>>): void {
    if (!currentRoom.value) return
    const player = currentRoom.value.players.find(p => p.id === playerId)
    if (!player) return
    Object.assign(player, attr)
    if (attr.faction !== undefined) player.factionIndex = sideIndex(attr.faction)
    if (attr.color !== undefined) player.colorIndex = colorIndex(attr.color)
    if (attr.team !== undefined) player.teamIndex = teamIndex(attr.team)
    if (attr.startIndex !== undefined) player.startIndex = attr.startIndex
    if (attr.aiLevel !== undefined) player.aiLevel = attr.aiLevel
    const isHost = currentRoom.value.players.some(p => p.id === 'current' && p.isHost)
    // 房主改任何人（含自己）→ PO 广播全员（原版客户端非房主只认 PO，不处理 OR）；
    // 非房主改自己 → OR 通知房主。顺序必须先判 isHost，否则房主改自己会误发 OR。
    if (isHost) {
      broadcastPlayerOptions()
    } else if (player.id === 'current') {
      window.api.cncnet.sendCtcp(currentRoom.value.channelName ?? '', 'OR', String(packOrRequest(player)))
    }
  }

  /** 本地系统消息（命令确认/提示），房间内输出到房间聊天栏，否则进大厅聊天 */
  function pushSystemMsg(content: string): void {
    if (chatMode.value === 'room' && currentRoom.value) {
      roomMessages.value.push(genMsg(currentRoom.value.id, 'system', '系统', content, 'system'))
    } else {
      lobbyMessages.value.push(genLobbyMsg('system', '系统', content, 'system'))
    }
  }

  /** 实际发送一条聊天消息到当前目标，并本地回显（IRC 不会把自己的消息回传给自己） */
  async function sendRaw(content: string): Promise<void> {
    const text = content.trim()
    if (!text) return
    if (!window.api?.cncnet) return

    const { getNickname } = useNickname()
    const nickname = getNickname()
    // 发送时带 \x03NN 颜色前缀（对齐原版客户端），本地回显用干净文本
    const colorPrefix = `\x03${String(chatColorToIrcId(chatColorHex.value)).padStart(2, '0')}`

    if (chatMode.value === 'lobby') {
      // 大厅聊天频道应来自当前连接的游戏，而不是"房间列表第一项"——
      // 列表为空时第一项不存在（消息被静默丢弃），列表首项属于别的游戏时还会发错频道。
      const gameId = currentGameId.value || rooms.value[0]?.gameId
      if (gameId) {
        const config = { 'mental-omega': 'mo', 'zero-hour': 'yr' }
        const channel = `#cncnet-${config[gameId as keyof typeof config] ?? 'yr'}`
        await window.api.cncnet.sendMessage(channel, colorPrefix + text)
        lobbyMessages.value.push(genLobbyMsg('current', nickname, text))
      }
    } else if (chatMode.value === 'room' && currentRoom.value) {
      const channel = currentRoom.value.channelName || currentRoom.value.id
      await window.api.cncnet.sendMessage(channel, colorPrefix + text)
      roomMessages.value.push(genMsg(currentRoom.value.id, 'current', nickname, text))
    } else if (chatMode.value === 'private' && privateTarget.value) {
      await window.api.cncnet.sendMessage(privateTarget.value.userId, colorPrefix + text)
      const list = privateMessages.value.get(privateTarget.value.userId) ?? []
      list.push(genMsg(privateTarget.value.userId, 'current', nickname, text))
      privateMessages.value.set(privateTarget.value.userId, list)
    }
  }

  /** 解析 NdS 骰子表达式（支持 3d6 / d6），返回骰子数/面数/各次结果/总和（限制对齐参考：1-10 颗、2-100 面） */
  function rollDiceResult(expr: string): { count: number; sides: number; rolls: number[]; total: number } | null {
    const m = expr.toLowerCase().match(/^(\d*)d(\d+)$/)
    if (!m) return null
    const count = m[1] ? Math.max(1, Math.min(parseInt(m[1], 10) || 1, 10)) : 1
    const sides = Math.max(2, Math.min(parseInt(m[2], 10) || 6, 100))
    const rolls: number[] = []
    let total = 0
    for (let i = 0; i < count; i++) {
      const r = 1 + Math.floor(Math.random() * sides)
      rolls.push(r)
      total += r
    }
    return { count, sides, rolls, total }
  }

  /** 斜杠命令处理：/roll、/framesendrate；未知命令列可用命令（对照参考 ChatBoxCommand 帮助行为） */
  async function handleSlashCommand(raw: string): Promise<void> {
    const spaceIdx = raw.indexOf(' ')
    const cmd = (spaceIdx === -1 ? raw.slice(1) : raw.slice(1, spaceIdx)).toLowerCase()
    const params = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim()

    if (cmd === 'roll') {
      const result = rollDiceResult(params || '1d6')
      if (!result) {
        pushSystemMsg('掷骰子格式错误，示例: /roll 3d6')
        return
      }
      const { getNickname } = useNickname()
      const nick = getNickname()
      // 用 XNA 的 DR 命令广播：DR <面数>,<结果1>,<结果2>...（对齐参考 BroadcastDiceRoll）
      if (currentRoom.value?.channelName) {
        await window.api.cncnet.sendCtcp(currentRoom.value.channelName, 'DR', `${result.sides},${result.rolls.join(',')}`)
      }
      // 自己也能看到结果（IRC 不回声给自己）
      pushRollResult(nick, result.sides, result.rolls)
      return
    }

    if (cmd === 'framesendrate') {
      const n = parseInt(params, 10)
      if (isNaN(n) || n < 0 || n > 10) {
        pushSystemMsg('语法: /framesendrate <0-10>')
        return
      }
      if (!currentRoom.value) {
        pushSystemMsg('需在房间内设置帧发送率')
        return
      }
      const isHost = currentRoom.value.players?.some((p) => (p as any).id === 'current' && (p as any).isHost) ?? false
      if (!isHost) {
        pushSystemMsg('仅房主可设置帧发送率')
        return
      }
      currentRoom.value.frameSendRate = n
      pushSystemMsg(`FrameSendRate 已改为 ${n}`)
      // FrameSendRate 走完整 GO 广播同步（对齐 XNA —— GO 字段里带 FrameSendRate，无需自定义 FSR 命令）
      broadcastGameOptions()
      return
    }

    pushSystemMsg(`未知命令 /${cmd}。可用命令: /roll <NdS>、/framesendrate <0-10>`)
  }

  // 发送消息：/ 开头走命令，否则作为聊天发送（带本地回显）
  async function sendMessage(content: string): Promise<void> {
    const text = content.trim()
    if (!text) return
    if (text.startsWith('/')) {
      await handleSlashCommand(text)
      return
    }
    await sendRaw(text)
  }

  async function fetchFriends(): Promise<void> {
    friends.value = []
  }

  async function toggleReady(): Promise<void> {
    if (!currentRoom.value) return
    const me = currentRoom.value.players.find(p => p.id === 'current')
    if (!me) return
    me.isReady = !me.isReady
    pushRoomNotice(`${me.name} ${me.isReady ? '已准备' : '取消准备'}`)
    await window.api.cncnet.sendCtcp(currentRoom.value.channelName ?? '', 'R', me.isReady ? '1' : '0')
  }

  // 房主换图 → 更新本地 + 主进程 hostedGame（重广播 GAME 让大厅刷新）+ 广播 GO 让房间成员刷新
  /**
   * 把模式/地图的强制选项（chkXxx/cmbXxx 混在一个 Record）应用到勾选/下拉状态，
   * 这样启动时 computeLaunchGameOptions 写进 spawn.ini 的就是模式/地图要求的值。
   */
  function applyForcedOptions(forced: Record<string, string>): void {
    if (!forced) return
    for (const [name, val] of Object.entries(forced)) {
      const cb = allRealCheckboxes.value.find((c) => c.name === name)
      if (cb) {
        const v = String(val).toLowerCase()
        checkboxValues.value[name] = v === 'true' || v === 'yes' || v === '1'
        continue
      }
      const dd = realDropdowns.value.find((d) => d.name === name)
      if (dd) {
        const idx = parseInt(String(val), 10)
        if (!isNaN(idx)) dropdownValues.value[name] = idx
      }
    }
  }

  async function updateMap(map: string, mapHash?: string): Promise<void> {
    if (!currentRoom.value) return
    // L-MAP 点击切换跨语言：带 hash 时按 hash 解析本地图（请求方图名可能和本地不同）
    if (mapHash && currentGamePath.value) {
      try {
        const local = await window.api.maps.findByHash(currentGamePath.value, mapHash)
        if (local?.description) map = local.description
      } catch { /* 解析失败用请求名 */ }
    }
    currentRoom.value.map = map
    pushRoomNotice(`房主将地图改为 ${map}`)
    const room = currentRoom.value
    const mapData = realMapsData.value.find((m: any) => m.description === map || m.filePath === map)
    // 选挑战/合作图时自动切换兼容模式（否则 map code 用错、coop 难度用默认 → 生成结果不对）
    if (mapData?.gameModes?.length) {
      const internalMode = realModeNameMap.value[room.gameMode] ?? room.gameMode
      if (!mapData.gameModes.includes(internalMode)) {
        const target = realModesData.value.find((m: any) => mapData.gameModes.includes(m.name))
        if (target) {
          const newName = target.uiName || target.name
          if (newName !== room.gameMode) {
            room.gameMode = newName
            pushRoomNotice(`模式已切换为 ${newName}（该地图需要）`)
            await window.api.cncnet.updateMode(newName) // 同步房间列表 GAME 广播（等待完成，避免和后续 flush 竞争）
            // 不在这里发 GO：等 setHostedMap 拿到新 mapHash 后统一发一次，避免客户端按旧 hash 找新图报"没有这张图"
          }
        }
      }
    }
    // 应用强制选项：先模式后地图（地图覆盖，对齐 xna GameMode.ApplySpawnIniCode → Map.ApplySpawnIniCode 顺序）
    const curInternal = realModeNameMap.value[room.gameMode] ?? room.gameMode
    const curMode = realModesData.value.find(
      (m: any) => (m.name || m.uiName) === curInternal || (m.name || m.uiName) === room.gameMode
    )
    applyForcedOptions(curMode?.forcedCheckBoxValues)
    applyForcedOptions(mapData?.forcedOptions)
    const rc = realRandomSelectorCount.value
    const disSides = mapData?.disallowedPlayerSides ?? []
    const disColors = mapData?.disallowedPlayerColors ?? []
    if (disSides.length || disColors.length) {
      const allowedSide = (() => {
        for (let i = rc; i < rc + realFactionCount.value; i++) {
          if (!disSides.includes(i - rc)) return i
        }
        return rc
      })()
      const allowedColor = (() => {
        for (let i = 1; i < realMpColors.value.length; i++) {
          if (!disColors.includes(i - 1)) return i
        }
        return 1
      })()
      let changed = false
      for (const p of room.players) {
        if (p.isAI) continue
        if (disSides.includes(p.factionIndex - rc)) {
          p.faction = sideName(allowedSide)
          p.factionIndex = allowedSide
          changed = true
        }
        if (disColors.includes(p.colorIndex - 1)) {
          p.color = colorHex(allowedColor)
          p.colorIndex = allowedColor
          changed = true
        }
      }
      if (changed) {
        pushRoomNotice('地图禁用的阵营/颜色已被重置')
        broadcastPlayerOptions()
      }
    }
    // 同步主进程托管房间的地图（否则大厅房间列表一直显示旧图），并拿到新 hash
    const mapFilePath = getMapFilePath(map) || map
    const res = await window.api?.cncnet?.updateMap(map, mapFilePath)
    if (res?.mapHash && currentRoom.value) currentRoom.value.mapHash = res.mapHash
    // GO 延迟到 GAME（节流 1.5s）之后发，原版客户端先收 GAME 再收 GO，不报"不存在的图"；连续变更合并为一次，不 flood
    scheduleRoomGo()
  }
  async function updateGameMode(mode: string): Promise<void> {
    if (!currentRoom.value) return
    const room = currentRoom.value
    room.gameMode = mode
    pushRoomNotice(`房主将模式改为 ${mode}`)
    // 同步主进程 hostedGame：房间列表的 GAME 广播要显示新模式
    await window.api.cncnet.updateMode(mode)
    const internalMode = realModeNameMap.value[mode] ?? mode
    // 应用模式的强制选项（挑战/合作会强制 chkShortGame/cmbCredits 等）
    const modeData = realModesData.value.find(
      (m: any) => (m.name || m.uiName) === internalMode || (m.name || m.uiName) === mode
    )
    applyForcedOptions(modeData?.forcedCheckBoxValues)
    // 当前地图不兼容新模式 → 自动换到兼容图（否则 map code 用错）
    const mapData = realMapsData.value.find((m: any) => m.description === room.map || m.filePath === room.map)
    // 模式不变图时也应用当前地图的强制选项（模式覆盖后再地图覆盖，对齐 xna 顺序）
    if (mapData?.gameModes?.length && mapData.gameModes.includes(internalMode)) {
      applyForcedOptions(mapData.forcedOptions)
    }
    if (mapData?.gameModes?.length && !mapData.gameModes.includes(internalMode)) {
      const compatible = getMapsForMode(mode)
      const target = compatible.find((m) => m !== room.map) ?? compatible[0]
      if (target) {
        pushRoomNotice(`当前地图不适合该模式，已切换为 ${target}`)
        await updateMap(target) // updateMap 内部已广播 GO，这里不再重复发
        return
      }
    }
    // GO 延迟到 GAME 之后发（防 flood + 保证 GAME 先到），连续变更合并
    scheduleRoomGo()
  }

  /** 房主锁定/解锁房间（MODE ±i） */
  async function toggleLock(): Promise<void> {
    if (!currentRoom.value?.channelName) return
    const locked = !currentRoom.value.isLocked
    currentRoom.value.isLocked = locked
    pushRoomNotice(locked ? '房间已锁定' : '房间已解锁')
    await window.api.cncnet.lock(currentRoom.value.channelName, locked)
  }

  // ─── launcher 专属：握手 + ban 随机阵营 ───

  /** 进入房间后发送 L-HI，确认双方都是 launcher（ban 功能前提） */
  function sendLauncherHandshake(): void {
    const room = currentRoom.value
    if (!room?.channelName) return
    launcherPlayers.add(useNickname().getNickname())
    window.api.cncnet.sendChatCommand(room.channelName, 'L-HI', LAUNCHER_VERSION)
  }

  /** 更新"我"的禁用随机阵营清单并发给主机 */
  function setMyBannedFactions(indices: number[]): void {
    const room = currentRoom.value
    const me = room?.players.find((p) => p.id === 'current')
    if (!room?.channelName || !me) return
    me.bannedFactions = indices
    window.api.cncnet.sendChatCommand(room.channelName, 'L-BAN', indices.join(','))
  }

  /** 非房主请求想玩某张图（发 L-MAP 给房间，房主可点击切换） */
  function requestMap(mapName: string): void {
    if (!currentRoom.value?.channelName || !mapName) return
    window.api.cncnet.sendChatCommand(currentRoom.value.channelName, 'L-MAP', mapName)
  }

  // 房主选中的隧道（address:port）
  const selectedTunnel = ref('')

  /** 广播本机对房间当前隧道的延迟（L-PING）。全队用同一个隧道（房主选中的）。 */
  async function broadcastMyPing(): Promise<void> {
    const room = currentRoom.value
    if (!room?.channelName) return
    // 房间当前隧道：房主选中的，否则房间广播里的隧道地址
    let address = selectedTunnel.value || room.tunnelServer || ''
    let ping = -1
    try {
      const list = (await window.api.tunnel.servers()) ?? []
      let t = address ? list.find((x) => `${x.address}:${x.port}` === address) : undefined
      if (t) {
        if (t.latency < Number.MAX_SAFE_INTEGER) ping = t.latency
      }
    } catch { /* 忽略 */ }
    if (address) {
      window.api.cncnet.sendChatCommand(room.channelName, 'L-PING', `${address};${ping}`)
    }
  }

  /** 房主选择隧道服务器：记住选中 + 重广播（全队用同一个）+ 立即广播 L-PING */
  async function selectTunnel(address: string): Promise<void> {
    selectedTunnel.value = address
    if (currentRoom.value) currentRoom.value.tunnelServer = address
    // 更新主进程托管房间的隧道并重新广播 GAME，其他玩家才能看到/用同一个隧道
    await window.api.cncnet.setTunnel(address)
    // 参考协议：房主换隧道广播 CHTNL <address:port>，官方客户端据此更新 CurrentTunnel
    //（它不靠 GAME/START 换隧道，不发的话对方 spawn.ini 一直是旧隧道）
    window.api.cncnet.sendCtcp(currentRoom.value?.channelName ?? '', 'CHTNL', address)
    await broadcastMyPing()
    pushRoomNotice(`已选择服务器 ${address}`)
  }

  // 房间内每 30s 广播一次 L-PING（进房间/切服务器时额外各一次）
  let pingLoopTimer: ReturnType<typeof setInterval> | null = null
  function startPingLoop(): void {
    stopPingLoop()
    void broadcastMyPing()
    pingLoopTimer = setInterval(() => void broadcastMyPing(), 30_000)
  }
  function stopPingLoop(): void {
    if (pingLoopTimer) {
      clearInterval(pingLoopTimer)
      pingLoopTimer = null
    }
  }

  function switchToLobby(): void {
    chatMode.value = 'lobby'
    privateTarget.value = null
  }

  function switchToRoom(): void {
    if (currentRoom.value) {
      chatMode.value = 'room'
      privateTarget.value = null
    }
  }

  function startPrivateChat(userId: string, userName: string): void {
    chatMode.value = 'private'
    privateTarget.value = { userId, userName }
  }

  function stopPrivateChat(): void {
    chatMode.value = 'lobby'
    privateTarget.value = null
  }

  function getModSets(): Array<{ id: string; name: string }> {
    return []
  }

  // Real map/mode data loaded from INI
  // 完整地图数据（含 gameModes 等元信息）
  const realMapsData = ref<any[]>([])
  const realMaps = ref<string[]>([])
  const realGameModes = ref<string[]>([])
  const realModeUiNameMap = ref<Record<string, string>>({}) // internalName -> uiName
  const realMapFilePaths = ref<Record<string, string>>({})

  async function loadRealData(gamePath: string): Promise<void> {
    try {
      const api = (window as any).api
      const [mapsData, modesData] = await Promise.all([
        api.maps.load(gamePath),
        api.gameMode.load(gamePath)
      ])
      realModesData.value = modesData
      realMapsData.value = mapsData
      realMaps.value = mapsData.map((m: any) => m.description || m.filePath.split(/[/\\]/).pop())
      realGameModes.value = modesData.map((m: any) => m.uiName || m.name)
      // 建立 uiName -> internalName 映射
      const nameMap: Record<string, string> = {}
      for (const m of modesData) {
        nameMap[m.uiName || m.name] = m.name
      }
      realModeNameMap.value = nameMap
      const uiMap: Record<string, string> = {}
      for (const m of modesData) {
        uiMap[m.name] = m.uiName || m.name
      }
      realModeUiNameMap.value = uiMap
      const lookup: Record<string, string> = {}
      for (const m of mapsData) {
        const displayName = m.description || m.filePath.split(/[/\\]/).pop()
        lookup[displayName] = m.baseFilePath || m.filePath
      }
      realMapFilePaths.value = lookup
      // 阵营/颜色映射 + 游戏选项（房间内 OR/PO 打包 + 完整 GO）
      try {
        const opts = await api.mpLobbyOptions.load(gamePath)
        realSides.value = opts.sides
        realMpColors.value = opts.mpColors
        realDropdowns.value = opts.dropdowns
        allRealCheckboxes.value = opts.checkboxes
        realCheckboxes.value = opts.checkboxes.filter((c: any) => c.visible)
        const dv: Record<string, number> = {}
        for (const dd of opts.dropdowns) dv[dd.name] = dd.defaultIndex
        dropdownValues.value = dv
        const cv: Record<string, boolean> = {}
        for (const cb of opts.checkboxes) cv[cb.name] = cb.checked
        checkboxValues.value = cv
        realRandomSelectors.value = opts.randomSelectors ?? {}
        realRandomSelectorCount.value = opts.randomSelectorCount ?? 1
        realFactionCount.value = opts.factionCount ?? 0
        forcedSpawnIniOptions.value = opts.forcedSpawnIniOptions ?? {}
      } catch { /* 无阵营/颜色数据时用默认 */ }
    } catch (e) {
      console.error('loadRealData failed:', e)
    }
  }

  /** 根据游戏模式名过滤地图列表 */
  function getMapsForMode(modeUiName: string): string[] {
    try {
      if (!realMapsData.value.length) return []
      const internalName = realModeNameMap.value[modeUiName] ?? modeUiName
      console.log('[getMapsForMode] uiName:', modeUiName, '-> internal:', internalName)
      console.log('[getMapsForMode] modeNameMap:', JSON.stringify(realModeNameMap.value))
      const totalMaps = realMapsData.value.length
      const matched = realMapsData.value.filter((m: any) => {
        if (!m.gameModes?.length) return true
        return m.gameModes.includes(internalName)
      })
      console.log('[getMapsForMode] matched:', matched.length, 'of', totalMaps)
      return matched.map((m: any) => m.description || m.filePath.split(/[/\\]/).pop())
    } catch (e) {
      console.error('[getMapsForMode] error:', e)
      return realMaps.value
    }
  }

  function getMaps(): string[] { return realMaps.value }
  function getGameModes(): string[] { return realGameModes.value }
  function getMapFilePath(displayName: string): string { return realMapFilePaths.value[displayName] ?? displayName }

  /** 广播的模式内部名/UI 名 → 显示名（兼容两种形式，解析不到回退原文） */
  function getGameModeUiName(raw: string): string {
    if (!raw) return '未知'
    // 已是 UI 名（uiName -> internal 映射里能查到 key）
    if (realModeNameMap.value[raw]) return raw
    return realModeUiNameMap.value[raw] ?? raw
  }

  /** 地图路径/显示名 → 本地显示名（从已加载地图元数据解析，回退文件名/原文） */
  function getMapDisplayName(pathOrName: string): string {
    if (!pathOrName) return '未知'
    const m = realMapsData.value.find((x: any) =>
      (x.baseFilePath || x.filePath) === pathOrName || x.description === pathOrName)
    return m?.description || pathOrName.split(/[/\\]/).pop() || pathOrName
  }

  /** 房主随机选图：按人数从当前模式的地图里随机一张（minPlayers<=n<=maxPlayers） */
  function getRandomMapForCount(count: number): string {
    const mode = currentRoom.value?.gameMode ?? ''
    const internalMode = realModeNameMap.value[mode] ?? mode
    const candidates = realMapsData.value.filter((m: any) => {
      if (m.gameModes?.length && !m.gameModes.includes(internalMode)) return false
      if (m.minPlayers && count < m.minPlayers) return false
      if (m.maxPlayers && count > m.maxPlayers) return false
      return true
    })
    if (candidates.length === 0) return ''
    // 优先选 maxPlayers 最接近当前人数的图：4 人房优先 4 人图，而不是随机到 8 人图
    const best = Math.min(...candidates.map((m: any) => Math.abs((m.maxPlayers ?? count) - count)))
    const pool = candidates.filter((m: any) => Math.abs((m.maxPlayers ?? count) - count) === best)
    const pick = pool[Math.floor(Math.random() * pool.length)]
    return pick.description || pick.filePath.split(/[/\\]/).pop() || ''
  }

  /** 当前地图禁止玩家选的内部阵营索引集合（来自地图 disallowedPlayerSides） */
  function getDisallowedInternalSides(): Set<number> {
    const room = currentRoom.value
    if (!room?.map) return new Set()
    const mapData = realMapsData.value.find((m: any) => m.description === room.map || m.filePath === room.map)
    return new Set(mapData?.disallowedPlayerSides ?? [])
  }

  /** 当前地图禁止玩家选的内部颜色索引集合（来自地图 disallowedPlayerColors） */
  function getDisallowedInternalColors(): Set<number> {
    const room = currentRoom.value
    if (!room?.map) return new Set()
    const mapData = realMapsData.value.find((m: any) => m.description === room.map || m.filePath === room.map)
    return new Set(mapData?.disallowedPlayerColors ?? [])
  }

  /**
   * 当前地图禁止玩家选的阵营（下拉索引）。
   * 地图 disallowedPlayerSides 是游戏内部阵营索引（0..fc-1），
   * 转回下拉索引需 + randomSelectorCount（Random+选择器占位）。
   */
  function getDisallowedSides(): number[] {
    const rc = realRandomSelectorCount.value
    return Array.from(getDisallowedInternalSides()).map((s) => rc + s)
  }

  /** 当前地图禁止玩家选的颜色（下拉索引）：内部颜色索引 + 1（Random 占 0 位） */
  function getDisallowedColors(): number[] {
    return Array.from(getDisallowedInternalColors()).map((c) => c + 1)
  }

  function cleanup(): void {
    // 清理连接状态订阅（切换 tab 时），但【不断开连接、不清空房间数据】——
    // 连接和房间是全局持久的，切走再切回应保持。
    for (const fn of cleanupFns) fn()
    cleanupFns.length = 0

    // 保留 currentRoom / roomMessages：切换 tab（LobbyView 卸载）后回来仍停留在房间内
    privateMessages.value.clear()
    chatMode.value = currentRoom.value ? 'room' : 'lobby'
    privateTarget.value = null
    isLoading.value = false
    // 保留：rooms / cncnetConnected / onlineCount / playerCount / lobbyMessages / currentRoom / roomMessages
  }

  return {
    rooms,
    currentRoom,
    friends,
    isLoading,
    cncnetConnected,
    onlineCount,
    playerCount,
    connState,
    connMessage,
    connServer,
    connAttempt,
    connTotal,
    connLogs,
    connAttempts,
    chatMode,
    privateTarget,
    currentMessages,
    lobbyMessages,
    roomMessages,
    connectCncnet,
    disconnectCncnet,
    hostLaunch,
    fetchRooms,
    createRoom,
    joinRoom,
    leaveRoom,
    sendMessage,
    fetchFriends,
    toggleReady,
    addAiPlayer,
    kickPlayer,
    banPlayer,
    updatePlayerAttr,
    updateMap,
    updateGameMode,
    toggleLock,
    updateOption,
    realDropdowns,
    realCheckboxes,
    dropdownValues,
    checkboxValues,
    isAllLauncher,
    coveredFactionsForSide,
    setMyBannedFactions,
    requestMap,
    selectTunnel,
    selectedTunnel,
    channelError,
    realRandomSelectors,
    realRandomSelectorCount,
    realFactionCount,
    switchToLobby,
    switchToRoom,
    startPrivateChat,
    stopPrivateChat,
    getModSets,
    getMaps,
    getGameModes,
    getMapFilePath,
    getGameModeUiName,
    getMapDisplayName,
    getRandomMapForCount,
    getMapsForMode,
    getDisallowedSides,
    getDisallowedColors,
    setChatColor,
    autoReady,
    setAutoReady,
    loadRealData,
    cleanup
  }
}

// ─── HMR 保活 ─────────────────────────────────────────
// 状态 ref 都在 lobby-state（本文件不变则不重置）；房间订阅由 roomSubsRegistered 防止重复注册，
// 连接监听由 connectCncnet 每次自清理。这里只接受热更新并提示：改了订阅处理逻辑需整页刷新才生效。
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log('[useLobby] 已热更新：房间/连接状态已保留；订阅处理逻辑改动需整页刷新才生效')
  })
}
