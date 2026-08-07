import fs from 'fs'
import path from 'path'
import iconv from 'iconv-lite'

// ─── 文本编码检测与解码 ─────────────────────────────────
// 中文版 RA2/MO 的 INI（GameOptions.ini、地图文件等）常为 GBK/GB2312，
// 固定按 UTF-8 读会乱码。读入时嗅探编码，写回时保持原编码。

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })
const UTF8 = new TextDecoder('utf-8')

export type IniTextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'

/** 嗅探文件编码：BOM 优先，其次 UTF-8 严格校验，回退 GB18030（GBK/GB2312 超集） */
export function detectTextEncoding(buf: Buffer): IniTextEncoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be'
  try {
    UTF8_STRICT.decode(buf)
    return 'utf-8'
  } catch {
    return 'gb18030'
  }
}

/** 按检测出的编码解码文本（UTF-8 的 BOM 由 TextDecoder 自动剥除，UTF-16 手动剥） */
export function decodeText(buf: Buffer, encoding: IniTextEncoding): string {
  if (encoding === 'utf-8') return UTF8.decode(buf)
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const hasBom = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)
    return new TextDecoder(encoding).decode(hasBom ? buf.subarray(2) : buf)
  }
  return iconv.decode(buf, 'gb18030')
}

/** 按指定编码编码文本（写回文件时保持原编码，避免中文乱码） */
export function encodeText(text: string, encoding: IniTextEncoding): Buffer {
  if (encoding === 'utf-8') return Buffer.from(text, 'utf-8')
  return iconv.encode(text, encoding)
}

export class IniSection {
  readonly name: string
  private keys: Map<string, string>
  /** 小写键 → 原始大小写键（写回 spawnmap.ini 等需要保留原大小写；查找仍按小写） */
  private originalKeys: Map<string, string>

  constructor(name: string) {
    this.name = name
    this.keys = new Map()
    this.originalKeys = new Map()
  }

  set(key: string, value: string): void {
    const lower = key.toLowerCase()
    this.keys.set(lower, value)
    // 首次见到的键名大小写为准（原图 > map code 覆盖，对齐参考输出）
    if (!this.originalKeys.has(lower)) {
      this.originalKeys.set(lower, key)
    }
  }

  getString(key: string, defaultValue = ''): string {
    return this.keys.get(key.toLowerCase()) ?? defaultValue
  }

  getInt(key: string, defaultValue = 0): number {
    const v = this.keys.get(key.toLowerCase())
    if (v === undefined) return defaultValue
    const n = parseInt(v, 10)
    return isNaN(n) ? defaultValue : n
  }

  getFloat(key: string, defaultValue = 0): number {
    const v = this.keys.get(key.toLowerCase())
    if (v === undefined) return defaultValue
    const n = parseFloat(v)
    return isNaN(n) ? defaultValue : n
  }

  getBoolean(key: string, defaultValue = false): boolean {
    const v = this.keys.get(key.toLowerCase())
    if (v === undefined) return defaultValue
    const lower = v.toLowerCase()
    return lower === 'yes' || lower === 'true' || lower === '1'
  }

  getStringList(key: string, defaultValue: string[] = []): string[] {
    const v = this.keys.get(key.toLowerCase())
    if (v === undefined) return defaultValue
    return v.split(',').map(s => s.trim()).filter(s => s.length > 0)
  }

  has(key: string): boolean {
    return this.keys.has(key.toLowerCase())
  }

  keys_names(): string[] {
    return Array.from(this.keys.keys())
  }

  /** 原始大小写的键（顺序与 keys_names 一致；spawnmap.ini 等写回用） */
  keys_names_original(): string[] {
    return Array.from(this.keys.keys()).map((k) => this.originalKeys.get(k) ?? k)
  }

  mergeFrom(other: IniSection): void {
    for (const k of other.keys.keys()) {
      if (!this.keys.has(k)) {
        this.keys.set(k, other.keys.get(k)!)
        this.originalKeys.set(k, other.originalKeys.get(k) ?? k)
      }
    }
  }

  clone(): IniSection {
    const s = new IniSection(this.name)
    for (const [k, v] of this.keys) {
      s.keys.set(k, v)
    }
    for (const [k, v] of this.originalKeys) {
      s.originalKeys.set(k, v)
    }
    return s
  }
}

export class CCIniFile {
  sections: Map<string, IniSection> = new Map()
  filePath: string = ''

  getSection(name: string): IniSection | undefined {
    return this.sections.get(name.toLowerCase())
  }

  getOrAddSection(name: string): IniSection {
    const key = name.toLowerCase()
    let s = this.sections.get(key)
    if (!s) {
      s = new IniSection(name)
      this.sections.set(key, s)
    }
    return s
  }

  getStringValue(section: string, key: string, defaultValue = ''): string {
    return this.getSection(section)?.getString(key, defaultValue) ?? defaultValue
  }

  getIntValue(section: string, key: string, defaultValue = 0): number {
    return this.getSection(section)?.getInt(key, defaultValue) ?? defaultValue
  }

  getBooleanValue(section: string, key: string, defaultValue = false): boolean {
    return this.getSection(section)?.getBoolean(key, defaultValue) ?? defaultValue
  }

  getStringListValue(section: string, key: string, defaultValue: string[] = []): string[] {
    return this.getSection(section)?.getStringList(key, defaultValue) ?? defaultValue
  }

  getSectionNames(): string[] {
    return Array.from(this.sections.keys())
  }

  /** 原始大小写的段名（IniSection.name 保留原图/map code 的大小写；写回 spawnmap.ini 用） */
  getSectionNames_original(): string[] {
    return Array.from(this.sections.values()).map((s) => s.name)
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
}

function parseIniContent(content: string): CCIniFile {
  const file = new CCIniFile()
  const lines = stripBom(content).split(/\r?\n/)
  let currentSection: IniSection | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue

    // 允许 section 名后带注释：如 "[AREDDAWN] ; 01 - Red Dawn Rising"
    const sectionMatch = line.match(/^\[(.+)\]\s*(;.*)?$/)
    if (sectionMatch) {
      const name = sectionMatch[1].trim()
      currentSection = file.getOrAddSection(name)
      continue
    }

    if (currentSection) {
      const eqIdx = line.indexOf('=')
      if (eqIdx > 0) {
        const key = line.substring(0, eqIdx).trim()
        let value = line.substring(eqIdx + 1).trim()
        // 去掉行内注释（分号后跟空白，如 "AREDDAWN\t\t; Red Dawn Rising"）
        const commentIdx = value.search(/;[\s]/)
        if (commentIdx > 0) {
          value = value.substring(0, commentIdx).trim()
        }
        if (key) {
          currentSection.set(key, value)
        }
      }
    }
  }

  return file
}

/** 从 BIG/VFS 已读出的文本解析 INI（不需要落地临时文件）。 */
export function loadIniText(content: string): CCIniFile {
  return parseIniContent(content)
}

/**
 * Load an INI file with BasedOn chain support.
 * [INISystem] BasedOn=file1.ini,file2.ini
 * Loads base files first, then overlays current file on top.
 */
export function loadIniFile(filePath: string): CCIniFile {
  if (!fs.existsSync(filePath)) {
    return new CCIniFile()
  }

  const buf = fs.readFileSync(filePath)
  const content = decodeText(buf, detectTextEncoding(buf))
  const file = parseIniContent(content)
  file.filePath = filePath

  // Process BasedOn
  const iniSystem = file.getSection('INISystem')
  if (iniSystem) {
    const basedOn = iniSystem.getString('BasedOn')
    if (basedOn) {
      const dir = path.dirname(filePath)
      const baseFiles = basedOn.split(',').map(s => s.trim()).filter(s => s.length > 0)

      for (const baseFile of baseFiles) {
        // Resolve $THEME_DIR$ placeholder
        const resolved = baseFile.replace(/\$THEME_DIR\$/gi, 'Resources')
        const basePath = path.resolve(dir, resolved)
        const baseIni = loadIniFile(basePath)

        // Merge: base sections go first, current overrides
        for (const [name, section] of baseIni.sections) {
          if (!file.sections.has(name)) {
            file.sections.set(name, section.clone())
          } else {
            // Current section inherits missing keys from base
            file.sections.get(name)!.mergeFrom(section)
          }
        }
      }
    }
  }

  // Process $BaseSection inheritance
  for (const section of file.sections.values()) {
    const baseSectionName = section.getString('$BaseSection')
    if (baseSectionName) {
      const baseSection = file.getSection(baseSectionName)
      if (baseSection) {
        section.mergeFrom(baseSection)
      }
    }
  }

  return file
}

/**
 * Load INI files with base file fallback.
 * If primary file exists, load it. Otherwise fall back to base.
 */
export function loadIniWithFallback(
  primaryPath: string,
  basePath: string
): CCIniFile {
  if (fs.existsSync(primaryPath)) {
    return loadIniFile(primaryPath)
  }
  return loadIniFile(basePath)
}
