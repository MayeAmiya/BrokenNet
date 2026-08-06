import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function registryPath(packagesDir: string): string {
  return join(dirname(packagesDir), 'downloaded-mods.json')
}

function modsRoot(packagesDir: string): string {
  return join(dirname(packagesDir), 'mods')
}

export function getModsRoot(packagesDir: string): string { return modsRoot(packagesDir) }
export function getModRoot(packagesDir: string, modName: string): string { return join(modsRoot(packagesDir), modName) }

export async function readDownloadedMods(packagesDir: string): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(registryPath(packagesDir), 'utf-8'))
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : []
  } catch {
    return []
  }
}

export async function writeDownloadedMods(packagesDir: string, names: string[]): Promise<void> {
  await writeFile(registryPath(packagesDir), JSON.stringify([...new Set(names)].sort(), null, 2), 'utf-8')
}

export async function markDownloadedMod(packagesDir: string, name: string): Promise<void> {
  if (name.includes('_patch_') || name.includes('_addon_')) return
  await mkdir(join(modsRoot(packagesDir), name), { recursive: true })
  await writeFile(join(modsRoot(packagesDir), name, 'mod.json'), JSON.stringify({ name, source: 'brokennet-download' }, null, 2), 'utf-8')
  const names = await readDownloadedMods(packagesDir)
  if (!names.includes(name)) await writeDownloadedMods(packagesDir, [...names, name])
}

export async function unmarkDownloadedMod(packagesDir: string, name: string): Promise<void> {
  await rm(join(modsRoot(packagesDir), name), { recursive: true, force: true })
  const names = await readDownloadedMods(packagesDir)
  if (names.includes(name)) await writeDownloadedMods(packagesDir, names.filter((item) => item !== name))
}

/** Logical MOD identities. Plain packages without a mods/<name> record are not MODs. */
export async function readManagedMods(packagesDir: string): Promise<string[]> {
  const root = modsRoot(packagesDir)
  await mkdir(root, { recursive: true })
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const managed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      const mainDir = join(root, entry.name, entry.name)
      if ((await stat(mainDir)).isDirectory()) {
        const mainEntries = await readdir(mainDir)
        if (mainEntries.length > 0) managed.push(entry.name)
      }
    } catch { /* 只有标记或 addon 残留，不算已安装主 MOD */ }
  }
  if (entries.length > 0) return [...new Set(managed)]

  // One-time migration from the previous registry format.
  const legacy = await readDownloadedMods(packagesDir)
  const validLegacy: string[] = []
  for (const name of legacy) {
    const legacyMain = join(root, name, name)
    try {
      if ((await stat(legacyMain)).isDirectory() && (await readdir(legacyMain)).length > 0) validLegacy.push(name)
    } catch { /* 旧注册表残留但实体不存在，忽略 */ }
  }
  return [...new Set(validLegacy)]
}
