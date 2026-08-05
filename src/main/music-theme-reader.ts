import path from 'path'
import fs from 'fs'
import { loadIniFile } from './ini-parser'

export interface MusicTheme {
  name: string
  sound: string
  normal: boolean
  length: number
  repeat: boolean
}

/**
 * Load music themes from thememo.ini.
 */
export function loadMusicThemes(gamePath: string): MusicTheme[] {
  const iniPath = path.join(gamePath, 'Resources', 'thememo.ini')
  if (!fs.existsSync(iniPath)) return []

  const ini = loadIniFile(iniPath)
  const themes: MusicTheme[] = []

  for (const sectionName of ini.getSectionNames()) {
    const sec = ini.getSection(sectionName)
    if (!sec) continue

    // Each section is a theme entry
    const name = sec.getString('Name', sectionName)
    const sound = sec.getString('Sound')
    if (!sound) continue

    themes.push({
      name,
      sound,
      normal: sec.getBoolean('Normal', true),
      length: sec.getInt('Length', 0),
      repeat: sec.getBoolean('Repeat', false)
    })
  }

  return themes
}
