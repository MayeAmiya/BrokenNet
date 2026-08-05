/**
 * CnCNet 隧道服务器管理
 *
 * 从 CnCNet HTTP 端点获取隧道列表，ping 延迟，
 * host 选择隧道，分配端口用于游戏转发。
 */

import { get as httpGet } from 'node:http'
import { createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface TunnelServer {
  address: string
  port: number
  /** 服务器显示名（如 [EU]Hottwire.me） */
  name: string
  country: string
  countryCode: string
  /** 当前负载（已连客户端数） */
  clients: number
  /** 容量 */
  maxClients: number
  official: boolean
  /** 本机到该服务器的 TCP 连接延迟 */
  latency: number
}

const TUNNEL_LIST_URL = 'http://cncnet.org/master-list'
const TUNNEL_REFRESH_INTERVAL = 120_000 // 2 minutes

let cachedTunnels: TunnelServer[] = []
let lastRefresh = 0

/**
 * 获取隧道服务器列表（带缓存）
 */
export async function getTunnelServers(forceRefresh = false): Promise<TunnelServer[]> {
  const now = Date.now()
  if (!forceRefresh && cachedTunnels.length > 0 && now - lastRefresh < TUNNEL_REFRESH_INTERVAL) {
    return cachedTunnels
  }

  try {
    const raw = await fetchTunnelList()
    const tunnels = await Promise.all(
      raw.map(async (t) => ({
        ...t,
        latency: await pingHost(t.address, 400)
      }))
    )
    // 按延迟排序，ping 失败的放最后
    tunnels.sort((a, b) => a.latency - b.latency)
    cachedTunnels = tunnels
    lastRefresh = now
    console.log(`[Tunnel] Loaded ${tunnels.length} tunnel servers, best latency: ${tunnels[0]?.latency ?? 'N/A'}ms`)
    return tunnels
  } catch (err) {
    console.error('[Tunnel] Failed to load tunnel list:', err)
    return cachedTunnels
  }
}

/**
 * 选择最佳隧道
 */
export async function selectBestTunnel(): Promise<TunnelServer | null> {
  const tunnels = await getTunnelServers()
  return tunnels[0] ?? null
}

/** HTTP 请求超时（隧道列表/端口分配都可能挂起，超时必须失败而不是永久阻塞游戏启动） */
const HTTP_TIMEOUT_MS = 10_000
/** 响应大小上限，防止恶意/异常超大响应无限累积内存 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * 带超时 + 状态码校验 + 大小上限的 HTTP GET。
 * 原版 httpGet 无超时：cncnet.org/隧道服务器接受连接但迟迟不返回数据时，
 * Promise 永不 resolve → 创建房间/启动游戏流程永久卡死。
 */
function httpGetWithTimeout(url: string, timeoutMs: number, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume() // 丢弃剩余数据
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      let aborted = false
      res.on('data', (chunk) => {
        data += chunk
        if (data.length > maxBytes) {
          aborted = true
          req.destroy(new Error('响应超过大小上限'))
        }
      })
      res.on('end', () => {
        if (!aborted) resolve(data)
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

/** 隧道 HTTP 控制端口的标准端口（master-list 里的端口可能是游戏端口，HTTP /request 大多在 50000） */
const TUNNEL_HTTP_PORT = 50000

/** 解析隧道返回的端口：可能是 signed 16-bit（负值 +65536 才是真端口），且必须在合法端口范围内 */
function normalizeTunnelPort(raw: string): string {
  const n = parseInt(raw.trim(), 10)
  if (isNaN(n)) return ''
  const p = n < 0 ? n + 65536 : n
  if (p < 1 || p > 65535) return ''
  return String(p)
}

/**
 * 从隧道服务器分配端口
 * GET http://<tunnel>:<port>/request?clients=<playerCount>
 * 先试传入端口，无响应则回退标准 HTTP 端口 50000（对齐实测：列表端口 50001 的隧道在 50000 响应）。
 */
export async function requestTunnelPorts(
  tunnelAddress: string,
  tunnelPort: number,
  playerCount: number
): Promise<string[]> {
  const portsToTry = tunnelPort === TUNNEL_HTTP_PORT ? [tunnelPort] : [tunnelPort, TUNNEL_HTTP_PORT]
  // 隧道至少要求 2 个客户端（clients=1 会返回 400）；单人类玩家（其余 AI）也按 2 请求
  const requestClients = Math.max(2, playerCount)

  for (const port of portsToTry) {
    const url = `http://${tunnelAddress}:${port}/request?clients=${requestClients}`
    try {
      const data = await httpGetWithTimeout(url, HTTP_TIMEOUT_MS, MAX_RESPONSE_BYTES)
      // 响应格式：纯整数端口数组，如 "[30000,30001,...]"
      const ports = data
        .replace(/[\[\]]/g, '')
        .split(',')
        .map(normalizeTunnelPort)
        .filter(Boolean)
      if (ports.length >= playerCount) return ports
    } catch (e) {
      console.error(`[Tunnel] 端口请求失败 ${url}:`, (e as Error).message)
    }
  }
  throw new Error('隧道端口分配失败（列表端口与 50000 均无响应）')
}

/**
 * 生成 CnCNet 隧道地址字符串
 */
export function formatTunnelAddress(tunnel: TunnelServer): string {
  return `${tunnel.address}:${tunnel.port}`
}

// ─── 内部方法 ──────────────────────────────────────

async function fetchTunnelList(): Promise<Array<Omit<TunnelServer, 'latency'>>> {
  const data = await httpGetWithTimeout(TUNNEL_LIST_URL, HTTP_TIMEOUT_MS, MAX_RESPONSE_BYTES)
  // 格式（分号分隔，首行是表头）：
  // address;country;countrycode;name;password;clients;maxclients;official;latitude;longitude;version;distance
  const lines = data.split('\n').filter(l => l.trim())
  const tunnels: Array<Omit<TunnelServer, 'latency'>> = []
  const seen = new Set<string>()
  for (const line of lines) {
    const parts = line.split(';')
    if (parts.length < 11) continue
    const [addrPort, country, countryCode, name, password, clientsStr, maxClientsStr, officialStr, , , versionStr] = parts
    // 对齐 xna TunnelHandler：需要密码的跳过、协议版本不支持的跳过（SUPPORTED_TUNNEL_VERSION=2）
    if (password !== '0') continue
    if (parseInt(versionStr, 10) !== 2) continue
    const lastColon = addrPort.lastIndexOf(':')
    const address = addrPort.substring(0, lastColon)
    const port = parseInt(addrPort.substring(lastColon + 1), 10)
    if (!address || isNaN(port)) continue
    const key = `${address}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    tunnels.push({
      address,
      port,
      name: name || address,
      country,
      countryCode,
      clients: parseInt(clientsStr, 10) || 0,
      maxClients: parseInt(maxClientsStr, 10) || 0,
      official: officialStr?.trim() === '1'
    })
  }
  return tunnels
}

/** 测量到主机的 TCP 连接延迟（比 ICMP 更能反映隧道可达性） */
function pingHost(host: string, timeout: number = 1500): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now()
    const sock = createConnection({ host, port: 50000, timeout })
    sock.once('connect', () => {
      const ms = Date.now() - start
      sock.destroy()
      resolve(ms)
    })
    sock.once('error', () => {
      sock.destroy()
      resolve(Number.MAX_SAFE_INTEGER)
    })
    sock.once('timeout', () => {
      sock.destroy()
      resolve(Number.MAX_SAFE_INTEGER)
    })
  })
}

const MAP_FILE_EXTENSIONS = ['.map', '.yrm', '.mmx', '.umx']

/**
 * 计算地图哈希 —— 与参考客户端一致：读取地图文件内容算完整 SHA1（40 位 hex），
 * 用于房间广播 / 本地地图按哈希匹配。文件缺失或读取失败时退回路径哈希（不影响创建房间流程）。
 * @param mapFilePath 地图路径（可能相对游戏目录且无扩展名）
 * @param baseDir 游戏目录（路径相对时用于定位真实文件）
 */
export function computeMapHash(mapFilePath: string, baseDir?: string): string {
  try {
    let p = mapFilePath
    if (!path.isAbsolute(p) && baseDir) {
      const candidates: string[] = [path.join(baseDir, p)]
      if (!path.extname(p)) {
        for (const ext of MAP_FILE_EXTENSIONS) candidates.push(path.join(baseDir, p + ext))
      }
      const found = candidates.find((c) => existsSync(c))
      if (found) p = found
    }
    return createHash('sha1').update(readFileSync(p)).digest('hex')
  } catch {
    return createHash('sha1').update(mapFilePath).digest('hex')
  }
}
