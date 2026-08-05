import path from 'path'
import fs from 'fs'
import { loadIniFile } from './ini-parser'

export interface FileIntegrityCheck {
  file: string
  exists: boolean
  required: boolean
}

/**
 * Check file integrity using FHCConfig.ini.
 * Reads [FilenameList] section and checks if files exist.
 */
export function checkFileIntegrity(gamePath: string): FileIntegrityCheck[] {
  const iniPath = path.join(gamePath, 'Resources', 'FHCConfig.ini')
  if (!fs.existsSync(iniPath)) return []

  const ini = loadIniFile(iniPath)
  const filenameList = ini.getSection('FilenameList')
  if (!filenameList) return []

  const checks: FileIntegrityCheck[] = []

  // Read required files from ClientDefinitions.ini
  const clientIniPath = path.join(gamePath, 'Resources', 'ClientDefinitions.ini')
  let requiredFiles: string[] = []
  if (fs.existsSync(clientIniPath)) {
    const clientIni = loadIniFile(clientIniPath)
    const sec = clientIni.getSection('Settings')
    if (sec) {
      const raw = sec.getString('RequiredFiles')
      if (raw) requiredFiles = raw.split(',').map(s => s.trim().toLowerCase())
    }
  }

  for (const key of filenameList.keys_names()) {
    const fileName = filenameList.getString(key)
    if (!fileName) continue

    const filePath = path.join(gamePath, fileName)
    checks.push({
      file: fileName,
      exists: fs.existsSync(filePath),
      required: requiredFiles.includes(fileName.toLowerCase())
    })
  }

  return checks
}

/**
 * Get list of missing required files.
 */
export function getMissingRequiredFiles(gamePath: string): string[] {
  const checks = checkFileIntegrity(gamePath)
  return checks.filter(c => c.required && !c.exists).map(c => c.file)
}
