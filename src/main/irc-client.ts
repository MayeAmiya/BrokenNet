/**
 * IRC 客户端 —— 连接 GameSurge，用于 CnCNet 多人游戏
 *
 * 参考 xna-cncnet-client 的 Connection.cs 实现。
 * 完整实现 CnCNet 所需的 IRC 子集。
 */

import { createConnection, isIP, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'

export interface IrcServerEntry {
  host: string
  port: number
  /** 服务器显示名（如 "GameSurge 斯德哥尔摩, 瑞典"），用于日志 */
  label?: string
}

export interface IrcConfig {
  servers: IrcServerEntry[]
  nickname: string
  username: string
  realname: string
  /** SOCKS5 代理（挂梯子时走代理连 IRC，否则裸 TCP 直连真实 IP 可能被频道封禁） */
  proxy?: { host: string; port: number }
}

export interface IrcMessage {
  prefix?: string
  command: string
  params: string[]
  trailing?: string
}

export interface IrcEvent {
  type: 'connected' | 'disconnected' | 'connecting' | 'error' | 'message' | 'join' | 'part' | 'quit' | 'kick' | 'mode' | 'topic' | 'names' | 'ctcp' | 'numeric' | 'nick-change' | 'notice'
  channel?: string
  nick?: string
  message?: string
  args?: string[]
  raw?: string
  /** 第几次尝试（连接服务器） */
  attempt?: number
  /** 当前尝试的服务器 */
  host?: string
  port?: number
  /** 服务器显示名 */
  label?: string
  /** 001 Welcome 时真正连接成功的服务器（供上层记住最佳服务器） */
  rememberHost?: string
  rememberPort?: number
}

// CnCNet 协议常量
const CNCNET_PROTOCOL_REVISION = 'R14'
const GAME_VERSION = '1.0.0'

export class IrcClient extends EventEmitter {
  private socket: Socket | null = null
  private config: IrcConfig
  /** 当前连接成功的服务器（供 001 Welcome 时让上层记住真正连上的） */
  private currentServer: { host: string; port: number; label: string } | null = null
  private connected = false
  private registered = false
  private buffer = ''
  private serverIndex = 0
  private joinQueue: Array<{ channel: string; password?: string }> = []
  private joinedChannels = new Set<string>()
  private messageQueue: Array<{ line: string; priority: number }> = []
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  // 对照原版：初始连接是一次端口/服务器循环（每端口 3 秒超时，换下一个），
  // 全部失败 → OnConnectAttemptFailed（OFFLINE，不自动整轮重试）。手动重连。
  private maxReconnectAttempts = 0
  private failedServerIPs = new Set<string>()
  /** 换服/重连的挂起定时器（disconnect 时必须取消，否则断开后仍会自动连上） */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 主动断开标记：置位后不再尝试换服/重连 */
  private stopping = false

  constructor(config: IrcConfig) {
    super()
    this.config = config
  }

  // ─── 连接管理 ──────────────────────────────────────

  async connect(sortedServers?: Array<{ host: string; port: number; latency: number; label?: string }>): Promise<void> {
    if (this.connected) return
    this.serverIndex = 0
    this.reconnectAttempts = 0
    this.stopping = false
    // 清除可能残留的挂起重连定时器，避免断开后再连时旧定时器抢先触发
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // 如果提供了排序后的服务器，优先使用（保留 label）
    if (sortedServers && sortedServers.length > 0) {
      this.config.servers = sortedServers.map(s => ({ host: s.host, port: s.port, label: s.label }))
    }

    void this.tryConnect()
  }

  private async tryConnect(): Promise<void> {
    const server = this.config.servers[this.serverIndex]
    if (!server) {
      this.emit('irc', { type: 'error', message: '所有服务器连接失败' } as IrcEvent)
      return
    }

    const serverLabel = server.label ?? `${server.host}:${server.port}`
    console.log(`[IRC] Connecting to ${server.host}:${server.port} (${serverLabel})...`)

    // 通知上层：正在尝试某台服务器（连接状态可视化）
    this.emit('irc', {
      type: 'connecting',
      message: serverLabel,
      host: server.host,
      port: server.port,
      attempt: this.serverIndex + 1
    } as IrcEvent)

    // 强制 IPv4：Node 默认解析可能选 IPv6，而 IPv6 出口可能被频道 ban（正统客户端用 IPv4）。
    // 走代理时不强制（代理自己解析，出口 IP 决定）。
    let connectHost = server.host
    if (!this.config.proxy) {
      try {
        connectHost = await this.resolveHostIPv4(server.host)
      } catch { /* DNS 解析失败用原 host */ }
    }

    // 连接阶段超时 3 秒（对照 DTA BeginConnect + WaitOne(3s)）。
    // 注意：不能把 timeout 放进 createConnection——那会成为 socket idle 超时，
    // TCP 连上后 3 秒没收到数据就被误断（注册/AUTH 阶段稍慢就断）。
    // 挂代理时：TCP 连到代理，再 SOCKS5 握手连到真实服务器；握手成功才继续 IRC 注册。
    const connectTarget = this.config.proxy ?? { host: connectHost, port: server.port }
    const socket = createConnection({ host: connectTarget.host, port: connectTarget.port })
    this.socket = socket
    socket.setTimeout(3000)

    // 事件处理器全部绑定到本次 socket 实例，并在入口处校验
    // `this.socket === socket`：旧 socket 的迟到事件（timeout/close/error/data）
    // 在 this.socket 已被新连接替换或清理后直接忽略，防止误伤新连接。
    socket.once('connect', () => {
      if (this.socket !== socket) return
      const onReady = (): void => {
        this.connected = true
        this.registered = false
        this.buffer = ''
        this.reconnectAttempts = 0
        // 连上后取消 idle 超时，依赖 close/error 检测断线；不主动发 keepalive（服务器 PING 我们时回 PONG 即可）
        socket.setTimeout(0)
        this.currentServer = { host: server.host, port: server.port, label: serverLabel }
        this.register()
        this.emit('irc', { type: 'connected' } as IrcEvent)
      }
      if (this.config.proxy) {
        // SOCKS5 握手：把已连到代理的 socket 隧道到真实 IRC 服务器
        this.socks5Connect(socket, server.host, server.port).then(onReady).catch((err) => {
          console.error(`[IRC] SOCKS5 隧道失败 (${server.host}:${server.port}):`, err.message)
          socket.destroy()
        })
      } else {
        onReady()
      }
    })

    socket.on('data', (data) => {
      if (this.socket !== socket) return
      this.onData(data)
    })
    socket.on('error', (err) => {
      if (this.socket !== socket) return
      console.error(`[IRC] Error (${server.host}:${server.port}):`, err.message)
      this.emit('irc', {
        type: 'error',
        message: err.message,
        host: server.host,
        port: server.port,
        attempt: this.serverIndex + 1,
        label: serverLabel
      } as IrcEvent)
    })
    socket.on('timeout', () => {
      if (this.socket !== socket) return
      console.log(`[IRC] Timeout connecting to ${server.host}:${server.port}`)
      // 超时也作为错误推送，让 UI 能显示「连接超时」这一失败原因
      this.emit('irc', {
        type: 'error',
        message: `${serverLabel} 连接超时`,
        host: server.host,
        port: server.port,
        attempt: this.serverIndex + 1,
        label: serverLabel
      } as IrcEvent)
      socket.destroy()
    })
    socket.on('close', () => {
      // 旧 socket 的迟到 close：this.socket 已被替换或置空，忽略
      if (this.socket !== socket) return
      this.cleanup()
      this.serverIndex++
      // 主动断开：不再换服/重连，直接通知上层
      if (this.stopping) {
        this.emit('irc', { type: 'disconnected' } as IrcEvent)
        return
      }
      if (this.serverIndex < this.config.servers.length) {
        this.scheduleReconnect(() => void this.tryConnect(), 2000)
      } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
        // 重试所有服务器
        this.reconnectAttempts++
        this.serverIndex = 0
        console.log(`[IRC] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)
        this.scheduleReconnect(() => void this.tryConnect(), 4000)
      } else {
        this.emit('irc', { type: 'disconnected' } as IrcEvent)
      }
    })
  }

  /** 解析主机名到 IPv4 地址（已是 IP 则原样返回）。对齐正统客户端：GameSurge 走 IPv4，IPv6 出口可能被频道 ban。 */
  private resolveHostIPv4(host: string): Promise<string> {
    if (isIP(host)) return Promise.resolve(host)
    return new Promise((resolve, reject) => {
      dnsLookup(host, { family: 4 }, (err, address) => {
        if (err) reject(err)
        else resolve(address)
      })
    })
  }

  /**
   * SOCKS5 握手：在已连到代理的 socket 上隧道到目标 host:port。
   * 握手完成后把响应里可能混入的 IRC 数据接回 IRC 解析缓冲。
   */
  private socks5Connect(socket: Socket, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0)
      let stage: 'greeting' | 'connect' = 'greeting'
      const fail = (msg: string): void => {
        socket.removeListener('data', onData)
        socket.destroy()
        reject(new Error(msg))
      }
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk])
        if (stage === 'greeting') {
          if (buf.length < 2) return
          if (buf[1] !== 0x00) { fail('代理要求认证（未支持）'); return }
          buf = buf.subarray(2)
          stage = 'connect'
          const hostBuf = Buffer.from(host, 'utf-8')
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(port >> 8) & 0xff, port & 0xff])
          ])
          socket.write(req)
        }
        if (stage === 'connect') {
          if (buf.length < 4) return
          if (buf[1] !== 0x00) { fail('代理拒绝连接'); return }
          const atyp = buf[3]
          let respLen = 4
          if (atyp === 0x01) respLen = 4 + 4 + 2
          else if (atyp === 0x04) respLen = 4 + 16 + 2
          else if (atyp === 0x03) respLen = 4 + 1 + buf[4] + 2
          if (buf.length < respLen) return
          const leftover = buf.subarray(respLen)
          if (leftover.length > 0) this.buffer = leftover.toString('utf-8') + this.buffer
          socket.removeListener('data', onData)
          resolve()
        }
      }
      socket.on('data', onData)
      socket.write(Buffer.from([0x05, 0x01, 0x00])) // greeting: SOCKS5, 1 方法, 无认证
    })
  }

  /** 安排换服/重连（可被 disconnect 取消） */
  private scheduleReconnect(fn: () => void, delay: number): void {
    if (this.stopping) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      fn()
    }, delay)
  }

  private register(): void {
    this.send(`NICK ${this.config.nickname}`)
    this.send(`USER ${this.config.username} 0 * :${this.config.realname}`)
  }

  /** 更新注册身份（NICK/USER 用的昵称、用户名、实名）。CnCNet 服务器按 USER 格式识别客户端，重连前设置。 */
  setIdentity(nickname: string, username: string, realname: string): void {
    this.config.nickname = nickname
    this.config.username = username
    this.config.realname = realname
  }

  /** 更新 SOCKS5 代理（Settings 开关变化/重连时设置） */
  setProxy(proxy?: { host: string; port: number }): void {
    this.config.proxy = proxy
  }

  disconnect(): void {
    this.stopping = true
    // 取消挂起的换服/重连定时器——否则断开后 2~4 秒仍会自动连上
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.send('QUIT :Goodbye')
    this.cleanup()
    this.reconnectAttempts = this.maxReconnectAttempts // 阻止重连
    // cleanup() 里 removeAllListeners 会让 close 处理器不再触发，disconnected 事件
    // 永远发不出来（上层 cncnet 的状态、games、玩家数轮询就不会被清理，UI 一直显示已连接）。
    // 主动断开直接补发 disconnected，让上层走完状态清理。
    this.emit('irc', { type: 'disconnected' } as IrcEvent)
  }

  // ─── 频道操作 ──────────────────────────────────────

  join(channel: string, password?: string): void {
    this.joinedChannels.add(channel)
    if (!this.registered) {
      console.log(`[IRC] JOIN 入队(未注册): ${channel}`)
      this.joinQueue.push({ channel, password })
      return
    }
    const pwd = password ? ` ${password}` : ''
    console.log(`[IRC] JOIN 发送: ${channel}`)
    this.send(`JOIN ${channel}${pwd}`)
  }

  part(channel: string, reason?: string): void {
    this.joinedChannels.delete(channel)
    this.send(`PART ${channel}${reason ? ` :${reason}` : ''}`)
  }

  // ─── 消息发送 ──────────────────────────────────────

  privmsg(target: string, message: string): void {
    this.send(`PRIVMSG ${target} :${message}`)
  }

  notice(target: string, message: string): void {
    this.send(`NOTICE ${target} :${message}`)
  }

  /** 发送 CTCP 消息 — 使用 NOTICE（CnCNet 协议要求） */
  ctcp(target: string, tag: string, message: string): void {
    this.send(`NOTICE ${target} :\x01${tag} ${message}\x01`)
  }

  /** 发送 CTCP 响应（回复对方的 CTCP 查询） */
  ctcpReply(target: string, tag: string, message: string): void {
    this.send(`NOTICE ${target} :\x01${tag} ${message}\x01`)
  }

  mode(channel: string, modes: string, ...args: string[]): void {
    this.send(`MODE ${channel} ${modes} ${args.join(' ')}`.trim())
  }

  /** 踢出频道成员（房主踢人用） */
  kick(channel: string, nick: string, reason?: string): void {
    this.send(`KICK ${channel} ${nick}${reason ? ` :${reason}` : ''}`)
  }

  topic(channel: string, topic: string): void {
    this.send(`TOPIC ${channel} :${topic}`)
  }

  who(target: string): void {
    this.send(`WHO ${target}`)
  }

  whois(target: string): void {
    this.send(`WHOIS ${target}`)
  }

  away(message?: string): void {
    if (message) {
      this.send(`AWAY :${message}`)
    } else {
      this.send('AWAY')
    }
  }

  sendRaw(line: string): void {
    this.send(line)
  }

  /** 带优先级的消息队列 */
  queueMessage(line: string, priority: number = 0): void {
    this.messageQueue.push({ line, priority })
    this.messageQueue.sort((a, b) => a.priority - b.priority)
    this.processQueue()
  }

  private processQueue(): void {
    if (this.sendTimer || this.messageQueue.length === 0) return
    const msg = this.messageQueue.shift()!
    this.send(msg.line)
    // Flood protection: 100ms between messages
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null
      this.processQueue()
    }, 100)
  }

  // ─── 数据解析 ──────────────────────────────────────

  private send(line: string): void {
    if (!this.socket || !this.connected) return
    this.socket.write(line + '\r\n')
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString('utf-8')
    const lines = this.buffer.split('\r\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim()) this.parseLine(line)
    }
  }

  private parseLine(line: string): void {
    let pos = 0
    let prefix: string | undefined

    if (line[0] === ':') {
      const space = line.indexOf(' ', 1)
      prefix = line.slice(1, space)
      pos = space + 1
    }

    const space = line.indexOf(' ', pos)
    const command = space === -1 ? line.slice(pos) : line.slice(pos, space)
    pos = space === -1 ? line.length : space + 1

    const params: string[] = []
    let trailing: string | undefined

    while (pos < line.length) {
      if (line[pos] === ':') {
        trailing = line.slice(pos + 1)
        break
      }
      const nextSpace = line.indexOf(' ', pos)
      if (nextSpace === -1) {
        params.push(line.slice(pos))
        break
      }
      params.push(line.slice(pos, nextSpace))
      pos = nextSpace + 1
    }

    const msg: IrcMessage = { prefix, command, params, trailing }

    // PING
    if (command === 'PING') {
      this.send(`PONG ${trailing ?? params[0] ?? ''}`)
      return
    }

    // 数字回复
    const numeric = parseInt(command, 10)
    if (!isNaN(numeric)) {
      this.handleNumeric(numeric, params, trailing, prefix)
      return
    }

    const nick = prefix?.split('!')[0]
    const target = params[0]

    // CTCP in NOTICE（CnCNet 协议使用 NOTICE 发送 CTCP）
    if (command === 'NOTICE' && trailing && trailing.startsWith('\x01') && trailing.endsWith('\x01')) {
      const ctcp = trailing.slice(1, -1)
      const spaceIdx = ctcp.indexOf(' ')
      const tag = spaceIdx === -1 ? ctcp : ctcp.slice(0, spaceIdx)
      const ctcpMsg = spaceIdx === -1 ? '' : ctcp.slice(spaceIdx + 1)
      this.emit('irc', {
        type: 'ctcp',
        channel: target,
        nick,
        message: tag,
        args: [ctcpMsg],
        raw: line
      } as IrcEvent)
      return
    }

    // CTCP in PRIVMSG（兼容）
    if (command === 'PRIVMSG' && trailing && trailing.startsWith('\x01') && trailing.endsWith('\x01')) {
      const ctcp = trailing.slice(1, -1)
      const spaceIdx = ctcp.indexOf(' ')
      const tag = spaceIdx === -1 ? ctcp : ctcp.slice(0, spaceIdx)
      const ctcpMsg = spaceIdx === -1 ? '' : ctcp.slice(spaceIdx + 1)
      this.emit('irc', {
        type: 'ctcp',
        channel: target,
        nick,
        message: tag,
        args: [ctcpMsg],
        raw: line
      } as IrcEvent)
      return
    }

    switch (command) {
      case 'JOIN':
        this.emit('irc', { type: 'join', channel: target, nick, raw: line } as IrcEvent)
        break
      case 'PART':
        this.emit('irc', { type: 'part', channel: target, nick, message: trailing, raw: line } as IrcEvent)
        break
      case 'QUIT':
        this.emit('irc', { type: 'quit', nick, message: trailing, raw: line } as IrcEvent)
        break
      case 'KICK':
        this.emit('irc', { type: 'kick', channel: target, nick: params[1], message: trailing, raw: line } as IrcEvent)
        break
      case 'MODE':
        this.emit('irc', { type: 'mode', channel: target, args: params.slice(1), message: trailing, raw: line } as IrcEvent)
        break
      case 'TOPIC':
        this.emit('irc', { type: 'topic', channel: target, message: trailing, raw: line } as IrcEvent)
        break
      case 'NAMES':
        this.emit('irc', { type: 'names', channel: target, message: trailing, raw: line } as IrcEvent)
        break
      case 'NOTICE':
        this.emit('irc', { type: 'notice', channel: target, nick, message: trailing, raw: line } as IrcEvent)
        break
      case 'PRIVMSG':
        this.emit('irc', { type: 'message', channel: target, nick, message: trailing, raw: line } as IrcEvent)
        break
      default:
        this.emit('irc', { type: 'message', channel: target, nick, message: trailing ?? params.join(' '), raw: line } as IrcEvent)
    }
  }

  private handleNumeric(code: number, params: string[], trailing?: string, server?: string): void {
    this.emit('irc', {
      type: 'numeric',
      args: [String(code), ...params],
      message: trailing,
      host: server, // 服务器名（numeric 前缀），用于显示 "服务器: 欢迎信息"
      // 001 Welcome 时带上真正连接成功的服务器，供上层记住（TCP 通≠注册成功）
      ...(code === 1 && this.currentServer
        ? { label: this.currentServer.label, rememberHost: this.currentServer.host, rememberPort: this.currentServer.port }
        : {})
    } as IrcEvent)

    switch (code) {
      case 1: // RPL_WELCOME
        this.registered = true
        for (const { channel, password } of this.joinQueue) {
          this.join(channel, password)
        }
        this.joinQueue = []
        // 不主动发 keepalive：服务器会定期 PING 我们，回 PONG 即保活（对齐 xna）。
        // 之前每 30s 发一次 PING :keepalive 纯属多余，还可能被服务器当骚扰。
        break
      case 353: // RPL_NAMREPLY（频道成员列表，之前没处理导致玩家列表填不出来）
        this.emit('irc', {
          type: 'names',
          channel: params[2] ?? '',
          message: trailing ?? ''
        } as IrcEvent)
        break
      case 366: // RPL_ENDOFNAMES
        // 多行 NAMES 结束，重新发一次完整列表收尾（message 置空，主进程用已累积的 set）
        this.emit('irc', { type: 'names', channel: params[1] ?? '', message: '' } as IrcEvent)
        break
      case 376: // RPL_ENDOFMOTD
      case 422: // ERR_NOMOTD
        break
      case 433: // ERR_NICKNAMEINUSE
        this.config.nickname = this.config.nickname + '_'
        this.send(`NICK ${this.config.nickname}`)
        this.emit('irc', { type: 'nick-change', nick: this.config.nickname } as IrcEvent)
        break
      default:
        // 诊断：记录所有未处理的数字回复（如 JOIN 被拒 403/473/474 等）
        if (code >= 400) {
          console.log(`[IRC] 数字回复 ${code}: ${params.join(' ')} ${trailing ?? ''}`)
        }
        break
    }
  }

  private cleanup(): void {
    this.connected = false
    this.registered = false
    if (this.sendTimer) {
      clearTimeout(this.sendTimer)
      this.sendTimer = null
    }
    this.messageQueue = []
    this.joinedChannels.clear()
    this.joinQueue = []
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
  }

  // ─── 工具方法 ──────────────────────────────────────

  isConnected(): boolean {
    return this.connected && this.registered
  }

  getNickname(): string {
    return this.config.nickname
  }

  getJoinedChannels(): string[] {
    return Array.from(this.joinedChannels)
  }

  /** 计算 CnCNet 密码（SHA1 前 10 位） */
  static computePassword(channelName: string): string {
    return createHash('sha1').update(channelName).digest('hex').substring(0, 10)
  }
}

// ─── 服务器延迟排序 ───────────────────────────────────

export interface SortedServer {
  host: string
  port: number
  latency: number
  label?: string
}

/** DNS 解析 + TCP 连接延迟，按延迟排序服务器 */
export async function sortServersByLatency(
  servers: Array<{ host: string; port: number; label?: string }>
): Promise<SortedServer[]> {
  // 1. DNS 解析所有服务器
  const resolved = await Promise.allSettled(
    servers.map(async (s) => {
      const ip = await new Promise<string>((resolve, reject) => {
        // 强制 IPv4（对齐连接：GameSurge 走 IPv4，IPv6 出口可能被频道 ban）
        dnsLookup(s.host, { family: 4 }, (err, address) => {
          if (err) reject(err)
          else resolve(address)
        })
      })
      return { ...s, ip }
    })
  )

  // 2. 按 IP 去重，合并端口
  const byIP = new Map<string, Array<{ host: string; port: number; label?: string }>>()
  for (const r of resolved) {
    if (r.status === 'fulfilled') {
      const existing = byIP.get(r.value.ip) ?? []
      existing.push({ host: r.value.host, port: r.value.port, label: r.value.label })
      byIP.set(r.value.ip, existing)
    }
  }

  // 3. 如果 DNS 全部失败，回退到原始服务器列表（不测速，逐个尝试）——
  //    否则会拿到空列表直接连不上
  if (byIP.size === 0) {
    return servers.map((s) => ({
      host: s.host,
      port: s.port,
      latency: Number.MAX_SAFE_INTEGER,
      label: s.label
    }))
  }

  // 4. TCP 连接延迟测每个 IP
  const results: SortedServer[] = []
  for (const [ip, servers] of byIP) {
    const latency = await pingHost(ip)
    for (const { host, port, label } of servers) {
      results.push({ host, port, latency, label })
    }
  }

  // 5. 按延迟排序（ping 失败的排最后）
  results.sort((a, b) => a.latency - b.latency)
  return results
}

function pingHost(host: string, timeout: number = 400): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = createConnection({ host, port: 6667, timeout }, () => {
      const latency = Date.now() - start
      socket.destroy()
      resolve(latency)
    })
    socket.on('error', () => resolve(Number.MAX_SAFE_INTEGER))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(Number.MAX_SAFE_INTEGER)
    })
  })
}
