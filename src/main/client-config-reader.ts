import path from 'path'
import { loadIniFile } from './ini-parser'
import type { IniClientConfig } from '../shared/types/ini-layout'

export function readClientConfig(gamePath: string): IniClientConfig {
  const iniPath = path.join(gamePath, 'Resources', 'ClientDefinitions.ini')
  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('Settings') ?? ini.getSection('General')

  const gameExeRaw = sec?.getString('GameExecutableNames') ?? 'gamemd.exe'
  const forbiddenRaw = sec?.getString('ForbiddenFiles') ?? ''
  const requiredRaw = sec?.getString('RequiredFiles') ?? ''
  const modesRaw = sec?.getString('AllowedCustomGameModes') ?? ''

  // Parse links
  const linksSec = ini.getSection('Links')
  const links: Record<string, string> = {}
  if (linksSec) {
    for (const key of linksSec.keys_names()) {
      links[key] = linksSec.getString(key)
    }
  }

  return {
    gameType: sec?.getString('ClientGameType', 'YR') ?? 'YR',
    launcherExe: sec?.getString('LauncherExe', 'MentalOmegaClient.exe') ?? 'MentalOmegaClient.exe',
    gameExecutableNames: gameExeRaw.split(',').map(s => s.trim()),
    gameLauncherExecutableName: sec?.getString('GameLauncherExecutableName', 'Syringe.exe') ?? 'Syringe.exe',
    settingsFile: sec?.getString('SettingsFile', 'RA2MO.ini') ?? 'RA2MO.ini',
    extraCommandLineParams: sec?.getString('ExtraCommandLineParams') ?? '',
    localGame: sec?.getString('LocalGame', 'MO') ?? 'MO',
    longGameName: sec?.getString('LongGameName', 'Mental Omega') ?? 'Mental Omega',
    discordAppId: sec?.getString('DiscordAppId') ?? '',
    registryInstallPath: sec?.getString('RegistryInstallPath') ?? '',
    cncNetLiveStatusIdentifier: sec?.getString('CnCNetLiveStatusIdentifier') ?? '',
    mpMapsPath: sec?.getString('MPMapsPath') ?? '',
    battleFSFileName: sec?.getString('BattleFSFileName') ?? '',
    minimumRenderWidth: sec?.getInt('MinimumRenderWidth', 800) ?? 800,
    minimumRenderHeight: sec?.getInt('MinimumRenderHeight', 600) ?? 600,
    minimumIngameWidth: sec?.getInt('MinimumIngameWidth', 800) ?? 800,
    minimumIngameHeight: sec?.getInt('MinimumIngameHeight', 600) ?? 600,
    maxNameLength: sec?.getInt('MaxNameLength', 14) ?? 14,
    forbiddenFiles: forbiddenRaw ? forbiddenRaw.split(',').map(s => s.trim()) : [],
    requiredFiles: requiredRaw ? requiredRaw.split(',').map(s => s.trim()) : [],
    allowedCustomGameModes: modesRaw ? modesRaw.split(',').map(s => s.trim()) : [],
    links
  }
}

export function readDTACnCNetConfig(gamePath: string): Record<string, string> {
  const iniPath = path.join(gamePath, 'Resources', 'DTACnCNetClient.ini')
  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('General')
  if (!sec) return {}

  const result: Record<string, string> = {}
  for (const key of sec.keys_names()) {
    result[key] = sec.getString(key)
  }
  return result
}

/** 一个 IRC 服务器条目：host|Name|port,port,port */
export interface IrcServerEntry {
  host: string
  label: string
  ports: number[]
}

/**
 * 从 ClientDefinitions.ini 的 [IRCServers] 段读取服务器列表。
 * 对照原版 Connection.cs：配置里有就用配置的，没有则回退默认单服务器多端口。
 */
export function readIRCServers(gamePath: string): IrcServerEntry[] {
  const iniPath = path.join(gamePath, 'Resources', 'ClientDefinitions.ini')
  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('IRCServers')
  if (sec) {
    const servers: IrcServerEntry[] = []
    for (const key of sec.keys_names()) {
      const raw = sec.getString(key)
      const parts = raw.split('|')
      if (parts.length >= 3) {
        const ports = parts[2].split(',').map((p) => parseInt(p.trim(), 10)).filter((p) => p > 0)
        if (parts[0] && parts[1] && ports.length > 0) {
          servers.push({ host: parts[0], label: parts[1], ports })
        }
      }
    }
    if (servers.length > 0) return servers
  }

  // 回退默认：GameSurge 官方多节点（gamesurge.net/servers 确认），每个节点多端口。
  // DNS 解析时联网取 IP，逐个尝试，多试几个节点更容易连上。
  return [
    { host: 'irc.gamesurge.net', label: 'GameSurge (自动)', ports: [6667, 6660, 6666, 6668, 6669] },
    { host: 'Stockholm.SE.EU.GameSurge.net', label: 'GameSurge 斯德哥尔摩, 瑞典', ports: [6660, 6666, 6667, 6668, 6669] },
    { host: 'Burstfire.UK.EU.GameSurge.net', label: 'GameSurge 伦敦, 英国', ports: [6667, 6668, 7000] },
    { host: 'LAN-Team.DE.EU.GameSurge.net', label: 'GameSurge 纽伦堡, 德国', ports: [6660, 6666, 6667, 6668, 6669] },
    { host: 'Krypt.CA.US.GameSurge.net', label: 'GameSurge 圣安娜, 美国', ports: [6666, 6667, 6668, 6669] },
    { host: 'NuclearFallout.WA.US.GameSurge.net', label: 'GameSurge 西雅图, 美国', ports: [6667, 5960] },
    { host: 'Prothid.NY.US.GameSurge.net', label: 'GameSurge 纽约, 美国', ports: [5960, 6660, 6666, 6667, 6668, 6669, 6697] }
  ]
}
