import path from 'path'
import fs from 'fs'
import { loadIniFile } from './ini-parser'

export interface UserDefaults {
  borderlessWindowedClient: boolean
  integerScaledClient: boolean
  writeInstallationPathToRegistry: boolean
}

/**
 * Load user defaults from ClientDefinitions.ini [UserDefaults] section.
 */
export function loadUserDefaults(gamePath: string): UserDefaults {
  const iniPath = path.join(gamePath, 'Resources', 'ClientDefinitions.ini')
  if (!fs.existsSync(iniPath)) {
    return {
      borderlessWindowedClient: true,
      integerScaledClient: false,
      writeInstallationPathToRegistry: true
    }
  }

  const ini = loadIniFile(iniPath)
  const sec = ini.getSection('UserDefaults')

  return {
    borderlessWindowedClient: sec?.getBoolean('UserDefault_BorderlessWindowedClient', true) ?? true,
    integerScaledClient: sec?.getBoolean('UserDefault_IntegerScaledClient', false) ?? false,
    writeInstallationPathToRegistry: sec?.getBoolean('UserDefault_WriteInstallationPathToRegistry', true) ?? true
  }
}
