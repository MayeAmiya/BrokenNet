import { open, readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

type BigEntry = { offset: number; size: number; compressed: boolean }
export type BigVirtualEntry = BigEntry & { path: string }

function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function compareBigPriority(a: string, b: string): number {
  const count = (value: string) => value.match(/^!+/)?.[0].length ?? 0
  return count(a) - count(b) || a.localeCompare(b, 'en', { sensitivity: 'base' })
}

async function readBigEntry(bigPath: string, wantedPath: string): Promise<Buffer | null> {
  const file = await open(bigPath, 'r')
  try {
    const info = await file.stat()
    // BIG 文件表位于文件头，通常远小于 16 MiB；只读索引区，绝不把 1 GiB 的资源包整体载入内存。
    const table = Buffer.alloc(Math.min(Number(info.size), 16 * 1024 * 1024))
    if ((await file.read(table, 0, table.length, 0)).bytesRead < 12) return null
    const magic = table.toString('ascii', 0, 4)
    if (magic !== 'BIGF' && magic !== 'BIG4') return null
    const bigEndian = magic === 'BIGF'
    const readU32 = (buffer: Buffer, offset: number) => bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset)
    const fileCount = readU32(table, 8)
    if (fileCount > 100_000) return null
    let cursor = bigEndian ? 16 : 12
    const target = normalize(wantedPath)
    let found: BigEntry | null = null

    for (let index = 0; index < fileCount; index++) {
      if (cursor + 8 > table.length) return null
      const offset = readU32(table, cursor)
      const rawSize = readU32(table, cursor + 4)
      cursor += 8
      const nameBytes: number[] = []
      while (nameBytes.length < 4096 && cursor < table.length) {
        const byte = table[cursor++]
        if (byte === 0) break
        nameBytes.push(byte)
      }
      if (cursor >= table.length) return null
      const name = normalize(Buffer.from(nameBytes).toString('latin1'))
      if (name === target) {
        found = { offset, size: rawSize & 0x7fffffff, compressed: (rawSize & 0x80000000) !== 0 }
      }
    }
    if (!found || found.compressed) return null
    const data = Buffer.alloc(found.size)
    if ((await file.read(data, 0, found.size, found.offset)).bytesRead !== found.size) return null
    return data
  } finally {
    await file.close()
  }
}

/** 枚举一个 BIG 的虚拟文件表。压缩条目仍会列出，但读取时明确返回 null。 */
async function listBigEntries(bigPath: string): Promise<BigVirtualEntry[]> {
  const source = await readFile(bigPath).catch(() => null)
  if (!source || source.length < 12) return []
  const magic = source.toString('ascii', 0, 4)
  if (magic !== 'BIGF' && magic !== 'BIG4') return []
  const bigEndian = magic === 'BIGF'
  const readU32 = (offset: number) => bigEndian ? source.readUInt32BE(offset) : source.readUInt32LE(offset)
  const fileCount = readU32(8)
  if (fileCount > 100_000) return []
  let cursor = bigEndian ? 16 : 12
  const result: BigVirtualEntry[] = []
  for (let index = 0; index < fileCount; index++) {
    if (cursor + 8 > source.length) break
    const offset = readU32(cursor)
    const rawSize = readU32(cursor + 4)
    cursor += 8
    const start = cursor
    while (cursor < source.length && source[cursor] !== 0 && cursor - start < 4096) cursor++
    if (cursor >= source.length) break
    result.push({ path: normalize(source.toString('latin1', start, cursor)), offset, size: rawSize & 0x7fffffff, compressed: (rawSize & 0x80000000) !== 0 })
    cursor++
  }
  return result
}

/** Read one VFS path using SAGE BIG priority: normal archives first, ! archives last, loose file highest. */
export async function readGeneralsVfsFile(gameDir: string, virtualPath: string): Promise<string> {
  let result: Buffer | null = null
  const entries = await readdir(gameDir, { withFileTypes: true }).catch(() => [])
  const bigNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.big'))
    .map((entry) => entry.name)
    .sort(compareBigPriority)
  for (const name of bigNames) {
    const data = await readBigEntry(join(gameDir, name), virtualPath)
    if (data) result = data
  }
  const loosePath = join(gameDir, ...virtualPath.replace(/\\/g, '/').split('/'))
  const loose = await readFile(loosePath).catch(() => null)
  if (loose) result = loose
  return result?.toString('latin1') ?? ''
}

export async function readGeneralsVfsBuffer(gameDir: string, virtualPath: string): Promise<Buffer | null> {
  const entries = await readdir(gameDir, { withFileTypes: true }).catch(() => [])
  const bigNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.big'))
    .map((entry) => entry.name)
    .sort(compareBigPriority)
  let result: Buffer | null = null
  for (const name of bigNames) {
    const data = await readBigEntry(join(gameDir, name), virtualPath)
    if (data) result = data
  }
  const loose = await readFile(join(gameDir, ...virtualPath.replace(/\\/g, '/').split('/'))).catch(() => null)
  return loose ?? result
}

/** 返回 BIG 与 loose 文件合并后的虚拟路径，后续覆盖层由调用方按目录顺序合并。 */
export async function listGeneralsVfsFiles(gameDir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(gameDir, { withFileTypes: true }).catch(() => [])
  const result = new Set<string>()
  for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.big'))) {
    for (const item of await listBigEntries(join(gameDir, entry.name))) {
      if (!prefix || item.path.startsWith(normalize(prefix))) result.add(item.path)
    }
  }
  const walk = async (root: string, rel: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(root, entry.name), next)
      else if (entry.isFile() && (!prefix || normalize(next).startsWith(normalize(prefix)))) result.add(normalize(next))
    }
  }
  await walk(gameDir, '')
  return [...result].sort()
}

/**
 * 原地改写 .big 里 `Data\INI\GameData.ini` 的 MaxCameraHeight（对齐 GenLauncher BigHandler.SetCameraHeight）。
 * 直接覆盖该值（"NNN.00"），不重新打包。playground 里的 .big 是包硬链接的，改的就是生效那份。
 * 返回是否成功改写。
 */
export async function setBigCameraHeight(bigPath: string, height: number): Promise<boolean> {
  const file = await open(bigPath, 'r+')
  try {
    const header = Buffer.alloc(16)
    if ((await file.read(header, 0, 16, 0)).bytesRead < 12) return false
    const magic = header.toString('ascii', 0, 4)
    if (magic !== 'BIGF' && magic !== 'BIG4') return false
    const bigEndian = magic === 'BIGF'
    const readU32 = (b: Buffer, o: number) => (bigEndian ? b.readUInt32BE(o) : b.readUInt32LE(o))
    const fileCount = readU32(header, 8)
    if (fileCount > 100_000) return false
    let cursor = bigEndian ? 16 : 12
    const target = normalize('Data/INI/GameData.ini')

    for (let i = 0; i < fileCount; i++) {
      const fixed = Buffer.alloc(8)
      if ((await file.read(fixed, 0, 8, cursor)).bytesRead !== 8) return false
      const offset = readU32(fixed, 0)
      const rawSize = readU32(fixed, 4)
      cursor += 8
      const nameBytes: number[] = []
      while (nameBytes.length < 4096) {
        const byte = Buffer.alloc(1)
        if ((await file.read(byte, 0, 1, cursor++)).bytesRead !== 1) return false
        if (byte[0] === 0) break
        nameBytes.push(byte[0])
      }
      const name = normalize(Buffer.from(nameBytes).toString('latin1'))
      if (name !== target) continue

      const size = rawSize & 0x7fffffff
      if ((rawSize & 0x80000000) !== 0) return false // 压缩条目不支持原地改
      const data = Buffer.alloc(size)
      if ((await file.read(data, 0, size, offset)).bytesRead !== size) return false
      const text = data.toString('latin1')
      // 对齐 GenLauncher：从 3000 字节后找 MaxCameraHeight（GameData.ini 前面很长）
      const idx = text.indexOf('MaxCameraHeight', 3000)
      if (idx < 0) return false
      const eq = text.indexOf('=', idx)
      if (eq < 0) return false
      // 原格式可能是 "MaxCameraHeight = 310.0"（= 两边有空格）：跳到值起始
      let valueStart = eq + 1
      while (valueStart < text.length && /\s/.test(text[valueStart])) valueStart++
      // 原值可能 "310.0"/"310.00"：原地改必须保持相同字节数，否则会吃掉后面的字符
      let valueEnd = valueStart
      while (valueEnd < text.length && /[0-9.]/.test(text[valueEnd])) valueEnd++
      const oldLen = valueEnd - valueStart
      const h = String(Math.round(height))
      const decimals = Math.max(0, oldLen - h.length - 1)
      const newVal = Buffer.from(h + '.' + '0'.repeat(decimals), 'latin1')
      await file.write(newVal, 0, newVal.length, offset + valueStart)
      return true
    }
    return false
  } finally {
    await file.close()
  }
}

/** 在目录里找一个包含 `Data\INI\GameData.ini` 的 .big（对齐 GenLauncher FileContainsGameDataIni）。 */
export async function findBigWithGameData(gameDir: string): Promise<string | null> {
  const entries = await readdir(gameDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.big')) continue
    if (await readBigEntry(join(gameDir, entry.name), 'Data/INI/GameData.ini')) {
      return join(gameDir, entry.name)
    }
  }
  return null
}
