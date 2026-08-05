/**
 * 音量设置 —— 读写全局设置存储里的游戏音量（settings/RA2MO.ini [Sound]）。
 * 该文件在 playground 构建时从 settings/ 硬链接进去，游戏读到即生效；游戏内改音量也写回同一文件。
 */
import { ipcMain } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { loadIniFile, CCIniFile } from './ini-parser'
import { getResourceDir } from './resource-dir'

/** RA2/MO [Sound] 音量键：音效/音乐/语音/单位语音（0-100） */
const SOUND_KEYS = ['Volume', 'ScoreVolume', 'SpeechVolume', 'VoiceVolume']

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

async function readSound(gameId: string): Promise<Record<string, number>> {
  const p = await getSoundIniPath(gameId)
  if (!p || !existsSync(p)) return {}
  try {
    const ini = loadIniFile(p)
    const sec = ini.getSection('Sound')
    const out: Record<string, number> = {}
    for (const k of SOUND_KEYS) {
      const v = sec?.getInt(k, -1)
      if (v !== undefined && v >= 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function writeSound(gameId: string, values: Record<string, number>): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = await getSoundIniPath(gameId)
    if (!p) return { ok: false, error: '未配置资源目录' }
    await mkdir(dirname(p), { recursive: true })
    const ini = existsSync(p) ? loadIniFile(p) : new CCIniFile()
    const sec = ini.getOrAddSection('Sound')
    for (const k of SOUND_KEYS) {
      const v = values[k]
      if (v !== undefined) sec.set(k, String(Math.max(0, Math.min(100, Math.round(v)))))
    }
    await writeFile(p, serializeIni(ini), 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function registerSoundHandlers(): void {
  ipcMain.handle('sound:read', (_e, gameId: string) => readSound(gameId))
  ipcMain.handle('sound:write', (_e, gameId: string, values: Record<string, number>) => writeSound(gameId, values))
}
