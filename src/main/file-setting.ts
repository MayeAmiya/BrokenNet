import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

/**
 * FileSettingCheckBox - manages copying files when a checkbox is toggled.
 * Supports:
 * - Legacy mode: File0=source,destination
 * - Modern mode: EnabledFile0=source,dest / DisabledFile0=source,dest
 * - Availability checking
 * - KeepChanges mode with cache
 */

export interface FileSourceDest {
  source: string
  destination: string
  option?: 'AlwaysOverwrite' | 'OverwriteOnMismatch' | 'DontOverwrite' | 'KeepChanges'
}

export function parseFileSourceDest(value: string): FileSourceDest | null {
  const parts = value.split(',').map(s => s.trim())
  if (parts.length < 2) return null
  return {
    source: parts[0],
    destination: parts[1],
    option: (parts[2] as any) || 'AlwaysOverwrite'
  }
}

function sha1File(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath)
    return crypto.createHash('sha1').update(content).digest('hex')
  } catch {
    return ''
  }
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * Apply a file source->destination operation.
 */
export function applyFileOperation(
  gamePath: string,
  resourcesPath: string,
  fileOp: FileSourceDest
): boolean {
  const src = path.isAbsolute(fileOp.source)
    ? fileOp.source
    : path.join(resourcesPath, fileOp.source)
  const dst = path.isAbsolute(fileOp.destination)
    ? fileOp.destination
    : path.join(gamePath, fileOp.destination)

  if (!fs.existsSync(src)) return false
  ensureDir(dst)

  switch (fileOp.option) {
    case 'DontOverwrite':
      if (fs.existsSync(dst)) return true
      fs.copyFileSync(src, dst)
      return true

    case 'OverwriteOnMismatch':
      if (fs.existsSync(dst) && sha1File(src) === sha1File(dst)) return true
      fs.copyFileSync(src, dst)
      return true

    case 'KeepChanges': {
      const cacheDir = path.join(gamePath, 'SettingsCache')
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
      const cacheFile = path.join(cacheDir, path.basename(fileOp.destination))
      // If cache exists, use it; otherwise copy from source
      if (fs.existsSync(cacheFile)) {
        fs.copyFileSync(cacheFile, dst)
      } else {
        fs.copyFileSync(src, dst)
      }
      return true
    }

    case 'AlwaysOverwrite':
    default:
      fs.copyFileSync(src, dst)
      return true
  }
}

/**
 * Revert a file source->destination operation.
 */
export function revertFileOperation(
  gamePath: string,
  fileOp: FileSourceDest
): void {
  const dst = path.isAbsolute(fileOp.destination)
    ? fileOp.destination
    : path.join(gamePath, fileOp.destination)

  if (fileOp.option === 'KeepChanges') {
    // Move destination to cache
    const cacheDir = path.join(gamePath, 'SettingsCache')
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
    const cacheFile = path.join(cacheDir, path.basename(fileOp.destination))
    if (fs.existsSync(dst)) {
      try { fs.renameSync(dst, cacheFile) } catch { /* ignore */ }
    }
  } else {
    // Delete destination
    try { if (fs.existsSync(dst)) fs.unlinkSync(dst) } catch { /* ignore */ }
  }
}

/**
 * Parse FileSettingCheckBox config from an INI section.
 */
export function parseFileSettingConfig(
  section: { getString: (key: string) => string; keys_names: () => string[] }
): {
  useLegacy: boolean
  enabledFiles: FileSourceDest[]
  disabledFiles: FileSourceDest[]
} {
  // Try legacy format: File0, File1, ...
  const legacyFiles: FileSourceDest[] = []
  for (const key of section.keys_names()) {
    const match = key.match(/^file(\d+)$/i)
    if (match) {
      const fd = parseFileSourceDest(section.getString(key))
      if (fd) legacyFiles.push(fd)
    }
  }

  if (legacyFiles.length > 0) {
    return { useLegacy: true, enabledFiles: legacyFiles, disabledFiles: [] }
  }

  // Modern format: EnabledFile0, DisabledFile0, ...
  const enabledFiles: FileSourceDest[] = []
  const disabledFiles: FileSourceDest[] = []

  for (const key of section.keys_names()) {
    const enabledMatch = key.match(/^enabledfile(\d+)$/i)
    if (enabledMatch) {
      const fd = parseFileSourceDest(section.getString(key))
      if (fd) enabledFiles.push(fd)
    }
    const disabledMatch = key.match(/^disabledfile(\d+)$/i)
    if (disabledMatch) {
      const fd = parseFileSourceDest(section.getString(key))
      if (fd) disabledFiles.push(fd)
    }
  }

  return { useLegacy: false, enabledFiles, disabledFiles }
}

/**
 * Execute FileSettingCheckBox save logic.
 */
export function executeFileSetting(
  gamePath: string,
  resourcesPath: string,
  config: { useLegacy: boolean; enabledFiles: FileSourceDest[]; disabledFiles: FileSourceDest[] },
  isChecked: boolean,
  reversed: boolean = false
): void {
  if (config.useLegacy) {
    const shouldApply = reversed !== isChecked
    if (shouldApply) {
      for (const f of config.enabledFiles) {
        applyFileOperation(gamePath, resourcesPath, f)
      }
    } else {
      for (const f of config.enabledFiles) {
        revertFileOperation(gamePath, f)
      }
    }
  } else {
    if (isChecked) {
      for (const f of config.disabledFiles) {
        revertFileOperation(gamePath, f)
      }
      for (const f of config.enabledFiles) {
        applyFileOperation(gamePath, resourcesPath, f)
      }
    } else {
      for (const f of config.enabledFiles) {
        revertFileOperation(gamePath, f)
      }
      for (const f of config.disabledFiles) {
        applyFileOperation(gamePath, resourcesPath, f)
      }
    }
  }
}

/**
 * Check if all source files exist for a file setting.
 */
export function checkFilesAvailability(
  resourcesPath: string,
  files: FileSourceDest[]
): boolean {
  return files.every(f => {
    const src = path.isAbsolute(f.source)
      ? f.source
      : path.join(resourcesPath, f.source)
    return fs.existsSync(src)
  })
}
