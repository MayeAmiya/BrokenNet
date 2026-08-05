import { app, shell, BrowserWindow, ipcMain } from 'electron'
import appIcon from '../../icon.jpg?asset'
import { join } from 'node:path'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

// 主进程启动即写日志
try { appendFileSync('crash.log', `[${new Date().toISOString()}] main process started\n`) } catch {}

import { registerFsHandlers } from './fs-ops'
import { registerModHandlers } from './mod-ops'
import { registerOptionsHandlers } from './options-ops'
import { launchGame, isGameRunning, getGamePid } from './game-launcher'
import { cncnet, CNCNET_GAMES } from './cncnet'
import { mapPreviewWindow, type MapPreviewWindowContent } from './map-preview-window'
import { requestTunnelPorts, formatTunnelAddress, getTunnelServers } from './tunnel-server'
import type { SpawnIniOptions } from './spawn-ini'
import { loadIniFile } from './ini-parser'
import { readGameOptions } from './game-options-reader'
import { readRenderers, getDefaultRenderer } from './renderer-reader'
import { readClientConfig, readDTACnCNetConfig } from './client-config-reader'
import { loadWindowLayout } from './ini-layout-parser'
import { applyRenderer, cleanRenderer, writeRendererWindowedMode, readRendererWindowedMode, rendererUsesCustomWindowedOption, readRendererResolution, writeRendererResolution } from './renderer-manager'
import { readGlobalForcedSpawnOptions, readGameModeForcedSpawnOptions, applyAllForcedSpawnOptions, generateSpawnIni } from './forced-spawn-options'
import { loadGameModes, loadMaps } from './gamemode-reader'
import { applyMapCode, getMapCodeFiles } from './map-code-helper'
import { findMapFileByName } from './map-preview'
import { loadMapPreviewData, loadMapPreviewByName, findMapByHash, findMapInfoByHash, findMapHashByName } from './map-preview'
import { parseFileSettingConfig, executeFileSetting, checkFilesAvailability } from './file-setting'
import { loadKeyboardBindings, loadKeyMappings, getKeyboardBindingsWithMappings, writeKeyMappings } from './keyboard-reader'
import { checkFileIntegrity, getMissingRequiredFiles } from './file-integrity'
import { loadCampaignData } from './campaign-reader'
import { loadTranslationFile, loadTranslations, findBestTranslation, translate } from './translation-reader'
import { loadPrivacyNotification } from './privacy-notification'
import { loadStatisticsWindow } from './statistics-reader'
import { loadUserDefaults } from './user-defaults'
import { loadMusicThemes } from './music-theme-reader'
import { readMultiplayerLobbyOptions } from './game-options-reader'
import { applyPlayground } from './playground-manager'

const isDev = !app.isPackaged

// 全局错误处理 — 防止未捕获异常导致闪退
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err)
  try { appendFileSync('crash.log', `[${new Date().toISOString()}] uncaughtException: ${err.message}\n${err.stack}\n`) } catch {}
})
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason)
  try { appendFileSync('crash.log', `[${new Date().toISOString()}] unhandledRejection: ${reason}\n`) } catch {}
})

let mainWindow: BrowserWindow | null = null

/** 默认启动器窗口尺寸：1440×900 */
const DEFAULT_WIN_W = 1440
const DEFAULT_WIN_H = 900

/** 读取保存的启动器分辨率（config.json windowSize="WxH"），无则用默认 */
function readSavedWindowSize(): { width: number; height: number } {
  try {
    const cfg = JSON.parse(readFileSync(join(app.getPath('userData'), 'config.json'), 'utf-8'))
    const s = String(cfg['windowSize'] ?? '')
    const m = s.match(/^(\d+)x(\d+)$/i)
    if (m) {
      const w = parseInt(m[1], 10)
      const h = parseInt(m[2], 10)
      if (w >= 900 && h >= 560) return { width: w, height: h }
    }
  } catch {
    /* 无配置 */
  }
  return { width: DEFAULT_WIN_W, height: DEFAULT_WIN_H }
}

function createWindow(): void {
  try { appendFileSync('crash.log', `[${new Date().toISOString()}] createWindow start\n`) } catch {}
  const winSize = readSavedWindowSize()
  mainWindow = new BrowserWindow({
    width: winSize.width,
    height: winSize.height,
    minWidth: 900,
    minHeight: 560,
    show: false,
    icon: appIcon, // 窗口/任务栏图标
    // Win10 风格：不用系统标题栏，自己画
    frame: false,
    backgroundColor: '#1f1f1f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 是 CJS，可以开沙箱。渲染进程碰不到 Node，
      // 能力只能从 preload 暴露的那几个白名单方法走。
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    logErr('ready-to-show', 'showing window')
    mainWindow?.show()
  })
  mainWindow.on('closed', () => (mainWindow = null))
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logErr('render-process-gone', `${details.reason} exit=${details.exitCode}`)
  })
  mainWindow.on('unresponsive', () => {
    logErr('window', 'unresponsive')
  })
  mainWindow.webContents.on('did-finish-load', () => {
    logErr('did-finish-load', 'renderer loaded OK')
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logErr('did-fail-load', `${code}: ${desc}`)
  })
  mainWindow.webContents.on('dom-ready', () => {
    logErr('dom-ready', 'DOM ready')
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logErr('render-process-gone', `webContents crashed: ${details?.reason ?? ''}`)
  })

  // 站外链接一律丢给系统浏览器，不在启动器里开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 只在开发期放开 devtools / 刷新，打包后这些键不响应
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isDev || input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    } else if (input.control && key === 'r') {
      mainWindow?.webContents.reload()
      event.preventDefault()
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 关键：窗口创建后才能把 mainWindow 交给 cncnet，
  // 否则 registerCncnetHandlers 里 mainWindow 还是 null，
  // 所有 cncnet 事件（连接状态等）都发不到 renderer。
  cncnet.setMainWindow(mainWindow)

  try { appendFileSync('crash.log', `[${new Date().toISOString()}] createWindow done\n`) } catch {}
}

/** 大厅悬停地图预览的独立置顶窗口（渲染进程悬停/移动/离开时触发） */
function registerMapPreviewHandlers(): void {
  ipcMain.on('map-preview:show', (_e, content: MapPreviewWindowContent) => {
    mapPreviewWindow.show(content)
  })
  ipcMain.on('map-preview:move', () => {
    mapPreviewWindow.move()
  })
  ipcMain.on('map-preview:hide', () => {
    mapPreviewWindow.hide()
  })
}

function registerWindowHandlers(): void {
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('win:close', () => mainWindow?.close())
  ipcMain.handle('win:is-maximized', () => mainWindow?.isMaximized() ?? false)

  // 设置启动器分辨率：改窗口尺寸 + 保存到 config.json（下次启动生效）
  ipcMain.handle('win:set-size', (_e, width: number, height: number) => {
    if (mainWindow && width >= 900 && height >= 560) {
      mainWindow.setSize(width, height)
      mainWindow.center()
    }
    try {
      const configPath = join(app.getPath('userData'), 'config.json')
      let cfg: Record<string, string> = {}
      try { cfg = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* 无配置 */ }
      cfg['windowSize'] = `${width}x${height}`
      writeFileSync(configPath, JSON.stringify(cfg, null, 2))
    } catch {
      /* 保存失败忽略 */
    }
  })
}

function registerGameHandlers(): void {
  ipcMain.handle('game:launch', (_event, opts: {
    gameDir: string
    exe: string
    spawnOptions: SpawnIniOptions
    args?: string[]
  }) => {
    return launchGame({
      ...opts,
      onExit: (code) => {
        mainWindow?.webContents.send('game:exited', code)
      }
    })
  })

  ipcMain.handle('game:is-running', () => {
    return isGameRunning()
  })

  ipcMain.handle('game:pid', () => {
    return getGamePid()
  })
}

function registerCncnetHandlers(): void {
  if (mainWindow) {
    cncnet.setMainWindow(mainWindow)
  }

  ipcMain.handle('cncnet:connect', (_event, gamePath: string, nickname?: string) => {
    return cncnet.connect(gamePath, nickname)
  })

  ipcMain.handle('cncnet:disconnect', () => {
    cncnet.disconnect()
  })

  ipcMain.handle('cncnet:is-connected', () => {
    return cncnet.isConnected()
  })

  ipcMain.handle('cncnet:get-nickname', () => {
    return cncnet.getNickname()
  })

  ipcMain.handle('cncnet:join-channel', (_event, gameId: string) => {
    console.log(`[IPC] cncnet:join-channel gameId=${gameId} connected=${cncnet.isConnected()}`)
    cncnet.joinGameChannel(gameId)
  })

  ipcMain.handle('cncnet:leave-channel', () => {
    cncnet.leaveGameChannel()
  })

  ipcMain.handle('cncnet:send-message', (_event, channel: string, message: string) => {
    cncnet.sendMessage(channel, message)
  })

  ipcMain.handle('cncnet:get-rooms', () => {
    return cncnet.getRooms()
  })

  ipcMain.handle('cncnet:get-chat-messages', (_event, channel?: string) => {
    return cncnet.getChatMessages(channel)
  })

  ipcMain.handle('cncnet:get-channel-users', (_event, channel: string) => {
    return cncnet.getChannelUsers(channel)
  })

  ipcMain.handle('cncnet:get-games', () => {
    return Object.keys(CNCNET_GAMES)
  })

  // 创建房间
  ipcMain.handle('cncnet:create-room', (_event, params: {
    roomName: string
    maxPlayers: number
    map: string
    mapFilePath: string
    gameMode: string
    password?: string
    packedOptions?: string
  }) => {
    return cncnet.createRoom(params)
  })

  // 加入房间
  ipcMain.handle('cncnet:join-room', (_event, game: any, password?: string) => {
    cncnet.joinRoom(game, password)
  })

  // 离开房间
  ipcMain.handle('cncnet:leave-room', () => {
    cncnet.leaveRoom()
  })

  // host 开始游戏：选隧道（房主指定优先，否则最佳） → 分配端口 → 广播 START（对齐参考格式） → 返回启动参数
  ipcMain.handle('cncnet:host-start', async (_e, channel: string, players: Array<{ name: string }>, tunnelAddress?: string) => {
    try {
      // 隧道必须由房主在房间里明确选定（全员共用同一个服务器）；没选不给启动
      if (!tunnelAddress) return { ok: false, error: '请先选择隧道服务器' }
      const tunnels = await getTunnelServers()
      const tunnel = tunnels.find(t => `${t.address}:${t.port}` === tunnelAddress)
      if (!tunnel) return { ok: false, error: '无法连接选定的隧道服务器' }
      const ports = await requestTunnelPorts(tunnel.address, tunnel.port, players.length)
      if (ports.length < players.length) return { ok: false, error: '隧道端口分配失败' }
      // 参考格式：START <UniqueGameID>;<name>;<tunnelAddress:assignedPort>;<name>;...
      const gameId = String(Math.floor(1000000 + Math.random() * 9000000))
      const assignments = players.map((p, i) => `${p.name};${tunnel.address}:${ports[i]}`)
      const startData = `${gameId};${assignments.join(';')}`
      console.log(`[hostStart] 隧道=${tunnelAddress} START=${startData}`)
      cncnet.sendStart(channel, startData)
      return { ok: true, tunnel: formatTunnelAddress(tunnel), ports, startData, gameId }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 房主换图：更新托管房间地图并重广播 GAME（大厅房间列表刷新）
  ipcMain.handle('cncnet:update-map', (_e, map: string, mapFilePath: string) => {
    return cncnet.setHostedMap(map, mapFilePath)
  })

  ipcMain.handle('cncnet:update-mode', (_e, gameMode: string) => {
    cncnet.setHostedGameMode(gameMode)
  })

  ipcMain.handle('cncnet:flush-game-broadcast', () => {
    cncnet.flushBroadcastGame()
  })

  // 房主踢出/封禁玩家
  ipcMain.handle('cncnet:kick', (_e, channel: string, nick: string) => {
    cncnet.sendKick(channel, nick)
  })
  ipcMain.handle('cncnet:ban', (_e, channel: string, nick: string) => {
    cncnet.sendBan(channel, nick)
  })

  // 获取隧道服务器列表（含延迟缓存），客户端启动时按地址解析隧道控制端口用
  ipcMain.handle('tunnel:servers', async () => {
    return getTunnelServers()
  })

  // 发送 CTCP 命令
  // launcher 专属命令：以普通聊天消息发送（不走 CTCP，只有本 launcher 解析）
  ipcMain.handle('cncnet:send-chat-command', (_event, channel: string, tag: string, data: string) => {
    cncnet.sendChatCommand(channel, tag, data)
  })

  ipcMain.handle('cncnet:send-ctcp', (_event, channel: string, tag: string, data: string) => {
    switch (tag) {
      case 'OR': cncnet.sendPlayerOptions(channel, parseInt(data, 10)); break
      case 'R': cncnet.sendReady(channel, parseInt(data, 10)); break
      case 'START': cncnet.sendStart(channel, data); break
      case 'RETURN': cncnet.sendReturn(channel); break
      // 房间内协同（数据由渲染层按协议格式组装）
      case 'PO':
      case 'GO':
      case 'GETREADY':
      case 'LCKGME':
      case 'STRTD':
      case 'FHSH':
      case 'TNLPNG':
      case 'DR':
      // launcher 专属自定义命令
      case 'L-HI':
      case 'L-OK':
      case 'L-BAN':
      case 'L-MAP':
      case 'L-PING':
        cncnet.sendCtcpRaw(channel, tag, data); break
    }
  })

  // 锁定/解锁房间（MODE +i / -i）
  ipcMain.handle('cncnet:lock', (_event, channel: string, locked: boolean) => {
    cncnet.sendLock(channel, locked)
  })

  // 房主更换隧道服务器并重新广播（全队用同一个隧道）
  ipcMain.handle('cncnet:set-tunnel', (_event, tunnelAddress: string) => {
    cncnet.setHostedTunnel(tunnelAddress)
  })

  // 获取托管的游戏
  ipcMain.handle('cncnet:get-hosted-game', () => {
    return cncnet.getHostedGame()
  })

  // 获取加入的频道
  ipcMain.handle('cncnet:get-joined-channel', () => {
    return cncnet.getJoinedGameChannel()
  })
}

function registerIniHandlers(): void {
  ipcMain.handle('ini:load', (_event, filePath: string) => {
    const ini = loadIniFile(filePath)
    const sections: Record<string, Record<string, string>> = {}
    for (const name of ini.getSectionNames()) {
      const sec = ini.getSection(name)
      if (!sec) continue
      const keys: Record<string, string> = {}
      for (const k of sec.keys_names()) {
        keys[k] = sec.getString(k)
      }
      sections[name] = keys
    }
    return sections
  })

  ipcMain.handle('game-options:load', (_event, gamePath: string) => {
    return readGameOptions(gamePath)
  })

  ipcMain.handle('renderers:load', (_event, gamePath: string) => {
    return readRenderers(gamePath)
  })

  ipcMain.handle('renderers:default', (_event, gamePath: string) => {
    return getDefaultRenderer(gamePath)
  })

  ipcMain.handle('client-config:load', (_event, gamePath: string) => {
    return readClientConfig(gamePath)
  })

  ipcMain.handle('client-config:dta', (_event, gamePath: string) => {
    return readDTACnCNetConfig(gamePath)
  })

  ipcMain.handle('ini-layout:load', (_event, gamePath: string, windowIniName: string, windowName?: string) => {
    return loadWindowLayout(gamePath, windowIniName, windowName)
  })

  // Renderer management
  ipcMain.handle('renderer:apply', (_event, gamePath: string, resourcesPath: string, rendererKey: string) => {
    const ini = loadIniFile(require('path').join(resourcesPath, 'Renderers.ini'))
    return applyRenderer(gamePath, resourcesPath, rendererKey, ini)
  })

  ipcMain.handle('renderer:clean', (_event, gamePath: string, resourcesPath: string, rendererKey: string) => {
    const ini = loadIniFile(require('path').join(resourcesPath, 'Renderers.ini'))
    cleanRenderer(gamePath, resourcesPath, rendererKey, ini)
  })

  ipcMain.handle('renderer:write-windowed', (_event, gamePath: string, resourcesPath: string, rendererKey: string, windowed: boolean, borderless: boolean) => {
    const ini = loadIniFile(require('path').join(resourcesPath, 'Renderers.ini'))
    return writeRendererWindowedMode(gamePath, resourcesPath, rendererKey, ini, windowed, borderless)
  })

  ipcMain.handle('renderer:read-windowed', (_event, gamePath: string, rendererKey: string) => {
    const resourcesPath = require('path').join(gamePath, 'Resources')
    const ini = loadIniFile(require('path').join(resourcesPath, 'Renderers.ini'))
    return readRendererWindowedMode(gamePath, rendererKey, ini)
  })

  ipcMain.handle('renderer:uses-custom-windowed', (_event, rendererKey: string, resourcesPath: string) => {
    const ini = loadIniFile(require('path').join(resourcesPath, 'Renderers.ini'))
    return rendererUsesCustomWindowedOption(rendererKey, ini)
  })

  ipcMain.handle('renderer:read-resolution', (_event, gamePath: string, rendererKey: string) => {
    const resourcesPath = require('path').join(gamePath, 'Resources')
    const ini = loadIniFile(require('path').join(resourcesPath, 'Renderers.ini'))
    return readRendererResolution(gamePath, rendererKey, ini)
  })

  ipcMain.handle('renderer:write-resolution', (_event, gamePath: string, resourcesPath: string, rendererKey: string, width: number, height: number) => {
    const ini = loadIniFile(require('path').join(resourcesPath, 'Renderers.ini'))
    return writeRendererResolution(gamePath, resourcesPath, rendererKey, ini, width, height)
  })

  // ForcedSpawnIniOptions
  ipcMain.handle('forced-spawn:global', (_event, gamePath: string) => {
    return readGlobalForcedSpawnOptions(gamePath)
  })

  ipcMain.handle('forced-spawn:gamemode', (_event, gamePath: string, modeName: string) => {
    return readGameModeForcedSpawnOptions(gamePath, modeName)
  })

  ipcMain.handle('forced-spawn:apply', (_event, gamePath: string, modeName: string, mapPath: string | undefined, baseOptions: Record<string, string>) => {
    return applyAllForcedSpawnOptions(gamePath, modeName, mapPath, baseOptions)
  })

  ipcMain.handle('forced-spawn:generate', (_event, gamePath: string, modeName: string, mapPath: string | undefined, baseOptions: Record<string, string>) => {
    return generateSpawnIni(gamePath, modeName, mapPath, baseOptions)
  })

  // Game modes and maps
  ipcMain.handle('gamemode:load', (_event, gamePath: string) => {
    return loadGameModes(gamePath)
  })

  ipcMain.handle('maps:load', (_event, gamePath: string) => {
    return loadMaps(gamePath)
  })

  // Map code：原 .map 只读，应用后写到 <gamePath>/spawnmap.ini（对齐 xna WriteMap）
  ipcMain.handle('map-code:apply', (_event, gamePath: string, mapIniPath: string, modeMapCodeName: string, modeName: string, customIniPaths: string[]) => {
    return applyMapCode(gamePath, mapIniPath, modeMapCodeName, modeName, customIniPaths)
  })

  ipcMain.handle('map-code:files', (_event, gamePath: string, modeMapCodeName: string, randomizedNames: string[], randomizedCount: number) => {
    return getMapCodeFiles(gamePath, modeMapCodeName, randomizedNames, randomizedCount)
  })

  // 按地图 SHA1 解析本地地图信息（跨语言同步：中文/英文 description 不同但 SHA1 相同）
  ipcMain.handle('map:find-by-hash', (_e, gamePath: string, mapHash: string) => {
    return findMapInfoByHash(gamePath, mapHash)
  })

  // 按地图名（显示名/路径）算 SHA1（L-MAP 请求带 hash 用）
  ipcMain.handle('map:hash-by-name', (_e, gamePath: string, mapName: string) => {
    return findMapHashByName(gamePath, mapName)
  })

  // 启动前生成 spawnmap.ini：解析地图文件 + 应用 Map Code（对齐 xna WriteMap，原图只读）
  // customIniPaths = 已勾选游戏选项的 MapCode 文件（INI/Game Options/*.ini），对齐 xna chkBox.ApplyMapCode
  ipcMain.handle('map:write-spawnmap', (_e, gameDir: string, mapRelPath: string, mapCodeIniName: string, gameModeName: string, customIniPaths: string[] = []) => {
    const mapFilePath = findMapFileByName(gameDir, mapRelPath)
    if (!mapFilePath) return { ok: false, error: `找不到地图文件: ${mapRelPath}` }
    return applyMapCode(gameDir, mapFilePath, mapCodeIniName, gameModeName, customIniPaths)
  })

  // Map preview
  ipcMain.handle('map-preview:load', (_event, gamePath: string, mapFilePath: string, mapHash?: string) => {
    const empty = { previewPath: null, previewAvailable: false, mapWidth: 1024, mapHeight: 768, startingLocations: [], extraTextures: [], briefing: '', isCoop: false }
    try {
      if (!gamePath) return empty
      // 优先按地图内容 SHA1 匹配本地地图（真实客户端广播的哈希，命中即能出图）
      if (mapHash) {
        const byHash = findMapByHash(gamePath, mapHash)
        if (byHash) return loadMapPreviewData(gamePath, byHash)
      }
      if (!mapFilePath) return empty
      if (mapFilePath.includes('/') || mapFilePath.includes('\\') || /\.\w+$/.test(mapFilePath)) {
        return loadMapPreviewData(gamePath, mapFilePath)
      }
      return loadMapPreviewByName(gamePath, mapFilePath)
    } catch (e) {
      console.error('map-preview:load error:', e)
      return empty
    }
  })

  // File setting checkboxes
  ipcMain.handle('file-setting:execute', (_event, gamePath: string, resourcesPath: string, config: any, isChecked: boolean, reversed: boolean) => {
    executeFileSetting(gamePath, resourcesPath, config, isChecked, reversed)
  })

  ipcMain.handle('file-setting:check-availability', (_event, resourcesPath: string, files: any[]) => {
    return checkFilesAvailability(resourcesPath, files)
  })

  // Keyboard bindings
  ipcMain.handle('keyboard:load', (_event, gamePath: string) => {
    return getKeyboardBindingsWithMappings(gamePath)
  })

  ipcMain.handle('keyboard:mappings', (_event, gamePath: string) => {
    return loadKeyMappings(gamePath)
  })

  ipcMain.handle('keyboard:save', (_event, gamePath: string, bindings: Array<{ command: string; currentKey: string; defaultKey: string }>) => {
    writeKeyMappings(gamePath, bindings)
    return { ok: true }
  })

  // Playground 工作区
  ipcMain.handle('playground:apply', (_event, gameId: string, modSetId: string) => {
    return applyPlayground({
      gameId,
      modSetId,
      onProgress: (percent, label) => {
        // 窗口可能已关闭（webContents 销毁），send 会抛异常，必须防护
        try {
          mainWindow?.webContents.send('playground:progress', { percent, label })
        } catch { /* 忽略 */ }
      }
    })
  })

  // File integrity
  ipcMain.handle('integrity:check', (_event, gamePath: string) => {
    return checkFileIntegrity(gamePath)
  })

  ipcMain.handle('integrity:missing-required', (_event, gamePath: string) => {
    return getMissingRequiredFiles(gamePath)
  })

  // Campaign
  ipcMain.handle('campaign:load', (_event, gamePath: string) => {
    return loadCampaignData(gamePath)
  })

  // Translation
  ipcMain.handle('translation:load', (_event, filePath: string) => {
    return loadTranslationFile(filePath)
  })

  ipcMain.handle('translation:load-all', (_event, dir: string) => {
    return loadTranslations(dir)
  })

  // Privacy notification
  ipcMain.handle('privacy:load', (_event, gamePath: string) => {
    return loadPrivacyNotification(gamePath)
  })

  // Statistics window
  ipcMain.handle('statistics:load', (_event, gamePath: string) => {
    return loadStatisticsWindow(gamePath)
  })

  // User defaults
  ipcMain.handle('user-defaults:load', (_event, gamePath: string) => {
    return loadUserDefaults(gamePath)
  })

  // Music themes
  ipcMain.handle('music:load', (_event, gamePath: string) => {
    return loadMusicThemes(gamePath)
  })

  // Multiplayer lobby options (from GameOptions.ini)
  ipcMain.handle('game-options:multiplayer-lobby', (_event, gamePath: string) => {
    return readMultiplayerLobbyOptions(gamePath)
  })
}

// 任务栏图标分组和通知归属要靠这个，Windows 上必须设
app.setAppUserModelId('com.brokennet.app')

// 捕获未处理异常
function logErr(label: string, err: unknown) {
  try { appendFileSync('crash.log', `[${new Date().toISOString()}] ${label}: ${String(err)}\n${(err as any)?.stack ?? ''}\n`) } catch {}
}
process.on('uncaughtException', (err) => { logErr('uncaughtException', err) })
process.on('unhandledRejection', (reason) => { logErr('unhandledRejection', reason) })

// 单实例：第二次启动时激活已有窗口，而不是再开一个
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    try {
      registerWindowHandlers()
      registerGameHandlers()
      registerCncnetHandlers()
      registerMapPreviewHandlers()
      registerFsHandlers()
      registerModHandlers()
      registerOptionsHandlers()
      registerIniHandlers()
      createWindow()
    } catch (e) {
      logErr('init-error', e)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前销毁辅助预览窗 + 优雅断连：先退房/退频道（发 PART/关闭广播），再断开 IRC，不能直接关
app.on('before-quit', () => {
  mapPreviewWindow.destroy()
  cncnet.leaveRoom()
  cncnet.leaveGameChannel()
  cncnet.disconnect()
})
