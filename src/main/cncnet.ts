/**
 * CnCNet 游戏频道管理
 *
 * 参考 xna-cncnet-client 的 CnCNetManager.cs + CnCNetLobby.cs。
 * 完整实现：连接 IRC、创建/加入房间、CTCP GAME 广播、隧道服务器。
 */

import { IrcClient, sortServersByLatency, type IrcEvent } from './irc-client'
import { BrowserWindow, app, net, session } from 'electron'
import { getTunnelServers, selectBestTunnel, formatTunnelAddress, computeMapHash, type TunnelServer } from './tunnel-server'
import { readIRCServers, readClientConfig, type IrcServerEntry } from './client-config-reader'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import os from 'node:os'

// ─── 游戏配置 ──────────────────────────────────────────

/** CnCNet 游戏聊天频道的统一 key（对齐 xna 客户端：CreateChannel(..., "ra1-derp")）。
 *  #cncnet-mo 等聊天频道是 +k 模式，不带 key join 会被 475 拒绝。 */
const CNCNET_CHAT_CHANNEL_KEY = 'ra1-derp'

export interface CnCNetGameConfig {
  gameId: string
  internalName: string
  chatChannel: string
  broadcastChannel: string
}

export const CNCNET_GAMES: Record<string, CnCNetGameConfig> = {
  'mental-omega': {
    gameId: 'mental-omega',
    internalName: 'mo',
    chatChannel: '#cncnet-mo',
    broadcastChannel: '#cncnet-mo-games'
  },
  'zero-hour': {
    gameId: 'zero-hour',
    internalName: 'yr',
    chatChannel: '#cncnet-yr',
    broadcastChannel: '#cncnet-yr-games'
  },
  'red-alert': {
    gameId: 'red-alert',
    internalName: 'ra',
    chatChannel: '#cncnet-ra',
    broadcastChannel: '#cncnet-ra-games'
  }
}

// ─── CnCNet 注册身份（USER 命令格式，服务器按此识别客户端；不对会被当坏客户端封）───

/**
 * 稳定机器标识：SHA1(主机名|用户名|安装目录) 取前 6 位（对齐 xna Connection.SetId：
 * ID_LENGTH(9) - LocalGame(2) - 点(1) = 6 位）。同一台机器/安装保持一致。
 */
function getSystemId(): string {
  const seed = `${os.hostname()}|${os.userInfo().username}|${app.getPath('userData')}`
  return createHash('sha1').update(seed).digest('hex').substring(0, 6)
}

/**
 * 构建 CnCNet 注册身份（对齐 xna Connection.Register()）：
 *   USER {LocalGame}.{systemId} 0 * :{GAME_VERSION} {LocalGame} CnCNet
 * 例：USER MO.a1b2c3 0 * :3.3.6 MO CnCNet
 */
function buildCnCNetIdentity(localGame: string, gameVersion: string): { username: string; realname: string } {
  const code = (localGame || 'MO').toUpperCase()
  return {
    username: `${code}.${getSystemId()}`,
    realname: `${gameVersion || '1.0.0'} ${code} CnCNet`
  }
}

/** 读配置：是否走系统代理连接 CnCNet（Settings 里开关，config.json useProxy=1） */
function readUseProxyConfig(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(app.getPath('userData'), 'config.json'), 'utf-8'))
    return String(cfg['useProxy']) === '1'
  } catch {
    return false
  }
}

/** 检测系统代理（Windows 系统代理，如 Clash 127.0.0.1:7897） */
async function detectSystemProxy(): Promise<{ host: string; port: number } | null> {
  try {
    const res = await session.defaultSession.resolveProxy('http://irc.gamesurge.net')
    const m = res.match(/(?:PROXY|SOCKS5?)\s+([^:]+):(\d+)/i)
    if (m) return { host: m[1], port: parseInt(m[2], 10) }
  } catch {
    /* 无代理/解析失败 */
  }
  return null
}

// ─── IRC 服务器 ────────────────────────────────────────
// 来源：ClientDefinitions.ini 的 [IRCServers] 段（host|Name|port,port,port），
// 没有配置则回退默认（对照 DTA Connection.cs）。
// 每服务器多端口，3 秒超时换下一个，全部尝试完 → 失败（OFFLINE），手动重连。

// ─── CnCNet 协议常量 ──────────────────────────────────

// 对齐真实 MO 客户端：MO 房间广播的是 R8（11 字段），R14 会被 MO 客户端忽略
const CNCNET_PROTOCOL_REVISION = 'R8'
const GAME_BROADCAST_INTERVAL = 30_000
const GAME_BROADCAST_INITIAL_DELAY = 10_000
/** 房间生命周期：超过该时间没收到刷新广播就从列表移除（参照参考客户端 GameLifetime=35s） */
const GAME_LIFETIME_MS = 35_000
/** 过期扫描间隔 */
const GAME_SWEEP_INTERVAL_MS = 5_000

// ─── 游戏文件哈希（FHSH，对齐参考 FileHashCalculator.GetFinalHash）───

const FHC_TEXT_EXTENSIONS = ['.txt', '.ini', '.json', '.xml']
/** 需要纳入哈希的游戏文件（MO/Ares + YR 常用），相对游戏目录 */
const FHC_GAME_FILES = [
  'Ares.dll', 'Ares.dll.inj', 'Ares.mix', 'Syringe.exe', 'cncnet5.dll',
  'rulesmd.ini', 'artmd.ini', 'soundmd.ini', 'aimd.ini', 'shroud.shp',
  'spawner.xdp', 'spawner2.xdp', 'INI/Rules.ini', 'INI/Art.ini', 'INI/AI.ini'
]

/** 单个文件 SHA1；文本文件先统一行尾为 LF + trim（对齐参考） */
function sha1ForFile(filePath: string): string {
  try {
    if (!existsSync(filePath)) return ''
    if (FHC_TEXT_EXTENSIONS.includes(extname(filePath).toLowerCase())) {
      const text = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').trim()
      return createHash('sha1').update(text).digest('hex')
    }
    return createHash('sha1').update(readFileSync(filePath)).digest('hex')
  } catch {
    return ''
  }
}

function listFilesRecursive(dir: string): string[] {
  const result: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) result.push(...listFilesRecursive(full))
      else result.push(full)
    }
  } catch { /* 目录不存在忽略 */ }
  return result
}

/** 计算游戏文件完整哈希：各文件 SHA1 按路径排序拼接后整体再 SHA1（40 位 hex） */
function computeGameFilesHash(gamePath: string): string {
  const hashes: Array<{ rel: string; hash: string }> = []
  for (const rel of FHC_GAME_FILES) {
    const h = sha1ForFile(join(gamePath, rel))
    if (h) hashes.push({ rel: rel.replace(/\\/g, '/'), hash: h })
  }
  const goDir = join(gamePath, 'INI', 'Game Options')
  if (existsSync(goDir)) {
    for (const full of listFilesRecursive(goDir)) {
      const rel = relative(gamePath, full).replace(/\\/g, '/')
      const h = sha1ForFile(full)
      if (h) hashes.push({ rel, hash: h })
    }
  }
  hashes.sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()))
  const concat = hashes.map((h) => h.hash).join('')
  return createHash('sha1').update(concat).digest('hex')
}

// ─── 房间数据模型 ──────────────────────────────────────

export interface HostedGame {
  roomId: string
  roomName: string
  host: string
  hostId: string
  gameId: string
  gameMode: string
  map: string
  maxPlayers: number
  currentPlayers: number
  hasPassword: boolean
  isLocked: boolean
  status: 'waiting' | 'in-game'
  createdAt: number
  protocolRevision: string
  gameVersion: string
  channelName: string
  channelPassword: string
  tunnelAddress?: string
  players: string[]
  mapHash?: string
  packedOptions?: string
  skillLevel: number
  /** 最后一次收到该房间广播的时间（用于过期清理，参照参考客户端 GameLifetime=35s） */
  lastRefreshTime: number
}

export interface ChatMessage {
  id: string
  roomId: string
  userId: string
  userName: string
  content: string
  timestamp: number
  type: 'message' | 'join' | 'part' | 'system'
  /** IRC 颜色 id（原版客户端聊天 \x03NN 前缀解析出） */
  colorId?: number
}

// ─── 创建房间参数 ──────────────────────────────────────

export interface CreateRoomParams {
  roomName: string
  maxPlayers: number
  map: string
  mapFilePath: string
  gameMode: string
  password?: string
  packedOptions?: string
}

// ─── CnCNet 管理器 ─────────────────────────────────────

export class CnCNetManager {
  private irc: IrcClient
  private mainWindow: BrowserWindow | null = null
  private games = new Map<string, HostedGame>()
  private chatMessages: ChatMessage[] = []
  private currentGameConfig: CnCNetGameConfig | null = null
  private msgSeq = 0
  private nickToUserId = new Map<string, string>()
  private connected = false
  private channelUsers = new Map<string, Set<string>>()

  // 房间托管相关
  private hostedGame: HostedGame | null = null
  private broadcastTimer: ReturnType<typeof setInterval> | null = null
  /** 房间列表过期扫描定时器 */
  private gameSweepTimer: ReturnType<typeof setInterval> | null = null
  private sortedServers: Array<{ host: string; port: number; latency: number }> = []
  /** 从 ClientDefinitions.ini 加载的服务器列表（展开后），按游戏目录缓存 */
  private loadedServers: Array<{ host: string; port: number; label: string }> | null = null
  private loadedGamePath = ''

  /** 记住的最佳服务器（上次连接成功的），下次优先尝试 */
  private bestServer: { host: string; port: number; label?: string } | null = null
  /** 当前 IRC 客户端的昵称（connect 时判断是否需要重建） */
  private ircNickname = ''
  /** 游戏版本号（从游戏目录 version 文件读，如 MO 3.3.6；GAME 广播用，供版本检测） */
  private gameVersion = '1.0.0'

  /** 在线玩家数轮询（对照原版 CnCNetPlayerCountTask，api.cncnet.org/status） */
  private playerCountTimer: ReturnType<typeof setInterval> | null = null
  private liveStatusIdentifier = ''
  private static PLAYER_COUNT_URL = 'https://api.cncnet.org/status'
  private static PLAYER_COUNT_INTERVAL = 60_000

  // 当前加入的房间
  private joinedGameChannel: string | null = null
  private joinedGamePassword: string | null = null

  constructor() {
    // 初始用默认服务器（connect 时会按游戏目录的配置重新加载）
    const defaults = readIRCServers('')
    const identity = buildCnCNetIdentity('MO', this.gameVersion)
    this.irc = new IrcClient({
      servers: defaults.flatMap((s: IrcServerEntry) =>
        s.ports.map((port) => ({ host: s.host, port, label: s.label }))
      ),
      nickname: `Launcher${Math.floor(Math.random() * 9999)}`,
      username: identity.username,
      realname: identity.realname
    })

    this.irc.on('irc', (event: IrcEvent) => this.handleIrcEvent(event))
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  // ─── 连接管理 ────────────────────────────────────────

  /** 从游戏目录 version 文件读取版本号（[DTA] Version=3.3.6），供 GAME 广播版本检测 */
  private loadGameVersion(gamePath: string): void {
    try {
      const content = readFileSync(join(gamePath, 'version'), 'utf-8')
      const m = content.match(/Version=([^\r\n]+)/)
      if (m && m[1]) this.gameVersion = m[1].trim()
    } catch {
      // 无 version 文件，保持默认
    }
  }

  async connect(gamePath: string, nickname?: string): Promise<void> {
    this.loadGameVersion(gamePath)
    // 从 ClientDefinitions.ini 加载服务器列表（对照 DTA：配置里有就用，没有回退默认）
    if (!this.loadedServers || this.loadedGamePath !== gamePath) {
      this.loadedGamePath = gamePath
      const configServers = readIRCServers(gamePath)
      let servers = configServers.flatMap((s: IrcServerEntry) =>
        s.ports.map((port) => ({ host: s.host, port, label: s.label }))
      )

      // 记住的最佳服务器优先（下次连接直接先试它，免得从头逐个试）
      this.bestServer = this.loadBestServer()
      if (this.bestServer) {
        const has = servers.some((s) => s.host === this.bestServer!.host && s.port === this.bestServer!.port)
        if (has) {
          servers = [
            { host: this.bestServer.host, port: this.bestServer.port, label: this.bestServer.label ?? '' },
            ...servers.filter((s) => !(s.host === this.bestServer!.host && s.port === this.bestServer!.port))
          ]
        }
      }
      this.loadedServers = servers
    }

    // 先测延迟排序服务器（对照 DTA GetServerListSortedByLatency）
    if (this.sortedServers.length === 0) {
      console.log('[CnCNet] Sorting servers by latency...')
      this.sortedServers = await sortServersByLatency(this.loadedServers)
      console.log('[CnCNet] Best server:', this.sortedServers[0])

      // 测速结果：对应 DTA 的 OnServerLatencyTested（"网络质量较好的服务器数量"）
      const available = this.sortedServers.length
      const fast = this.sortedServers.filter((s) => s.latency <= 400).length
      this.sendToRenderer('cncnet:latency-tested', { available, fast })

      // 记住的服务器即使延迟高也排最前（它是上次连上的，最可能成功）
      const best = this.bestServer
      if (best) {
        const idx = this.sortedServers.findIndex((s) => s.host === best.host && s.port === best.port)
        if (idx > 0) {
          const [b] = this.sortedServers.splice(idx, 1)
          this.sortedServers.unshift(b)
        }
      }
    }

    // CnCNet 注册身份：USER 格式必须对齐（{LocalGame}.{systemId} / {版本} {LocalGame} CnCNet），
    // 否则服务器当坏客户端封（474 +b）。LocalGame 从游戏 ClientDefinitions.ini 读（MO→"MO"）。
    let localGame = 'MO'
    try { localGame = readClientConfig(gamePath).localGame || 'MO' } catch { /* 无配置时默认 MO */ }
    const identity = buildCnCNetIdentity(localGame, this.gameVersion)

    // 挂梯子时走 SOCKS5 代理连 IRC（裸 TCP 不自动走系统代理，直连真实 IP 可能被频道封禁）
    let proxy: { host: string; port: number } | undefined
    if (readUseProxyConfig()) {
      proxy = (await detectSystemProxy()) ?? undefined
      if (proxy) console.log(`[CnCNet] 使用系统代理 ${proxy.host}:${proxy.port} 连接 IRC`)
    }

    // 只在昵称变化时重建 IRC 客户端——否则每次 connect（如切换 tab）都会
    // 丢掉现有连接重连，导致多人连接断线
    if (nickname && nickname !== this.ircNickname) {
      // 先断开旧客户端再重建：只 removeAllListeners 的话，旧连接的 socket 和 30s
      // PING 定时器会一直挂在服务器上，成为持久泄漏。
      // 注意顺序——先 removeAllListeners 让 disconnect() 补发的 disconnected 事件
      // 不会误清状态，再 disconnect 销毁旧 socket/定时器。
      this.irc.removeAllListeners()
      this.irc.disconnect()
      this.irc = new IrcClient({
        servers: this.loadedServers,
        nickname: nickname,
        username: identity.username,
        realname: identity.realname,
        proxy
      })
      this.irc.on('irc', (event: IrcEvent) => this.handleIrcEvent(event))
      this.ircNickname = nickname
    } else {
      // 昵称没变：不重建，但身份（游戏代号/版本）变了要更新到现有客户端，注册时用
      this.irc.setIdentity(nickname ?? this.ircNickname, identity.username, identity.realname)
      this.irc.setProxy(proxy)
    }
    // 启动在线玩家数轮询（对照原版 CnCNetPlayerCountTask）
    this.startPlayerCountPolling(gamePath)
    await this.irc.connect(this.sortedServers)
  }

  disconnect(): void {
    this.stopGameSweep()
    this.stopBroadcast()
    this.irc.disconnect()
  }

  isConnected(): boolean {
    return this.irc.isConnected()
  }

  getNickname(): string {
    return this.irc.getNickname()
  }

  // ─── 最佳服务器记忆 ─────────────────────────────────

  private configPath(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  /** 记住成功连接的服务器（持久化到 config.json） */
  private rememberBestServer(host?: string, port?: number, label?: string): void {
    if (!host || !port) return
    this.bestServer = { host, port, label }
    try {
      const configPath = this.configPath()
      let config: Record<string, string> = {}
      try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* 无配置 */ }
      config['last_server'] = JSON.stringify(this.bestServer)
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      console.log(`[CnCNet] 记住最佳服务器: ${host}:${port} (${label ?? ''})`)
    } catch (e) {
      console.error('[CnCNet] 保存最佳服务器失败:', (e as Error).message)
    }
  }

  /** 读取上次成功连接的服务器 */
  private loadBestServer(): { host: string; port: number; label?: string } | null {
    try {
      const configPath = this.configPath()
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, string>
      const raw = config['last_server']
      if (raw) return JSON.parse(raw) as { host: string; port: number; label?: string }
    } catch { /* 无配置 */ }
    return null
  }

  // ─── 在线玩家数轮询（对照原版 CnCNetPlayerCountTask） ───

  /** 启动在线玩家数轮询（连接时），每 60 秒拉 api.cncnet.org/status */
  startPlayerCountPolling(gamePath: string): void {
    const config = readClientConfig(gamePath)
    this.liveStatusIdentifier = config.cncNetLiveStatusIdentifier
    if (!this.liveStatusIdentifier) return

    this.stopPlayerCountPolling()
    void this.fetchPlayerCount()
    this.playerCountTimer = setInterval(() => void this.fetchPlayerCount(), CnCNetManager.PLAYER_COUNT_INTERVAL)
  }

  stopPlayerCountPolling(): void {
    if (this.playerCountTimer) {
      clearInterval(this.playerCountTimer)
      this.playerCountTimer = null
    }
  }

  private async fetchPlayerCount(): Promise<void> {
    if (!this.liveStatusIdentifier) return
    try {
      const resp = await net.fetch(CnCNetManager.PLAYER_COUNT_URL, {
        headers: { 'User-Agent': 'TDHourLauncher/1' }
      })
      if (!resp.ok) return
      const text = await resp.text()
      // 对照原版：去掉 {} " 后按 , 分割，找 CnCNetLiveStatusIdentifier 字段的值
      const clean = text.replace(/[{}"]/g, '')
      for (const part of clean.split(',')) {
        const idx = part.indexOf(':')
        if (idx < 0) continue
        const key = part.slice(0, idx).trim()
        if (key === this.liveStatusIdentifier) {
          const count = parseInt(part.slice(idx + 1).trim(), 10)
          if (!isNaN(count)) {
            this.sendToRenderer('cncnet:player-count', { count })
            return
          }
        }
      }
    } catch {
      // 网络失败静默，下次轮询再试
    }
  }

  // ─── 频道操作 ────────────────────────────────────────

  joinGameChannel(gameId: string): void {
    const config = CNCNET_GAMES[gameId]
    if (!config) return

    // 同一游戏重复调用（刷新/重进大厅）不清空房间，但确保频道重新 JOIN
    // （IRC 允许重复 JOIN；单次 JOIN 偶发丢失时靠它补上）
    if (this.currentGameConfig?.gameId !== gameId) {
      this.games.clear()
      this.chatMessages = []
    }
    this.currentGameConfig = config

    console.log(`[CnCNet] 请求加入频道: ${config.chatChannel}(key) + ${config.broadcastChannel} (connected=${this.irc.isConnected()})`)
    // 聊天频道是 +k 模式，必须带 key（ra1-derp）；广播频道无需密码
    this.irc.join(config.chatChannel, CNCNET_CHAT_CHANNEL_KEY)
    this.irc.join(config.broadcastChannel)
    this.startGameSweep()
  }

  leaveGameChannel(): void {
    this.stopGameSweep()
    if (this.currentGameConfig) {
      this.irc.part(this.currentGameConfig.chatChannel)
      this.irc.part(this.currentGameConfig.broadcastChannel)
      this.currentGameConfig = null
    }
  }

  sendMessage(channel: string, message: string): void {
    this.irc.privmsg(channel, message)
  }

  /** 房主踢出玩家（IRC KICK） */
  sendKick(channel: string, nick: string): void {
    this.irc.kick(channel, nick)
  }

  /** 房主封禁玩家：按昵称 mask 封（无 host 追踪的简化）+ 踢出 */
  sendBan(channel: string, nick: string): void {
    this.irc.mode(channel, '+b', `${nick}!*@*`)
    this.irc.kick(channel, nick)
  }

  // ─── 创建房间 ────────────────────────────────────────

  async createRoom(params: CreateRoomParams): Promise<HostedGame> {
    if (!this.currentGameConfig) throw new Error('Not connected to game channel')

    const config = this.currentGameConfig
    const nickname = this.irc.getNickname()

    // 生成随机频道名
    const randomId = Math.floor(1000000 + Math.random() * 9000000)
    const channelName = `#cncnet-${config.internalName}-game${randomId}`

    // 计算密码：对齐参考 Channel.ChangePassword —— 自定义密码用原始密码截断 10 位，无密码才用 sha1(频道名)[:10]
    const channelPassword = params.password
      ? params.password.substring(0, 10)
      : IrcClient.computePassword(channelName)
    console.log(`[CreateRoom] 频道=${channelName} 密码=${channelPassword} 自定义密码=${!!params.password}`)

    // 获取最佳隧道
    const tunnel = await selectBestTunnel()
    const tunnelAddress = tunnel ? formatTunnelAddress(tunnel) : ''

    // 计算地图哈希（按游戏目录解析地图文件，算内容 SHA1；文件缺失时退回路径哈希）
    const mapHash = computeMapHash(params.mapFilePath, this.loadedGamePath)

    // 构建 flags: [locked][custom_password][closed][is_loaded_game][is_ladder]
    const hasPassword = !!params.password
    const flags = `0${hasPassword ? '1' : '0'}000`

    const players = [nickname]

    const game: HostedGame = {
      roomId: `cncnet_${channelName}`,
      roomName: params.roomName,
      host: nickname,
      hostId: this.getOrCreateUserId(nickname),
      gameId: config.gameId,
      gameMode: params.gameMode,
      map: params.map,
      maxPlayers: params.maxPlayers,
      currentPlayers: players.length,
      hasPassword,
      isLocked: false,
      status: 'waiting',
      createdAt: Date.now(),
      lastRefreshTime: Date.now(),
      protocolRevision: CNCNET_PROTOCOL_REVISION,
      gameVersion: this.gameVersion,
      channelName,
      channelPassword,
      tunnelAddress,
      players,
      mapHash,
      packedOptions: params.packedOptions ?? '',
      skillLevel: 0
    }

    this.hostedGame = game

    // JOIN 频道
    this.irc.join(channelName, channelPassword)

    // 设置频道模式和主题
    setTimeout(() => {
      this.irc.mode(channelName, '+klnNs', channelPassword, String(params.maxPlayers))
      this.irc.topic(channelName, `${CNCNET_PROTOCOL_REVISION};${config.internalName}`)
    }, 500)

    // 开始定时广播
    this.startBroadcast()

    this.games.set(game.roomId, game)
    this.sendToRenderer('cncnet:room-updated', game)

    return game
  }

  // ─── 加入房间 ────────────────────────────────────────

  joinRoom(game: HostedGame, password?: string): void {
    // 计算密码：自定义密码用原始密码截断 10 位（对齐参考），无密码用广播里算好的频道钥匙
    const channelPassword = password
      ? password.substring(0, 10)
      : game.channelPassword
    console.log(`[JoinRoom] 频道=${game.channelName} 密码=${channelPassword} 用户输入=${password ?? '(无)'}`)

    this.joinedGameChannel = game.channelName
    this.joinedGamePassword = channelPassword

    // JOIN 频道
    this.irc.join(game.channelName, channelPassword)

    // 发送文件哈希（真实游戏文件哈希，对齐参考 FileHashCalculator）
    setTimeout(() => {
      const hash = computeGameFilesHash(this.loadedGamePath)
      this.irc.ctcp(game.channelName, 'FHSH', hash)
    }, 1000)
    // 隧道 ping（简化值，对齐参考 UpdatePing 的 TNLPNG）
    setTimeout(() => {
      this.irc.ctcp(game.channelName, 'TNLPNG', '50')
    }, 1500)
  }

  // ─── 离开房间 ────────────────────────────────────────

  leaveRoom(): void {
    if (this.hostedGame) {
      // 先广播关闭信号（flags 置 closed），让其他客户端立即移除我们的房间
      this.broadcastGame(true)
      this.stopBroadcast()
      this.irc.part(this.hostedGame.channelName, 'Leaving')
      this.games.delete(this.hostedGame.roomId)
      this.sendToRenderer('cncnet:room-removed', { roomId: this.hostedGame.roomId })
      this.hostedGame = null
    }
    if (this.joinedGameChannel) {
      this.irc.part(this.joinedGameChannel, 'Leaving')
      this.joinedGameChannel = null
      this.joinedGamePassword = null
    }
  }

  // ─── CTCP GAME 广播 ─────────────────────────────────

  private startBroadcast(): void {
    this.stopBroadcast()
    // 立即广播一次，让创建的房间马上对其他人可见；之后每 30s 刷新
    this.broadcastGame()
    this.broadcastTimer = setInterval(() => this.broadcastGame(), GAME_BROADCAST_INTERVAL)
  }

  private stopBroadcast(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer)
      this.broadcastTimer = null
    }
    if (this.broadcastGameDebounceTimer) {
      clearTimeout(this.broadcastGameDebounceTimer)
      this.broadcastGameDebounceTimer = null
    }
  }

  // ─── 房间列表过期清理（host 崩溃/停止广播而不 PART 时，房间不消失）───

  private startGameSweep(): void {
    this.stopGameSweep()
    this.gameSweepTimer = setInterval(() => {
      const now = Date.now()
      let removed = 0
      for (const [id, game] of this.games) {
        // 正在加入/托管的房间不清理，避免把自己踢出房间
        if (game.channelName === this.joinedGameChannel || game.channelName === this.hostedGame?.channelName) continue
        if (now - (game.lastRefreshTime ?? game.createdAt) > GAME_LIFETIME_MS) {
          this.games.delete(id)
          this.sendToRenderer('cncnet:room-removed', { roomId: id })
          removed++
        }
      }
      if (removed > 0) console.log(`[CnCNet] 过期扫描移除 ${removed} 个房间，当前 ${this.games.size} 个`)
    }, GAME_SWEEP_INTERVAL_MS)
  }

  private stopGameSweep(): void {
    if (this.gameSweepTimer) {
      clearInterval(this.gameSweepTimer)
      this.gameSweepTimer = null
    }
  }

  /**
   * GAME 广播（节流版）：连续变更（切模式/切图/选项）在 1.5s 内合并为一次，
   * 避免瞬间连发多条 GAME 触发服务器 Excess Flood 被踢（房主被踢 = 房间看着像解散）。
   * 关闭信号（closed）必须立即发。
   */
  private broadcastGameDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private broadcastGame(closed = false): void {
    if (closed) {
      this.doBroadcastGame(true)
      return
    }
    if (this.broadcastGameDebounceTimer) clearTimeout(this.broadcastGameDebounceTimer)
    this.broadcastGameDebounceTimer = setTimeout(() => {
      this.broadcastGameDebounceTimer = null
      this.doBroadcastGame(false)
    }, 1500)
  }

  /** 立即发送 GAME 广播（换图/换模式后发 GO 前调用，保证原版客户端先收 GAME 再收 GO，不报"不存在的图"）。
   *  无条件发送：不依赖挂起定时器（可能已被清除或已触发），确保 GAME 先于 GO 到达。 */
  flushBroadcastGame(): void {
    if (this.broadcastGameDebounceTimer) {
      clearTimeout(this.broadcastGameDebounceTimer)
      this.broadcastGameDebounceTimer = null
    }
    this.doBroadcastGame(false)
  }

  private doBroadcastGame(closed = false): void {
    if (!this.hostedGame || !this.currentGameConfig) return

    const game = this.hostedGame
    const config = this.currentGameConfig

    // flags: [0]started [1]customPassword [2]closed [3]loadedGame [4]ladder
    const flags = `${game.status === 'in-game' ? '1' : '0'}${game.hasPassword ? '1' : '0'}${closed ? '1' : '0'}00`

    // CTCP GAME 广播格式（R8 = 11 个分号分隔字段，对齐真实 MO 客户端）
    const data = [
      CNCNET_PROTOCOL_REVISION,
      this.gameVersion,
      String(game.maxPlayers),
      game.channelName,
      game.roomName,
      flags,
      game.players.join(','),
      game.map,
      game.gameMode,
      game.tunnelAddress ?? '',
      '0' // loadedGameId
    ].join(';')

    // 广播到游戏频道（使用 CTCP via NOTICE）
    this.irc.ctcp(config.broadcastChannel, 'GAME', data)
  }

  // ─── 房间内 CTCP 协议 ──────────────────────────────

  /** 发送玩家选项 (OR) */
  sendPlayerOptions(channel: string, options: number): void {
    this.irc.ctcp(channel, 'OR', String(options))
  }

  /** 发送准备状态 (R) */
  sendReady(channel: string, ready: number): void {
    this.irc.ctcp(channel, 'R', String(ready))
  }

  /** 发送启动命令 (START) — 仅 host */
  sendStart(channel: string, tunnelAssignments: string): void {
    // 标记房间为游戏中并重新广播（其他玩家看到 in-game 状态）
    if (this.hostedGame && this.hostedGame.channelName === channel) {
      this.hostedGame.status = 'in-game'
      this.broadcastGame()
    }
    this.irc.ctcp(channel, 'START', tunnelAssignments)
  }

  /** 发送返回命令 (RETURN) */
  sendReturn(channel: string): void {
    this.irc.ctcp(channel, 'RETURN', '')
  }

  /** 通用 CTCP 发送（供房间内协议：PO/GO/GETREADY/LCKGME/STRTD 等） */
  sendCtcpRaw(channel: string, tag: string, data: string): void {
    this.irc.ctcp(channel, tag, data)
  }

  /** launcher 专属命令：以普通聊天消息发送（带 [Launcher] 标记，不走 CTCP），只有本 launcher 解析 */
  sendChatCommand(channel: string, tag: string, data: string): void {
    this.irc.privmsg(channel, `[Launcher] ${tag}${data ? ' ' + data : ''}`)
  }

  /** 锁定/解锁房间：用频道模式 +i/-i（对齐参考 LockGame/UnlockGame） */
  sendLock(channel: string, locked: boolean): void {
    this.irc.mode(channel, locked ? '+i' : '-i')
  }

  /** 房主更换隧道服务器：更新托管房间的隧道并重新广播，让所有玩家用同一个隧道 */
  setHostedTunnel(tunnelAddress: string): void {
    if (!this.hostedGame) return
    this.hostedGame.tunnelAddress = tunnelAddress
    this.broadcastGame()
    this.sendToRenderer('cncnet:room-updated', this.hostedGame)
  }

  /** 房主换图：更新托管房间的地图（+重算 hash）并重新广播 GAME，大厅里的房间列表才会刷新 */
  setHostedMap(map: string, mapFilePath: string): { mapHash: string } {
    if (!this.hostedGame) return { mapHash: '' }
    this.hostedGame.map = map
    this.hostedGame.mapHash = computeMapHash(mapFilePath, this.loadedGamePath)
    this.broadcastGame()
    this.sendToRenderer('cncnet:room-updated', this.hostedGame)
    console.log(`[setHostedMap] 地图更新为 "${map}" hash=${this.hostedGame.mapHash}`)
    return { mapHash: this.hostedGame.mapHash }
  }

  /** 房主切换模式：更新 hostedGame.gameMode 并重广播 GAME（房间列表要看到新模式） */
  setHostedGameMode(gameMode: string): void {
    if (!this.hostedGame || !gameMode) return
    this.hostedGame.gameMode = gameMode
    this.broadcastGame()
    this.sendToRenderer('cncnet:room-updated', this.hostedGame)
    console.log(`[setHostedGameMode] 模式更新为 "${gameMode}"`)
  }

  // ─── 事件处理 ────────────────────────────────────────

  private handleIrcEvent(event: IrcEvent): void {
    switch (event.type) {
      case 'connecting':
        this.sendToRenderer('cncnet:connecting', {
          server: event.message,
          attempt: event.attempt ?? 1,
          total: this.sortedServers.length
        })
        break

      case 'connected':
        this.connected = true
        this.sendToRenderer('cncnet:connected', {})
        break

      case 'disconnected':
        this.connected = false
        this.games.clear()
        this.stopGameSweep()
        this.stopBroadcast()
        this.stopPlayerCountPolling()
        this.sendToRenderer('cncnet:disconnected', {})
        break

      case 'error':
        this.sendToRenderer('cncnet:error', { message: event.message, server: event.label })
        break

      case 'nick-change':
        this.sendToRenderer('cncnet:nick-change', { nick: event.nick })
        break

      case 'message':
        this.handleMessage(event)
        break

      case 'notice':
        this.handleNotice(event)
        break

      case 'join':
        this.handleJoin(event)
        break

      case 'part':
      case 'quit':
        this.handlePart(event)
        break

      case 'kick':
        // 把被踢事件转发给渲染层（被踢的玩家据此离开房间并提示）
        this.sendToRenderer('cncnet:kicked', { channel: event.channel, nick: event.nick, message: event.message })
        break

      case 'ctcp':
        this.handleCtcp(event)
        break

      case 'names':
        this.handleNames(event)
        break

      case 'mode':
        this.handleMode(event)
        break

      case 'numeric':
        this.handleNumeric(event)
        break
    }
  }

  /**
   * 处理数字回复 —— 对照 DTA Connection.PerformCommand 的 numeric 分支。
   * 001 Welcome / 002-003 服务器信息 / 251-266 统计等显示到聊天。
   */
  private handleNumeric(event: IrcEvent): void {
    const code = parseInt(event.args?.[0] ?? '', 10)
    const server = event.host ? `${event.host}: ` : ''
    const text = event.message ?? ''

    switch (code) {
      case 1: // 001 Welcome —— 真正连接成功（对照原版 welcomeMessageReceived）
        this.sendToRenderer('cncnet:welcome', { text: `${server}${text}` })
        // 收到 001 才算真正连上，这时才记住最佳服务器（TCP 通≠注册成功）
        if (event.rememberHost && event.rememberPort) {
          this.rememberBestServer(event.rememberHost, event.rememberPort, event.label)
        }
        break
      case 2: // Your host is...
      case 3: // This server was created...
      case 251: // users and invisible on servers
      case 252: // operators online
      case 254: // channels formed
      case 255: // I have clients and servers
      case 265: // Local user count
      case 266: // Global user count
        this.sendToRenderer('cncnet:server-message', { text: `${server}${text}` })
        break
      case 403: // ERR_NOSUCHCHANNEL
      case 471: // ERR_CHANNELISFULL
      case 473: // ERR_INVITEONLYCHANNEL
      case 474: // ERR_BANNEDFROMCHAN
      case 475: // ERR_BADCHANNELKEY
        // 加入频道失败（如被拉黑 +b）→ 通知渲染层，不能只显示"已连接"
        this.sendToRenderer('cncnet:channel-error', {
          code,
          channel: event.args?.[2] ?? event.args?.[1] ?? '',
          message: text
        })
        break
      default:
        break
    }
  }

  /** launcher 聊天命令标记前缀（普通聊天里不太可能出现） */
  private static readonly LAUNCHER_CMD_PREFIX = '[Launcher] '

  private handleMessage(event: IrcEvent): void {
    if (!event.channel || !event.nick) return

    // 过滤掉游戏广播频道的非 CTCP 消息
    if (this.currentGameConfig?.broadcastChannel === event.channel) return

    // launcher 聊天命令：带标记前缀 → 解析为命令（不显示为聊天）
    let content = event.message ?? ''
    if (content.startsWith(CnCNetManager.LAUNCHER_CMD_PREFIX)) {
      const rest = content.slice(CnCNetManager.LAUNCHER_CMD_PREFIX.length)
      const sp = rest.indexOf(' ')
      const tag = sp === -1 ? rest : rest.slice(0, sp)
      const data = sp === -1 ? '' : rest.slice(sp + 1)
      this.handleLauncherChatCommand(event.channel, event.nick, tag, data)
      return
    }

    // 原版客户端聊天带 \x03NN 颜色前缀：解析出颜色 id，去掉前缀和其余 IRC 格式码（\x0f 重置等）
    let colorId: number | undefined
    const colorMatch = content.match(/^\x03(\d{1,2})(,\d{1,2})?/)
    if (colorMatch) {
      colorId = parseInt(colorMatch[1], 10)
      content = content.replace(/^\x03\d{1,2}(,\d{1,2})?/, '')
    }
    content = content.replace(/[\x0f\x02\x1d\x1f]/g, '')

    const userId = this.getOrCreateUserId(event.nick)
    const msg: ChatMessage = {
      id: `m${++this.msgSeq}`,
      roomId: event.channel,
      userId,
      userName: event.nick,
      content,
      timestamp: Date.now(),
      type: 'message',
      colorId
    }

    this.chatMessages.push(msg)
    this.sendToRenderer('cncnet:message', msg)
  }

  private handleNotice(event: IrcEvent): void {
    // NOTICE 消息也作为聊天消息显示
    if (!event.channel || !event.nick) return
    if (this.currentGameConfig?.broadcastChannel === event.channel) return

    // 同样解析 \x03NN 颜色前缀（NOTICE 也可能带）
    let content = event.message ?? ''
    let colorId: number | undefined
    const colorMatch = content.match(/^\x03(\d{1,2})(,\d{1,2})?/)
    if (colorMatch) {
      colorId = parseInt(colorMatch[1], 10)
      content = content.replace(/^\x03\d{1,2}(,\d{1,2})?/, '')
    }
    content = content.replace(/[\x0f\x02\x1d\x1f]/g, '')

    const userId = this.getOrCreateUserId(event.nick)
    const msg: ChatMessage = {
      id: `m${++this.msgSeq}`,
      roomId: event.channel,
      userId,
      userName: event.nick,
      content,
      timestamp: Date.now(),
      type: 'message',
      colorId
    }

    this.chatMessages.push(msg)
    this.sendToRenderer('cncnet:message', msg)
  }

  private handleJoin(event: IrcEvent): void {
    if (!event.channel || !event.nick) return
    console.log(`[CnCNet] JOIN ${event.nick} -> ${event.channel}`)

    if (!this.channelUsers.has(event.channel)) {
      this.channelUsers.set(event.channel, new Set())
    }
    this.channelUsers.get(event.channel)!.add(event.nick)

    const userId = this.getOrCreateUserId(event.nick)
    const msg: ChatMessage = {
      id: `m${++this.msgSeq}`,
      roomId: event.channel,
      userId,
      userName: event.nick,
      content: `${event.nick} 加入了频道`,
      timestamp: Date.now(),
      type: 'join'
    }

    this.chatMessages.push(msg)
    this.sendToRenderer('cncnet:message', msg)

    // 有人加入广播频道且我们正在托管：重新广播（刷新玩家列表）
    if (this.currentGameConfig?.broadcastChannel === event.channel && this.hostedGame) {
      this.broadcastGame()
    }
    // 有人加入我们托管的游戏房间：更新玩家列表并立即重广播，否则广播里的玩家数滞后
    if (this.hostedGame && event.channel === this.hostedGame.channelName) {
      if (!this.hostedGame.players.includes(event.nick)) {
        this.hostedGame.players.push(event.nick)
        this.hostedGame.currentPlayers = this.hostedGame.players.length
      }
      this.broadcastGame()
      this.sendToRenderer('cncnet:room-updated', this.hostedGame)
    }
    // 加入游戏房间频道 → 推送最新成员列表，让玩家表即时刷新
    if (event.channel === this.hostedGame?.channelName || event.channel === this.joinedGameChannel) {
      this.sendChannelUsers(event.channel)
    }
  }

  private handlePart(event: IrcEvent): void {
    if (!event.channel || !event.nick) return

    this.channelUsers.get(event.channel)?.delete(event.nick)

    const userId = this.getOrCreateUserId(event.nick)
    const msg: ChatMessage = {
      id: `m${++this.msgSeq}`,
      roomId: event.channel,
      userId,
      userName: event.nick,
      content: `${event.nick} 离开了频道`,
      timestamp: Date.now(),
      type: 'part'
    }

    this.chatMessages.push(msg)
    this.sendToRenderer('cncnet:message', msg)

    // 如果有人离开广播频道，移除其房间
    if (this.currentGameConfig?.broadcastChannel === event.channel) {
      for (const [id, game] of this.games) {
        if (game.host === event.nick) {
          this.games.delete(id)
          this.sendToRenderer('cncnet:room-removed', { roomId: id })
        }
      }
    }

    // 如果有人离开游戏房间频道
    if (event.channel === this.joinedGameChannel || event.channel === this.hostedGame?.channelName) {
      // 从玩家列表移除
      if (this.hostedGame) {
        this.hostedGame.players = this.hostedGame.players.filter(p => p !== event.nick)
        this.hostedGame.currentPlayers = this.hostedGame.players.length
        this.broadcastGame()
        this.sendToRenderer('cncnet:room-updated', this.hostedGame)
      }
      // 推送更新后的成员列表
      this.sendChannelUsers(event.channel)
    }
  }

  private handleNames(event: IrcEvent): void {
    if (!event.channel) return
    // 多行 353 累积到 channelUsers；366 收尾用空 message 触发一次完整列表
    if (event.message) {
      const users = event.message.split(' ').filter(u => u && !u.startsWith('@') && !u.startsWith('+'))
      if (!this.channelUsers.has(event.channel)) this.channelUsers.set(event.channel, new Set())
      for (const u of users) this.channelUsers.get(event.channel)!.add(u)
      console.log(`[CnCNet] NAMES ${event.channel}: 累积 ${this.channelUsers.get(event.channel)!.size} 用户`)
    }
    const all = Array.from(this.channelUsers.get(event.channel) ?? [])
    this.sendToRenderer('cncnet:names', { channel: event.channel, users: all })
  }

  /** 把某频道的当前成员列表推给渲染层（玩家加入/离开游戏房间时刷新玩家表） */
  private sendChannelUsers(channel: string): void {
    const all = Array.from(this.channelUsers.get(channel) ?? [])
    this.sendToRenderer('cncnet:names', { channel, users: all })
  }

  private handleMode(event: IrcEvent): void {
    // 频道模式变更
    if (event.channel && event.args) {
      this.sendToRenderer('cncnet:mode', {
        channel: event.channel,
        mode: event.args.join(' '),
        params: event.args.slice(1)
      })
    }
  }

  // ─── CTCP 处理 ──────────────────────────────────────

  private handleCtcp(event: IrcEvent): void {
    if (!event.args?.[0]) return
    const data = event.args[0]

    // 广播频道的 CTCP GAME
    if (this.currentGameConfig?.broadcastChannel === event.channel && event.message === 'GAME') {
      console.log(`[CnCNet] CTCP GAME 广播: ${data}`)
      // 房主关闭房间的信号：flags 第 3 位（index 2）为 1 → 从列表移除（对照参考 isClosed）
      const parts = data.split(';')
      if ((parts[5]?.[2] ?? '') === '1') {
        const host = event.nick ?? ''
        let removed = false
        for (const [id, g] of this.games) {
          if (g.host === host || g.channelName === parts[3]) {
            this.games.delete(id)
            this.sendToRenderer('cncnet:room-removed', { roomId: id })
            removed = true
          }
        }
        console.log(`[CnCNet] 收到房间关闭广播 (host=${host}) ${removed ? '已移除' : '未找到对应房间'}`)
        return
      }
      const game = this.parseGameBroadcast(data, event.nick ?? '')
      if (game) {
        console.log(`[CnCNet] 房间 ${game.roomName} 加入列表 (${this.games.size + 1} 个)`)
        this.games.set(game.roomId, game)
        this.sendToRenderer('cncnet:room-updated', game)
      }
      return
    }

    // 游戏房间内的 CTCP 命令
    if (event.channel === this.hostedGame?.channelName || event.channel === this.joinedGameChannel) {
      this.handleRoomCtcp(event.channel ?? '', event.nick ?? '', event.message ?? '', data)
    }
  }

  /** launcher 专属命令（聊天形式）→ 复用现有事件名，renderer 端逻辑不变 */
  private handleLauncherChatCommand(channel: string, nick: string, tag: string, data: string): void {
    switch (tag) {
      case 'L-HI':
        this.sendToRenderer('cncnet:launcher-hi', { channel, nick, data })
        break
      case 'L-OK':
        this.sendToRenderer('cncnet:launcher-ok', { channel, nick })
        break
      case 'L-BAN':
        this.sendToRenderer('cncnet:launcher-ban', { channel, nick, data })
        break
      case 'L-MAP':
        this.sendToRenderer('cncnet:map-request', { channel, nick, data })
        break
      case 'L-PING':
        this.sendToRenderer('cncnet:launcher-ping', { channel, nick, data })
        break
      default:
        this.sendToRenderer('cncnet:room-ctcp', { channel, nick, tag, data })
    }
  }

  private handleRoomCtcp(channel: string, nick: string, tag: string, data: string): void {
    switch (tag) {
      case 'OR': // 玩家选项
        this.sendToRenderer('cncnet:player-options', { channel, nick, options: parseInt(data, 10) })
        break
      case 'R': // 准备状态
        this.sendToRenderer('cncnet:player-ready', { channel, nick, ready: parseInt(data, 10) })
        break
      case 'PO': // 玩家选项广播（host -> client）
        this.sendToRenderer('cncnet:player-options-broadcast', { channel, data })
        break
      case 'GO': // 游戏选项（host -> client）
        this.sendToRenderer('cncnet:game-options', { channel, data })
        break
      case 'START': // 启动游戏
        this.sendToRenderer('cncnet:game-start', { channel, data })
        break
      case 'GETREADY': // 准备通知（主机启动时提示玩家就绪）
        this.sendToRenderer('cncnet:get-ready', { channel })
        break
      case 'RETURN': // 返回大厅
        this.sendToRenderer('cncnet:return-to-lobby', { channel, nick })
        break
      case 'STRTD': // 进入游戏（已开始加载/游玩）
        this.sendToRenderer('cncnet:player-started', { channel, nick })
        break
      case 'FHSH': // 文件哈希
        this.sendToRenderer('cncnet:file-hash', { channel, nick, hash: data })
        break
      case 'TNLPNG': // 隧道 ping
        this.sendToRenderer('cncnet:tunnel-ping', { channel, nick, latency: data })
        break
      case 'LCKGME': // 主机提示需要先锁定房间（不能直接理解为已锁定）
        this.sendToRenderer('cncnet:lock-required', { channel })
        break
      case 'GSETTINGS': // 房间设置
        this.sendToRenderer('cncnet:game-settings', { channel, data })
        break
      case 'DR': // 掷骰子（参考格式：面数,结果1,结果2...）
        this.sendToRenderer('cncnet:dice-roll', { channel, nick, data })
        break
      // launcher 专属自定义命令（真实 MO 客户端不识别、会忽略）
      case 'L-HI': // launcher 握手：我是 launcher
        this.sendToRenderer('cncnet:launcher-hi', { channel, nick, data })
        break
      case 'L-OK': // 握手确认：对方是 launcher
        this.sendToRenderer('cncnet:launcher-ok', { channel, nick })
        break
      case 'L-BAN': // 禁用随机阵营清单（逗号分隔的具体阵营索引）
        this.sendToRenderer('cncnet:launcher-ban', { channel, nick, data })
        break
      case 'L-MAP': // 非房主想玩某张图（data = 地图名）
        this.sendToRenderer('cncnet:map-request', { channel, nick, data })
        break
      case 'L-PING': // 广播对某隧道服务器的延迟（data = 地址;延迟ms）
        this.sendToRenderer('cncnet:launcher-ping', { channel, nick, data })
        break
      default:
        this.sendToRenderer('cncnet:room-ctcp', { channel, nick, tag, data })
    }
  }

  private parseGameBroadcast(data: string, host: string): HostedGame | null {
    try {
      const parts = data.split(';')
      // 兼容 R8(11 字段) / R14(14 字段)：MO 客户端实际广播 R8 只有 11 段
      if (parts.length < 11) return null

      const protocolRevision = parts[0]
      const gameVersion = parts[1]
      const maxPlayersStr = parts[2]
      const channelName = parts[3]
      const roomName = parts[4]
      const flags = parts[5]
      const playersStr = parts[6]
      const map = parts[7]
      const gameMode = parts[8]
      const tunnelAddress = parts[9]
      // R14 才有 loadedGameId[10], skill[11], mapHash[12], options[13]
      const skillLevel = parts.length >= 12 ? parts[11] : '0'
      const mapHash = parts.length >= 13 ? parts[12] : undefined
      const packedOptions = parts.length >= 14 ? parts[13] : undefined

      const hasPassword = flags[1] === '1' || flags[1] === 'Y'
      // flags 第 0 位 = started（游戏已开始）
      const isStarted = flags[0] === '1'
      const players = playersStr ? playersStr.split(',').map(p => p.trim()).filter(Boolean) : []
      const roomId = `cncnet_${channelName}`

      // 计算频道密码（非 host 需要）
      const channelPassword = IrcClient.computePassword(channelName)

      return {
        roomId,
        roomName: roomName || `${host}的房间`,
        host,
        hostId: this.getOrCreateUserId(host),
        gameId: this.currentGameConfig!.gameId,
        gameMode,
        map,
        maxPlayers: parseInt(maxPlayersStr, 10) || 2,
        currentPlayers: players.length,
        hasPassword,
        isLocked: false,
        status: isStarted ? 'in-game' : 'waiting',
        createdAt: Date.now(),
        lastRefreshTime: Date.now(),
        protocolRevision,
        gameVersion,
        channelName,
        channelPassword,
        tunnelAddress: tunnelAddress || undefined,
        players,
        mapHash: mapHash || undefined,
        packedOptions: packedOptions || undefined,
        skillLevel: parseInt(skillLevel, 10) || 0
      }
    } catch (err) {
      console.error('Failed to parse game broadcast:', err)
      return null
    }
  }

  // ─── 工具方法 ────────────────────────────────────────

  private getOrCreateUserId(nick: string): string {
    if (!this.nickToUserId.has(nick)) {
      this.nickToUserId.set(nick, `irc_${nick.toLowerCase()}`)
    }
    return this.nickToUserId.get(nick)!
  }

  private roomUpdatedLogCount = 0

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // 退出瞬间 mainWindow 可能还在但 webContents 已销毁，send 会抛异常，必须防护
      try {
        this.mainWindow.webContents.send(channel, data)
        // 诊断：确认事件真的发出（房间列表收不到时排查）
        if (channel !== 'cncnet:room-updated' || (++this.roomUpdatedLogCount % 5 === 0)) {
          console.log(`[CnCNet] -> ${channel}${channel === 'cncnet:room-updated' ? ` (房间: ${(data as any)?.roomName})` : ''}`)
        }
      } catch {
        // 渲染进程已销毁，忽略
      }
    } else {
      console.error(`[CnCNet] sendToRenderer 失败: mainWindow 未设置或已销毁 (${channel})`)
    }
  }

  // ─── 获取数据 ────────────────────────────────────────

  getRooms(): HostedGame[] {
    return Array.from(this.games.values())
  }

  getChatMessages(channel?: string): ChatMessage[] {
    if (channel) {
      return this.chatMessages.filter(m => m.roomId === channel)
    }
    return this.chatMessages
  }

  getChannelUsers(channel: string): string[] {
    return Array.from(this.channelUsers.get(channel) ?? [])
  }

  getHostedGame(): HostedGame | null {
    return this.hostedGame
  }

  getJoinedGameChannel(): string | null {
    return this.joinedGameChannel
  }
}

// 单例
export const cncnet = new CnCNetManager()
