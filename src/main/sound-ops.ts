/**
 * 音量设置 —— 读写全局设置存储里的游戏音量（settings/RA2MO.ini [Audio]）。
 * 游戏实际读的是 [Audio] 段的 SoundVolume/ScoreVolume/VoiceVolume（0-1 小数）：
 *   音效=SoundVolume、音乐=ScoreVolume、单位语音=VoiceVolume
 * UI 用 0-100 展示，读写时在 0-1 和 0-100 之间换算。
 * 该文件在 playground 构建时从 settings/ 硬链接进去，游戏读到即生效；游戏内改音量也写回同一文件。
 */
import { ipcMain } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { loadIniFile, CCIniFile } from './ini-parser'
import { getResourceDir } from './resource-dir'

/** [Audio] 音量键 → 游戏侧键名（值范围 0-1 小数） */
const AUDIO_VOLUME_KEYS = ['SoundVolume', 'ScoreVolume', 'VoiceVolume']

async function getSoundIniPath(gameId: string): Promise<string> {
  const resourceDir = await getResourceDir()
  return resourceDir ? join(resourceDir, gameId, 'settings', 'RA2MO.ini') : ''
}

function serializeIni(ini: CCIniFile): string {
  const lines: string[] = []
  for (const section of ini.sections.values()) {
    lines.push(`[${section.name}]`)
    for (const key of section.keys_names()) {
      lines.push(`${key}=${section.getString(key)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 读取 [Audio] 音量，返回 0-100（UI 用） */
async function readSound(gameId: string): Promise<Record<string, number>> {
  const p = await getSoundIniPath(gameId)
  if (!p || !existsSync(p)) return {}
  try {
    const ini = loadIniFile(p)
    const sec = ini.getSection('Audio')
    const out: Record<string, number> = {}
    for (const k of AUDIO_VOLUME_KEYS) {
      const v = sec?.getFloat(k, -1)
      if (v != null && v >= 0) out[k] = Math.round(v * 100)
    }
    return out
  } catch {
    return {}
  }
}

/** 写入 [Audio] 音量；values 是 0-100（UI），换算成 0-1 小数写文件 */
async function writeSound(gameId: string, values: Record<string, number>): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = await getSoundIniPath(gameId)
    if (!p) return { ok: false, error: '未配置资源目录' }
    await mkdir(dirname(p), { recursive: true })
    const ini = existsSync(p) ? loadIniFile(p) : new CCIniFile()
    const sec = ini.getOrAddSection('Audio')
    for (const k of AUDIO_VOLUME_KEYS) {
      const v = values[k]
      if (v !== undefined) sec.set(k, String(Math.max(0, Math.min(100, v)) / 100))
    }
    await writeFile(p, serializeIni(ini), 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ─── 画质档位 [Options] DetailLevel：0=低 1=中 2=高 ───
// 和音量一样写在 settings/RA2MO.ini，playground 构建时硬链接进游戏目录生效。

async function readQuality(gameId: string): Promise<number> {
  const p = await getSoundIniPath(gameId)
  if (!p || !existsSync(p)) return 1
  try {
    const ini = loadIniFile(p)
    const v = ini.getSection('Options')?.getInt('DetailLevel', -1)
    return v != null && v >= 0 ? v : 1
  } catch {
    return 1
  }
}

async function writeQuality(gameId: string, level: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = await getSoundIniPath(gameId)
    if (!p) return { ok: false, error: '未配置资源目录' }
    await mkdir(dirname(p), { recursive: true })
    const ini = existsSync(p) ? loadIniFile(p) : new CCIniFile()
    ini.getOrAddSection('Options').set('DetailLevel', String(Math.max(0, Math.min(2, Math.round(level)))))
    await writeFile(p, serializeIni(ini), 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function registerSoundHandlers(): void {
  ipcMain.handle('sound:read', (_e, gameId: string) => readSound(gameId))
  ipcMain.handle('sound:write', (_e, gameId: string, values: Record<string, number>) => writeSound(gameId, values))
  ipcMain.handle('quality:read', (_e, gameId: string) => readQuality(gameId))
  ipcMain.handle('quality:write', (_e, gameId: string, level: number) => writeQuality(gameId, level))
}
