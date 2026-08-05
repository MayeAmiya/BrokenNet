import path from 'path'
import fs from 'fs'
import { loadIniFile, CCIniFile } from './ini-parser'

export interface TranslationEntry {
  key: string
  value: string
}

export interface TranslationFile {
  name: string
  culture: string
  entries: Map<string, string>
}

/**
 * Load a translation INI file.
 * Format: [General] Name, Author, Culture, [Values] key=value
 */
export function loadTranslationFile(filePath: string): TranslationFile | null {
  if (!fs.existsSync(filePath)) return null
  const ini = loadIniFile(filePath)

  const general = ini.getSection('General')
  const values = ini.getSection('Values')

  const entries = new Map<string, string>()
  if (values) {
    for (const key of values.keys_names()) {
      entries.set(key, values.getString(key))
    }
  }

  return {
    name: general?.getString('Name') ?? path.basename(filePath, '.ini'),
    culture: general?.getString('Culture') ?? '',
    entries
  }
}

/**
 * Load all translation files from a directory.
 */
export function loadTranslations(translationsDir: string): TranslationFile[] {
  if (!fs.existsSync(translationsDir)) return []

  const files = fs.readdirSync(translationsDir).filter(f => f.endsWith('.ini'))
  return files
    .map(f => loadTranslationFile(path.join(translationsDir, f)))
    .filter((t): t is TranslationFile => t !== null)
}

/**
 * Find the best translation for a given culture.
 */
export function findBestTranslation(
  translations: TranslationFile[],
  preferredCulture: string
): TranslationFile | null {
  if (translations.length === 0) return null

  // Exact match
  const exact = translations.find(t => t.culture.toLowerCase() === preferredCulture.toLowerCase())
  if (exact) return exact

  // Partial match (e.g., "zh" matches "zh-CN")
  const partial = translations.find(t => t.culture.toLowerCase().startsWith(preferredCulture.toLowerCase().slice(0, 2)))
  if (partial) return partial

  // First available
  return translations[0]
}

/**
 * Translate a key with fallback chain.
 */
export function translate(
  translation: TranslationFile | null,
  key: string,
  fallback?: string
): string {
  if (translation) {
    const value = translation.entries.get(key)
    if (value !== undefined) return value
  }
  return fallback ?? key
}
