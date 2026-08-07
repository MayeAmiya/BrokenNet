/**
 * 游戏进程启动器
 *
 * 1. 写入 spawn.ini
 * 2. 启动游戏 exe
 * 3. 监听进程退出
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeSpawnIni, type SpawnIniOptions } from './spawn-ini'

let gameProcess: ChildProcess | null = null
let gameExitCallback: ((code: number | null) => void) | null = null

export interface LaunchGameOptions {
  /** 游戏根目录 */
  gameDir: string
  /** exe 文件名，如 Generals.exe */
  exe: string
  /** spawn.ini 配置 */
  spawnOptions: SpawnIniOptions
  /** 额外命令行参数 */
  args?: string[]
  skipSpawnIni?: boolean
  /** 启动后回调 */
  onLaunched?: () => void
  /** 退出回调 */
  onExit?: (code: number | null) => void
}

export interface LaunchGameResult {
  ok: boolean
  error?: string
  pid?: number
}

/**
 * 检测系统里是否有游戏进程在运行（gamemd/Syringe/Generals 等）。
 * Syringe 启动 gamemd 后可能退出，单靠 gameProcess 追踪会漏掉仍在运行的 gamemd。
 */
const GAME_PROCESS_NAMES = ['gamemd.exe', 'Syringe.exe', 'Generals.exe', 'MentalOmegaClient.exe', 'gamemd-spawn.exe']

function isGameProcessRunning(): boolean {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', windowsHide: true })
    const lower = out.toLowerCase()
    return GAME_PROCESS_NAMES.some((name) => lower.includes(name))
  } catch {
    return false
  }
}

/**
 * 启动游戏
 */
export function launchGame(opts: LaunchGameOptions): LaunchGameResult {
  // 检查是否已有游戏实例在运行（系统级，不止追踪的进程）
  if (gameProcess || isGameProcessRunning()) {
    return { ok: false, error: '游戏已在运行中，请先关闭当前游戏实例' }
  }

  const exePath = join(opts.gameDir, opts.exe)
  if (!existsSync(exePath)) {
    return { ok: false, error: `找不到游戏程序: ${exePath}` }
  }

  // 写入 spawn.ini
  if (!opts.skipSpawnIni) try {
    writeSpawnIni(opts.gameDir, opts.spawnOptions)
  } catch (err) {
    return { ok: false, error: `写入 spawn.ini 失败: ${err}` }
  }

  // 启动进程
  console.log(`[launchGame] exe=${exePath} args=${JSON.stringify(opts.args ?? [])} cwd=${opts.gameDir}`)
  try {
    gameProcess = spawn(exePath, opts.args ?? [], {
      cwd: opts.gameDir,
      detached: false,
      stdio: 'ignore',
      // 原样传参数（保留引号）：Syringe.exe "gamemd.exe" -SPAWN ...
      windowsVerbatimArguments: true
    })
  } catch (err) {
    gameProcess = null
    return { ok: false, error: `启动游戏失败: ${err}` }
  }

  gameExitCallback = opts.onExit ?? null

  gameProcess.on('error', (err) => {
    console.error('Game process error:', err)
    cleanup()
    gameExitCallback?.(-1)
  })

  gameProcess.on('exit', (code) => {
    console.log(`Game exited with code ${code}`)
    cleanup()
    gameExitCallback?.(code)
  })

  opts.onLaunched?.()

  return { ok: true, pid: gameProcess.pid ?? undefined }
}

/**
 * 检查游戏是否在运行
 */
export function isGameRunning(): boolean {
  return gameProcess !== null
}

/**
 * 获取游戏进程 PID
 */
export function getGamePid(): number | undefined {
  return gameProcess?.pid
}

function cleanup(): void {
  gameProcess = null
  gameExitCallback = null
}
