import { contextBridge, ipcRenderer } from 'electron'

/**
 * 渲染进程能碰到的全部能力，就这些。
 * 沙箱开着，渲染层拿不到 Node，想加能力必须在这里显式开口子。
 */

/** BattleClient.ini 单个关卡（campaign:load 返回载荷），Enabled=False = 未开放 */
type CampaignMissionPayload = {
  id: string; description: string; summary: string; scenario: string
  side: number; sideName: string; longDescription: string
  buildOffAlly: boolean; cd: number; finalMovie: string; enabled: boolean
}

const api = {
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:is-maximized'),
    setSize: (width: number, height: number): Promise<void> => ipcRenderer.invoke('win:set-size', width, height)
  },
  fs: {
    hardlink: (
      src: string,
      dest: string,
      overwrite = false
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:hardlink', src, dest, overwrite),
    linkCount: (path: string): Promise<number> => ipcRenderer.invoke('fs:link-count', path),
    openMapsDir: (gameId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:open-maps-dir', gameId),
    openReplaysDir: (gameId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:open-replays-dir', gameId),
    openPackagesDir: (gameId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:open-packages-dir', gameId),
    openPlaygroundDir: (gameId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:open-playground-dir', gameId),
    listMaps: (gameId: string): Promise<{
      ok: boolean
      files: Array<{ name: string; path: string; size: number }>
    }> => ipcRenderer.invoke('fs:list-maps', gameId),
    listReplays: (gameId: string): Promise<{
      ok: boolean
      files: Array<{ name: string; path: string; size: number }>
    }> => ipcRenderer.invoke('fs:list-replays', gameId),
    selectDirectory: (): Promise<{ path: string | null }> =>
      ipcRenderer.invoke('fs:select-directory'),
    /** 首启引导：在基目录下创建 BrokenNetLib 并设为资源库（已存在则复用不覆写） */
    initResourceDir: (basePath: string): Promise<{ ok: boolean; path?: string; reused?: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:init-resource-dir', basePath),
    getConfig: (key: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:get-config', key),
    setConfig: (key: string, value: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:set-config', key, value),
    createGameDirs: (gameConfig: {
      id: string
      name: string
      installPath: string
      generalsPath?: string
      gtdPath?: string
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:create-game-dirs', gameConfig),
    updateGameConfig: (gameId: string, config: {
      id?: string
      name?: string
      installPath?: string
      generalsPath?: string
      useGtd?: boolean
      gtdPath?: string
      useGenTool?: boolean
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:update-game-config', gameId, config),
    loadAllGames: (): Promise<{
      id: string
      name: string
      installPath: string
      generalsPath?: string
      useGtd?: boolean
      gtdPath?: string
      useGenTool?: boolean
    }[]> =>
      ipcRenderer.invoke('fs:load-all-games')
  },
  mod: {
    fetchRepoMods: (gameType: 'zh' | 'gen'): Promise<{
      ok: boolean
      data?: {
        modDatas: Array<{ ModName: string; ModLink: string; ModPatches: string[]; ModAddons: string[] }>
        executables: Array<{ ModName: string; ModLink: string; DependencyName: string }>
      }
      error?: string
    }> => ipcRenderer.invoke('mod:fetch-repo-mods', gameType),
    fetchManifest: (url: string): Promise<{
      ok: boolean
      manifest?: Record<string, unknown>
      error?: string
    }> => ipcRenderer.invoke('mod:fetch-manifest', url),
    download: (url: string, gameId: string, modName: string, overwrite = false): Promise<{
      ok: boolean
      path?: string
      alreadyInstalled?: boolean
      error?: string
    }> => ipcRenderer.invoke('mod:download', url, gameId, modName, overwrite),
    pauseDownload: (modName: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('mod:pause-download', modName),
    cancelDownload: (modName: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('mod:cancel-download', modName),
    getVersion: (gameId: string, modName: string): Promise<{ ok: boolean; version: string }> =>
      ipcRenderer.invoke('mod:get-version', gameId, modName),
    setVersion: (gameId: string, modName: string, version: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('mod:set-version', gameId, modName, version),
    onDownloadProgress: (callback: (data: {
      modName: string
      status: string
      progress: number
      downloaded: number
      total: number
      error?: string
    }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => callback(data as any)
      ipcRenderer.on('mod:download-progress', handler)
      return () => {
        ipcRenderer.removeListener('mod:download-progress', handler)
      }
    }
  },
  package: {
    list: (gameId: string): Promise<{ ok: boolean; packages: Array<{ name: string; path: string }>; error?: string }> =>
      ipcRenderer.invoke('package:list', gameId),
    importFolder: (gameId: string): Promise<{ ok: boolean; imported?: string[]; error?: string }> =>
      ipcRenderer.invoke('package:import-folder', gameId),
    importArchive: (gameId: string): Promise<{ ok: boolean; imported?: string[]; error?: string }> =>
      ipcRenderer.invoke('package:import-archive', gameId),
    importPaths: (gameId: string, paths: string[]): Promise<{ ok: boolean; imported?: string[]; error?: string }> =>
      ipcRenderer.invoke('package:import-paths', gameId, paths),
    delete: (gameId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('package:delete', gameId, name)
  },
  sound: {
    read: (gameId: string): Promise<Record<string, number>> => ipcRenderer.invoke('sound:read', gameId),
    write: (gameId: string, values: Record<string, number>): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sound:write', gameId, values)
  },
  quality: {
    // 画质档位：RA2MO.ini [Options] DetailLevel 0/1/2（低/中/高）
    read: (gameId: string): Promise<number> => ipcRenderer.invoke('quality:read', gameId),
    write: (gameId: string, level: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('quality:write', gameId, level)
  },
  modset: {
    list: (gameId: string): Promise<{ ok: boolean; modSets: Array<{ id: string; name: string; description: string; background?: string; packages: Array<{ id: string; name: string }> }>; error?: string }> =>
      ipcRenderer.invoke('modset:list', gameId),
    save: (gameId: string, modSets: Array<{ id: string; name: string; description: string; background?: string; packages: Array<{ id: string; name: string }> }>): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('modset:save', gameId, modSets),
    ensureDefault: (gameId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('modset:ensure-default', gameId)
  },
  options: {
    read: (gameType: 'zh' | 'gen'): Promise<{
      ok: boolean
      options?: Record<string, string>
      error?: string
    }> => ipcRenderer.invoke('options:read', gameType),
    write: (gameType: 'zh' | 'gen', options: Record<string, string>): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('options:write', gameType, options),
    applyDefault: (gameType: 'zh' | 'gen'): Promise<{
      ok: boolean
      options?: Record<string, string>
      error?: string
    }> => ipcRenderer.invoke('options:apply-default', gameType),
    getResolutions: (gameType: 'zh' | 'gen'): Promise<{
      list: string[]
      current: string
    }> => ipcRenderer.invoke('options:get-resolutions', gameType)
  },
  game: {
    launch: (opts: {
      gameDir: string
      exe: string
      spawnOptions: Record<string, unknown>
      args?: string[]
      /** ZH 视角高度：>0 时启动前原地改写 GameData.ini 所在 .big（playground 硬链接的） */
      cameraHeight?: number
    }): Promise<{ ok: boolean; error?: string; pid?: number }> =>
      ipcRenderer.invoke('game:launch', opts),
    isRunning: (): Promise<boolean> =>
      ipcRenderer.invoke('game:is-running'),
    pid: (): Promise<number | undefined> =>
      ipcRenderer.invoke('game:pid'),
    onExited: (callback: (code: number | null) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, code: number | null) => callback(code)
      ipcRenderer.on('game:exited', handler)
      return () => {
        ipcRenderer.removeListener('game:exited', handler)
      }
    }
  },
  cncnet: {
    connect: (gamePath: string, nickname?: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:connect', gamePath, nickname),
    disconnect: (): Promise<void> =>
      ipcRenderer.invoke('cncnet:disconnect'),
    isConnected: (): Promise<boolean> =>
      ipcRenderer.invoke('cncnet:is-connected'),
    getNickname: (): Promise<string> =>
      ipcRenderer.invoke('cncnet:get-nickname'),
    joinChannel: (gameId: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:join-channel', gameId),
    leaveChannel: (): Promise<void> =>
      ipcRenderer.invoke('cncnet:leave-channel'),
    sendMessage: (channel: string, message: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:send-message', channel, message),
    getRooms: (): Promise<Array<{
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
      status: string
      channelName: string
      players: string[]
      gameVersion?: string
      skillLevel?: number
      mapHash?: string
      packedOptions?: string
      protocolRevision?: string
      tunnelAddress?: string
    }>> => ipcRenderer.invoke('cncnet:get-rooms'),
    getChatMessages: (channel?: string): Promise<Array<{
      id: string
      roomId: string
      userId: string
      userName: string
      content: string
      timestamp: number
      type: string
    }>> => ipcRenderer.invoke('cncnet:get-chat-messages', channel),
    getChannelUsers: (channel: string): Promise<string[]> =>
      ipcRenderer.invoke('cncnet:get-channel-users', channel),
    getGames: (): Promise<string[]> =>
      ipcRenderer.invoke('cncnet:get-games'),
    createRoom: (params: {
      roomName: string; maxPlayers: number; map: string
      mapFilePath: string; gameMode: string; password?: string; packedOptions?: string
    }): Promise<any> => ipcRenderer.invoke('cncnet:create-room', params),
    joinRoom: (game: any, password?: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:join-room', game, password),
    leaveRoom: (): Promise<void> =>
      ipcRenderer.invoke('cncnet:leave-room'),
    sendCtcp: (channel: string, tag: string, data: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:send-ctcp', channel, tag, data),
    sendChatCommand: (channel: string, tag: string, data: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:send-chat-command', channel, tag, data),
    updateMap: (map: string, mapFilePath: string): Promise<{ mapHash: string }> =>
      ipcRenderer.invoke('cncnet:update-map', map, mapFilePath),
    updateMode: (gameMode: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:update-mode', gameMode),
    flushGameBroadcast: (): Promise<void> =>
      ipcRenderer.invoke('cncnet:flush-game-broadcast'),
    writeSpawnMap: (gameDir: string, mapRelPath: string, mapCodeIniName: string, gameModeName: string, customIniPaths?: string[]): Promise<{ ok: boolean; spawnMapPath?: string; error?: string }> =>
      ipcRenderer.invoke('map:write-spawnmap', gameDir, mapRelPath, mapCodeIniName, gameModeName, customIniPaths ?? []),
    kick: (channel: string, nick: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:kick', channel, nick),
    ban: (channel: string, nick: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:ban', channel, nick),
    lock: (channel: string, locked: boolean): Promise<void> =>
      ipcRenderer.invoke('cncnet:lock', channel, locked),
    setTunnel: (tunnelAddress: string): Promise<void> =>
      ipcRenderer.invoke('cncnet:set-tunnel', tunnelAddress),
    hostStart: (channel: string, players: Array<{ name: string }>, tunnelAddress?: string): Promise<{
      ok: boolean; tunnel?: string; ports?: string[]; startData?: string; gameId?: string; error?: string
    }> => ipcRenderer.invoke('cncnet:host-start', channel, players, tunnelAddress),
    getHostedGame: (): Promise<any> =>
      ipcRenderer.invoke('cncnet:get-hosted-game'),
    getJoinedChannel: (): Promise<string | null> =>
      ipcRenderer.invoke('cncnet:get-joined-channel'),
    onConnecting: (callback: (data: { server: string; attempt: number; total: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { server: string; attempt: number; total: number }) => callback(data)
      ipcRenderer.on('cncnet:connecting', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:connecting', handler)
      }
    },
    onConnected: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('cncnet:connected', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:connected', handler)
      }
    },
    onDisconnected: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('cncnet:disconnected', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:disconnected', handler)
      }
    },
    onError: (callback: (data: { message?: string; server?: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { message?: string; server?: string }) => callback(data)
      ipcRenderer.on('cncnet:error', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:error', handler)
      }
    },
    onNickChange: (callback: (data: { nick: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { nick: string }) => callback(data)
      ipcRenderer.on('cncnet:nick-change', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:nick-change', handler)
      }
    },
    onLatencyTested: (callback: (data: { available: number; fast: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { available: number; fast: number }) => callback(data)
      ipcRenderer.on('cncnet:latency-tested', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:latency-tested', handler)
      }
    },
    onPlayerCount: (callback: (data: { count: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { count: number }) => callback(data)
      ipcRenderer.on('cncnet:player-count', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:player-count', handler)
      }
    },
    onWelcome: (callback: (data: { text: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { text: string }) => callback(data)
      ipcRenderer.on('cncnet:welcome', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:welcome', handler)
      }
    },
    onServerMessage: (callback: (data: { text: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { text: string }) => callback(data)
      ipcRenderer.on('cncnet:server-message', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:server-message', handler)
      }
    },
    onRoomUpdated: (callback: (room: any) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, room: any) => callback(room)
      ipcRenderer.on('cncnet:room-updated', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:room-updated', handler)
      }
    },
    onRoomRemoved: (callback: (data: { roomId: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { roomId: string }) => callback(data)
      ipcRenderer.on('cncnet:room-removed', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:room-removed', handler)
      }
    },
    onMessage: (callback: (msg: any) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, msg: any) => callback(msg)
      ipcRenderer.on('cncnet:message', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:message', handler)
      }
    },
    onNames: (callback: (data: { channel: string; users: string[] }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; users: string[] }) => callback(data)
      ipcRenderer.on('cncnet:names', handler)
      return () => {
        ipcRenderer.removeListener('cncnet:names', handler)
      }
    },
    onPlayerOptions: (callback: (data: { channel: string; nick: string; options: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; options: number }) => callback(data)
      ipcRenderer.on('cncnet:player-options', handler)
      return () => { ipcRenderer.removeListener('cncnet:player-options', handler) }
    },
    onPlayerReady: (callback: (data: { channel: string; nick: string; ready: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; ready: number }) => callback(data)
      ipcRenderer.on('cncnet:player-ready', handler)
      return () => { ipcRenderer.removeListener('cncnet:player-ready', handler) }
    },
    onGameOptions: (callback: (data: { channel: string; nick?: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick?: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:game-options', handler)
      return () => { ipcRenderer.removeListener('cncnet:game-options', handler) }
    },
    onPlayerOptionsBroadcast: (callback: (data: { channel: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:player-options-broadcast', handler)
      return () => { ipcRenderer.removeListener('cncnet:player-options-broadcast', handler) }
    },
    onMode: (callback: (data: { channel: string; mode: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; mode: string }) => callback(data)
      ipcRenderer.on('cncnet:mode', handler)
      return () => { ipcRenderer.removeListener('cncnet:mode', handler) }
    },
    onGameStart: (callback: (data: { channel: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:game-start', handler)
      return () => { ipcRenderer.removeListener('cncnet:game-start', handler) }
    },
    onReturnToLobby: (callback: (data: { channel: string; nick: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string }) => callback(data)
      ipcRenderer.on('cncnet:return-to-lobby', handler)
      return () => { ipcRenderer.removeListener('cncnet:return-to-lobby', handler) }
    },
    onKicked: (callback: (data: { channel: string; nick: string; message?: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; message?: string }) => callback(data)
      ipcRenderer.on('cncnet:kicked', handler)
      return () => { ipcRenderer.removeListener('cncnet:kicked', handler) }
    },
    onPlayerStarted: (callback: (data: { channel: string; nick: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string }) => callback(data)
      ipcRenderer.on('cncnet:player-started', handler)
      return () => { ipcRenderer.removeListener('cncnet:player-started', handler) }
    },
    onGetReady: (callback: (data: { channel: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string }) => callback(data)
      ipcRenderer.on('cncnet:get-ready', handler)
      return () => { ipcRenderer.removeListener('cncnet:get-ready', handler) }
    },
    onLockRequired: (callback: (data: { channel: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string }) => callback(data)
      ipcRenderer.on('cncnet:lock-required', handler)
      return () => { ipcRenderer.removeListener('cncnet:lock-required', handler) }
    },
    onGameSettings: (callback: (data: { channel: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:game-settings', handler)
      return () => { ipcRenderer.removeListener('cncnet:game-settings', handler) }
    },
    onDiceRoll: (callback: (data: { channel: string; nick: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:dice-roll', handler)
      return () => { ipcRenderer.removeListener('cncnet:dice-roll', handler) }
    },
    onLauncherHi: (callback: (data: { channel: string; nick: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:launcher-hi', handler)
      return () => { ipcRenderer.removeListener('cncnet:launcher-hi', handler) }
    },
    onLauncherOk: (callback: (data: { channel: string; nick: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string }) => callback(data)
      ipcRenderer.on('cncnet:launcher-ok', handler)
      return () => { ipcRenderer.removeListener('cncnet:launcher-ok', handler) }
    },
    onLauncherBan: (callback: (data: { channel: string; nick: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:launcher-ban', handler)
      return () => { ipcRenderer.removeListener('cncnet:launcher-ban', handler) }
    },
    onMapRequest: (callback: (data: { channel: string; nick: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:map-request', handler)
      return () => { ipcRenderer.removeListener('cncnet:map-request', handler) }
    },
    onLauncherPing: (callback: (data: { channel: string; nick: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:launcher-ping', handler)
      return () => { ipcRenderer.removeListener('cncnet:launcher-ping', handler) }
    },
    onChannelError: (callback: (data: { code: number; channel: string; message: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { code: number; channel: string; message: string }) => callback(data)
      ipcRenderer.on('cncnet:channel-error', handler)
      return () => { ipcRenderer.removeListener('cncnet:channel-error', handler) }
    },
    onRoomCtcp: (callback: (data: { channel: string; nick: string; tag: string; data: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { channel: string; nick: string; tag: string; data: string }) => callback(data)
      ipcRenderer.on('cncnet:room-ctcp', handler)
      return () => { ipcRenderer.removeListener('cncnet:room-ctcp', handler) }
    }
  },
  tunnel: {
    servers: (): Promise<Array<{
      address: string; port: number; latency: number; official: boolean
      name: string; country: string; countryCode: string; clients: number; maxClients: number
    }>> => ipcRenderer.invoke('tunnel:servers')
  },
  playground: {
    apply: (gameId: string, modSetId: string): Promise<{
      ok: boolean; playgroundPath?: string; mapsPath?: string; error?: string
    }> => ipcRenderer.invoke('playground:apply', gameId, modSetId),
    onProgress: (callback: (data: { percent: number; label: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { percent: number; label: string }) => callback(data)
      ipcRenderer.on('playground:progress', handler)
      return () => {
        ipcRenderer.removeListener('playground:progress', handler)
      }
    }
  },
  ini: {
    load: (filePath: string): Promise<Record<string, Record<string, string>>> =>
      ipcRenderer.invoke('ini:load', filePath),
    loadWindowLayout: (gamePath: string, windowIniName: string, windowName?: string): Promise<{
      size?: { width: number; height: number }
      controls: Array<{
        name: string
        type: string
        location?: { x: number; y: number }
        size?: { width: number; height: number }
        visible?: boolean
        enabled?: boolean
        text?: string
        toolTip?: string
        url?: string
        backgroundTexture?: string
        drawMode?: string
        distanceFromRightBorder?: number
        distanceFromBottomBorder?: number
        fillWidth?: number
        fillHeight?: number
        remapColor?: string
        font?: string
        children?: any[]
        extra?: Record<string, string>
      }>
    }> => ipcRenderer.invoke('ini-layout:load', gamePath, windowIniName, windowName)
  },
  gameOptions: {
    load: (gamePath: string): Promise<{
      sides: string[]
      mpColors: Array<{ name: string; r: number; g: number; b: number; uiColorId: number }>
      forcedSpawnIniOptions: Record<string, string>
      multiplayerLobby: {
        checkBoxes: Array<{
          controlName: string
          optionName: string
          text: string
          spawnIniOption: string
          checked: boolean
          location: { x: number; y: number }
          toolTip: string
          customIniPath?: string
        }>
        dropDowns: Array<{
          controlName: string
          optionName: string
          items: string[]
          itemLabels?: string[]
          defaultIndex: number
          spawnIniOption: string
          dataWriteMode: string
          location: { x: number; y: number }
          size: { width: number; height: number }
          toolTip: string
        }>
        labels: Array<{
          controlName: string
          text: string
          location: { x: number; y: number }
        }>
        sharpenImages: boolean
        defaultWindowSize: string
      }
      skirmishLobby: {
        checkBoxes: any[]
        dropDowns: any[]
        labels: any[]
        sharpenImages: boolean
        defaultWindowSize: string
      }
    }> => ipcRenderer.invoke('game-options:load', gamePath)
  },
  renderers: {
    load: (gamePath: string): Promise<Array<{
      key: string
      uiName: string
      dllName?: string
      configFileName?: string
      resConfigFileName?: string
      additionalFiles?: string[]
      useQres?: boolean
      windowedModeSection?: string
      windowedModeKey?: string
      borderlessWindowedModeKey?: string
      isBorderlessReversed?: boolean
      isDxWnd?: boolean
      disallowedOperatingSystems?: string[]
    }>> => ipcRenderer.invoke('renderers:load', gamePath),
    getDefault: (gamePath: string): Promise<string> =>
      ipcRenderer.invoke('renderers:default', gamePath)
  },
  clientConfig: {
    load: (gamePath: string): Promise<{
      gameType: string
      launcherExe: string
      gameExecutableNames: string[]
      gameLauncherExecutableName: string
      settingsFile: string
      extraCommandLineParams: string
      localGame: string
      longGameName: string
      discordAppId: string
      registryInstallPath: string
      cncNetLiveStatusIdentifier: string
      mpMapsPath: string
      battleFSFileName: string
      minimumRenderWidth: number
      minimumRenderHeight: number
      minimumIngameWidth: number
      minimumIngameHeight: number
      maxNameLength: number
      defaultFrameSendRate: number
      forbiddenFiles: string[]
      requiredFiles: string[]
      allowedCustomGameModes: string[]
      links: Record<string, string>
    }> => ipcRenderer.invoke('client-config:load', gamePath),
    getDTA: (gamePath: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('client-config:dta', gamePath)
  },
  rendererManager: {
    apply: (gamePath: string, resourcesPath: string, rendererKey: string): Promise<{
      ok: boolean; error?: string; rendererKey: string; filesCopied: string[]
    }> => ipcRenderer.invoke('renderer:apply', gamePath, resourcesPath, rendererKey),
    clean: (gamePath: string, resourcesPath: string, rendererKey: string): Promise<void> =>
      ipcRenderer.invoke('renderer:clean', gamePath, resourcesPath, rendererKey),
    writeWindowed: (gamePath: string, resourcesPath: string, rendererKey: string, windowed: boolean, borderless: boolean, gameId?: string): Promise<boolean> =>
      ipcRenderer.invoke('renderer:write-windowed', gamePath, resourcesPath, rendererKey, windowed, borderless, gameId),
    readWindowed: (gamePath: string, rendererKey: string): Promise<{ windowed: boolean; borderless: boolean }> =>
      ipcRenderer.invoke('renderer:read-windowed', gamePath, rendererKey),
    usesCustomWindowed: (rendererKey: string, resourcesPath: string): Promise<boolean> =>
      ipcRenderer.invoke('renderer:uses-custom-windowed', rendererKey, resourcesPath),
    readResolution: (gamePath: string, rendererKey: string): Promise<{ width: number; height: number } | null> =>
      ipcRenderer.invoke('renderer:read-resolution', gamePath, rendererKey),
    writeResolution: (gamePath: string, resourcesPath: string, rendererKey: string, width: number, height: number, gameId?: string): Promise<boolean> =>
      ipcRenderer.invoke('renderer:write-resolution', gamePath, resourcesPath, rendererKey, width, height, gameId)
  },
  forcedSpawn: {
    global: (gamePath: string): Promise<Array<{ key: string; value: string }>> =>
      ipcRenderer.invoke('forced-spawn:global', gamePath),
    gameMode: (gamePath: string, modeName: string): Promise<Array<{ key: string; value: string }>> =>
      ipcRenderer.invoke('forced-spawn:gamemode', gamePath, modeName),
    apply: (gamePath: string, modeName: string, mapPath: string | undefined, baseOptions: Record<string, string>): Promise<Record<string, string>> =>
      ipcRenderer.invoke('forced-spawn:apply', gamePath, modeName, mapPath, baseOptions),
    generate: (gamePath: string, modeName: string, mapPath: string | undefined, baseOptions: Record<string, string>): Promise<string> =>
      ipcRenderer.invoke('forced-spawn:generate', gamePath, modeName, mapPath, baseOptions)
  },
  gameMode: {
    load: (gamePath: string): Promise<Array<{
      name: string; uiName: string; mapCodeIniName: string
      randomizedMapCodeININames: string[]; randomizedMapCodesCount: number
      forcedOptionsSection: string; minPlayersOverride?: number; maxPlayersOverride?: number
      disallowedPlayerSides: number[]; disallowedHumanPlayerSides: number[]
      disallowedComputerPlayerSides: number[]
      forcedCheckBoxValues: Record<string, boolean>
      forcedDropDownValues: Record<string, number>
      forcedSpawnIniOptions: Record<string, string>
      coopDifficultyLevel: number
    }>> => ipcRenderer.invoke('gamemode:load', gamePath)
  },
  maps: {
    load: (gamePath: string, gameId?: string): Promise<Array<{
      filePath: string; baseFilePath: string; description: string
      gameModes: string[]; minPlayers: number; maxPlayers: number
      enforceMaxPlayers: boolean; size: string; localSize: string; previewSize: string
      waypoints: Record<number, { x: number; y: number }>
      isCoopMission: boolean; briefing: string; unitCount?: number
      disallowedPlayerSides: number[]; disallowedPlayerColors: number[]
      enemyHouses: string[]; forcedOptions: Record<string, string>
      forcedSpawnIniOptions: Record<string, string>
      extraIniName?: string; baseSection?: string
    }>> => ipcRenderer.invoke('maps:load', gamePath, gameId),
    import: (gameId: string): Promise<{ ok: boolean; imported?: string[]; error?: string }> =>
      ipcRenderer.invoke('maps:import', gameId),
    delete: (gameId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('maps:delete', gameId, name),
    listLibrary: (gameId: string): Promise<{ ok: boolean; maps: Array<{ id: string; name: string; path: string; size: number }>; error?: string }> =>
      ipcRenderer.invoke('maps:list-library', gameId),
    findByHash: (gamePath: string, mapHash: string): Promise<{ filePath: string; baseFilePath: string; description: string } | null> =>
      ipcRenderer.invoke('map:find-by-hash', gamePath, mapHash),
    hashByName: (gamePath: string, mapName: string): Promise<string> =>
      ipcRenderer.invoke('map:hash-by-name', gamePath, mapName)
  },
  mapCode: {
    apply: (gamePath: string, mapIniPath: string, modeMapCodeName: string, modeName: string, customIniPaths: string[]): Promise<void> =>
      ipcRenderer.invoke('map-code:apply', gamePath, mapIniPath, modeMapCodeName, modeName, customIniPaths),
    getFiles: (gamePath: string, modeMapCodeName: string, randomizedNames: string[], randomizedCount: number): Promise<string[]> =>
      ipcRenderer.invoke('map-code:files', gamePath, modeMapCodeName, randomizedNames, randomizedCount)
  },
  mapPreview: {
    load: (gamePath: string, mapFilePath: string, mapHash?: string): Promise<{
      previewPath: string | null; previewDataUrl: string | null; previewAvailable: boolean
      mapWidth: number; mapHeight: number
      startingLocations: Array<{ x: number; y: number; waypoint: number }>
      extraTextures: Array<{ textureName: string; x: number; y: number; level: number; toggleable: boolean }>
      briefing: string; isCoop: boolean
    }> => ipcRenderer.invoke('map-preview:load', gamePath, mapFilePath, mapHash),
    // 悬停预览的独立置顶窗口（跟随鼠标，可在应用窗口外显示）
    // mode: 'room' = 大厅房间悬停（左图+右信息列），'map' = 房间内地图悬停（纯图+底部图名）
    show: (opts: {
      mode: 'room' | 'map'
      imageUrl: string; roomName?: string; mapName?: string
      playerCount?: number; maxPlayers?: number
      members?: Array<{ name: string; isHost: boolean }>
      imgW: number; imageHeight?: number
    }): void => ipcRenderer.send('map-preview:show', opts),
    move: (): void => ipcRenderer.send('map-preview:move'),
    hide: (): void => ipcRenderer.send('map-preview:hide')
  },
  fileSetting: {
    execute: (gamePath: string, resourcesPath: string, config: { useLegacy: boolean; enabledFiles: any[]; disabledFiles: any[] }, isChecked: boolean, reversed: boolean): Promise<void> =>
      ipcRenderer.invoke('file-setting:execute', gamePath, resourcesPath, config, isChecked, reversed),
    checkAvailability: (resourcesPath: string, files: any[]): Promise<boolean> =>
      ipcRenderer.invoke('file-setting:check-availability', resourcesPath, files)
  },
  keyboard: {
    load: (gamePath: string, gameId?: string): Promise<Array<{
      command: string; uiName: string; category: string
      description: string; defaultKey: string; currentKey: string
    }>> => ipcRenderer.invoke('keyboard:load', gamePath, gameId),
    getMappings: (gamePath: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('keyboard:mappings', gamePath),
    save: (gamePath: string, bindings: Array<{ command: string; currentKey: string; defaultKey: string }>, gameId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('keyboard:save', gamePath, bindings, gameId)
  },
  integrity: {
    check: (gamePath: string): Promise<Array<{ file: string; exists: boolean; required: boolean }>> =>
      ipcRenderer.invoke('integrity:check', gamePath),
    missingRequired: (gamePath: string): Promise<string[]> =>
      ipcRenderer.invoke('integrity:missing-required', gamePath)
  },
  campaign: {
    load: (gamePath: string): Promise<{
      acts: Array<{
        id: string; label: string
        missions: CampaignMissionPayload[]
        groups: Array<{
          id: string; label: string
          missions: CampaignMissionPayload[]
        }>
      }>
      standalone: Array<{
        id: string; label: string
        missions: CampaignMissionPayload[]
      }>
    }> => ipcRenderer.invoke('campaign:load', gamePath)
  },
  zhSinglePlayer: {
    load: (gamePath: string, includeCampaigns: boolean): Promise<{
      campaigns: Array<{ id: string; label: string; firstMission: string; playerFaction: string; challenge: boolean; missions: Array<{ id: string; map: string; nextMission: string; location: string; generalName: string }> }>
      challengeCampaigns: Array<{ id: string; label: string; firstMission: string; playerFaction: string; challenge: boolean; missions: Array<{ id: string; map: string; nextMission: string; location: string; generalName: string }> }>
      generals: Array<{ index: number; enabled: boolean; name: string; rank: string; branch: string; strategy: string; campaign: string; playerTemplate: string }>
    }> => ipcRenderer.invoke('zh-singleplayer:load', gamePath, includeCampaigns)
  },
  translation: {
    load: (filePath: string): Promise<{ name: string; culture: string; entries: Record<string, string> } | null> =>
      ipcRenderer.invoke('translation:load', filePath),
    loadAll: (dir: string): Promise<Array<{ name: string; culture: string; entries: Record<string, string> }>> =>
      ipcRenderer.invoke('translation:load-all', dir)
  },
  privacy: {
    load: (gamePath: string): Promise<{
      backgroundTexture: string; drawMode: string
      explanationText: string; explanationColor: string; buttonText: string
    } | null> => ipcRenderer.invoke('privacy:load', gamePath)
  },
  statistics: {
    load: (gamePath: string): Promise<{
      returnButtonLocation: { x: number; y: number }; returnButtonText: string
      clearButtonLocation: { x: number; y: number }; clearButtonText: string; clearButtonVisible: boolean
      speedrunButtonLocation: { x: number; y: number }; speedrunButtonText: string; speedrunButtonUrl: string
      columnWidths: number[]; gameModeFilterSize: { width: number; height: number }
    } | null> => ipcRenderer.invoke('statistics:load', gamePath)
  },
  userDefaults: {
    load: (gamePath: string): Promise<{
      borderlessWindowedClient: boolean; integerScaledClient: boolean
      writeInstallationPathToRegistry: boolean
    }> => ipcRenderer.invoke('user-defaults:load', gamePath)
  },
  music: {
    load: (gamePath: string): Promise<Array<{
      name: string; sound: string; normal: boolean; length: number; repeat: boolean
    }>> => ipcRenderer.invoke('music:load', gamePath)
  },
  mpLobbyOptions: {
    load: (gamePath: string): Promise<{
      sides: Array<{ name: string; icon: string }>
      mpColors: Array<{ name: string; r: number; g: number; b: number; hex: string; gameColorIndex: number }>
      dropdowns: Array<{
        name: string; label: string; optionName: string
        items: string[]; itemLabels: string[]; defaultIndex: number
        spawnIniOption: string; dataWriteMode: string; toolTip: string
      }>
      checkboxes: Array<{
        name: string; text: string; optionName: string
        checked: boolean; spawnIniOption: string
        customIniPath?: string; reversed: boolean
        enabledSpawnIniValue: string; disabledSpawnIniValue: string
        toolTip: string; visible: boolean
      }>
      randomSelectors: Record<string, number[]>
      randomSelectorCount: number
      factionCount: number
      forcedSpawnIniOptions: Record<string, string>
    }> => ipcRenderer.invoke('game-options:multiplayer-lobby', gamePath)
  }
}

export type LauncherAPI = typeof api

contextBridge.exposeInMainWorld('api', api)
