import { basename, dirname, isAbsolute, resolve } from 'node:path'

/** Resolve a user-selected library item while keeping deletion inside its root. */
export function resolveDirectChild(rootDir: string, name: string): string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    isAbsolute(name) ||
    basename(name) !== name
  ) {
    throw new Error('无效的项目名称')
  }

  const root = resolve(rootDir)
  const target = resolve(root, name)
  if (target === root || dirname(target) !== root) {
    throw new Error('目标路径超出资源目录')
  }
  return target
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
