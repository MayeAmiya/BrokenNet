import path from 'path'
import fs from 'fs'
import { loadIniFile } from './ini-parser'

export interface PrivacyNotificationConfig {
  backgroundTexture: string
  drawMode: string
  explanationText: string
  explanationColor: string
  buttonText: string
}

/**
 * Load privacy notification config from PrivacyNotification.ini.
 */
export function loadPrivacyNotification(gamePath: string): PrivacyNotificationConfig | null {
  const iniPath = path.join(gamePath, 'Resources', 'PrivacyNotification.ini')
  if (!fs.existsSync(iniPath)) return null

  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('PrivacyNotification')
  const labelSec = ini.getSection('lblExplanation')
  const btnSec = ini.getSection('btnOK')

  return {
    backgroundTexture: sec?.getString('BackgroundTexture') ?? 'updaterbg.png',
    drawMode: sec?.getString('DrawMode') ?? 'Stretched',
    explanationText: labelSec?.getString('Text') ?? '',
    explanationColor: labelSec?.getString('RemapColor') ?? '255,0,0,1',
    buttonText: btnSec?.getString('Text') ?? 'Accept'
  }
}
