// ─── 包 / 播放集 / 地图库 共享类型 ─────────────────────

/** 播放集里对某个包的引用 */
export interface PackageRef {
  id: string
  name: string
}

/** 播放集（原 modsets.json 条目）：packages 数组顺序 = playground 覆盖顺序（后覆盖胜出） */
export interface PlaySet {
  id: string
  name: string
  description: string
  background?: string
  packages: PackageRef[]
}

/** 已安装的本地包（packages/<name> 子文件夹） */
export interface InstalledPackage {
  name: string
  path: string
}

/** 地图库里的地图文件（resourceDir/<gameId>/maps/） */
export interface LibraryMap {
  id: string
  name: string
  path: string
  size: number
}

/** 导入操作的结果 */
export interface ImportResult {
  ok: boolean
  imported?: string[]
  error?: string
}
