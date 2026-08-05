import path from 'path'
import { loadIniFile } from './ini-parser'
import type { IniRendererDef } from '../shared/types/ini-layout'

export function readRenderers(gamePath: string): IniRendererDef[] {
  const iniPath = path.join(gamePath, 'Resources', 'Renderers.ini')
  const ini = loadIniFile(iniPath)
  const renderersSec = ini.getSection('Renderers')
  if (!renderersSec) return []

  const keys = renderersSec.keys_names().sort((a, b) => {
    const ai = parseInt(a, 10)
    const bi = parseInt(b, 10)
    return ai - bi
  })

  const result: IniRendererDef[] = []

  for (const key of keys) {
    const sectionName = renderersSec.getString(key)
    if (!sectionName) continue

    const sec = ini.getSection(sectionName)
    if (!sec) {
      result.push({ key: sectionName, uiName: sectionName })
      continue
    }

    const additionalFilesRaw = sec.getString('AdditionalFiles')
    const disallowedRaw = sec.getString('DisallowedOperatingSystems')

    result.push({
      key: sectionName,
      uiName: sec.getString('UIName', sectionName),
      dllName: sec.getString('DLLName') || undefined,
      configFileName: sec.getString('ConfigFileName') || undefined,
      resConfigFileName: sec.getString('ResConfigFileName') || undefined,
      additionalFiles: additionalFilesRaw
        ? additionalFilesRaw.split(',').map(s => s.trim())
        : undefined,
      useQres: sec.has('UseQres') ? sec.getBoolean('UseQres') : undefined,
      windowedModeSection: sec.getString('WindowedModeSection') || undefined,
      windowedModeKey: sec.getString('WindowedModeKey') || undefined,
      borderlessWindowedModeKey: sec.getString('BorderlessWindowedModeKey') || undefined,
      isBorderlessReversed: sec.has('IsBorderlessWindowedModeKeyReversed')
        ? sec.getBoolean('IsBorderlessWindowedModeKeyReversed')
        : undefined,
      isDxWnd: sec.has('IsDxWnd') ? sec.getBoolean('IsDxWnd') : undefined,
      widthKey: sec.getString('WidthKey') || undefined,
      heightKey: sec.getString('HeightKey') || undefined,
      disallowedOperatingSystems: disallowedRaw
        ? disallowedRaw.split(',').map(s => s.trim())
        : undefined
    })
  }

  return result
}

export function getDefaultRenderer(gamePath: string, os: string = 'WIN810'): string {
  const iniPath = path.join(gamePath, 'Resources', 'Renderers.ini')
  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('DefaultRenderer')
  if (!sec) return 'Default'
  return sec.getString(os, sec.getString('UNKNOWN', 'Default'))
}
