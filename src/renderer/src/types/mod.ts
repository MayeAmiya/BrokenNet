/**
 * MOD 仓库数据类型 —— 对接 GenLauncher YAML 格式
 */

/** 主清单中的单个 MOD 条目 */
export interface RepoMod {
  ModName: string
  ModLink: string
  ModPatches: string[]
  ModAddons: string[]
}

/** 主清单结构 */
export interface RepoModsData {
  modDatas: RepoMod[]
  globalAddonsData: string[]
  originalGameAddons: string[]
  originalGamePatches: string[]
  executables: RepoExecutable[]
  LauncherVersion: string
  DownloadLink: string
}

/** 可执行文件条目 */
export interface RepoExecutable {
  ModName: string
  ModLink: string
  DependencyName: string
}

/** 单个 MOD 的版本信息（从 ModLink 下载的 YAML） */
export interface ModManifest {
  ModificationType: 'Mod' | 'Addon' | 'Patch' | 'Executable'
  Name: string
  Version: string
  SimpleDownloadLink: string
  UIImageSourceLink?: string
  DiscordLink?: string
  ModDBLink?: string
  NewsLink?: string
  DependenceName?: string
  S3HostLink?: string
  S3BucketName?: string
  S3FolderName?: string
  S3HostPublicKey?: string
  S3HostSecretKey?: string
  ExceptionNames?: string[]
  AdditionalFileNames?: string[]
  ColorsInformation?: Record<string, string>
}

/** 已安装的 MOD 信息 */
export interface InstalledMod {
  id: string
  name: string
  version: string
  manifest?: ModManifest
  installedAt: string
  path: string
}

/** MOD 下载状态 */
export type ModDownloadStatus = 'idle' | 'downloading' | 'extracting' | 'done' | 'error'

/** MOD 下载进度 */
export interface ModDownloadProgress {
  modName: string
  status: ModDownloadStatus
  progress: number // 0-100
  downloaded: number // bytes
  total: number // bytes
  error?: string
}
