/**
 * Playground 工作区 —— 让播放集真正作用到游戏文件。
 *
 * 思路：
 *   playground = 当前生效的游戏目录。点启动时按当前播放集重建：
 *   - 游戏本体包 MentalOmega（安装目录的完整拷贝）→ 硬链接进 playground
 *   - 播放集其他 MOD 包 → 硬链接覆盖（后链接覆盖先链接）
 *   - 可写目录（存档/客户端数据等）→ junction 指向该播放集独立的存档目录，
 *     首次从本体包播种；游戏新增/修改落在那儿，重建不丢、各播放集互不干扰
 *   - 配置文件 → 复制到该播放集的 config 目录 + 硬链接，修改属于播放集
 *   游戏从 playground 运行（cwd、exe、spawn.ini 都指向它）。安装目录只作为本体包的来源。
 */

import fs from 'node:fs'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { app } from 'electron'
import { ensureFullKeyboardMap } from './keyboard-reader'

export interface PlaygroundApplyOptions {
  gameId: string
  modSetId: string
  onProgress?: (percent: number, label: string) => void
}

export interface PlaygroundApplyResult {
  ok: boolean
  playgroundPath?: string
  /** 独立地图库目录（写 spawn.ini [Settings] MPMapsPath，游戏从这里读下载/导入的地图） */
  mapsPath?: string
  error?: string
}

/**
 * 运行时写目录 —— 用 junction 指向「该播放集的独立存档目录」。
 * 每个播放集一套（resourceDir/<gameId>/saves/<modSetId>/），切换播放集 = 切换存档。
 *
 * 清单依据真实游戏目录审计（近 90 天写入行为）：
 * - UserData / Saved Games / Screenshots / Save / Logs / SettingsCache：通用
 * - Client / Resources：MO 客户端高频写入（client.log、SkirmishSettings.ini、ClientDefinitions.ini）
 * - EasyAntiCheat / plugins / GeneralsOnlineGameData：ZH 反作弊/联机客户端运行时更新
 * - Map Editor：MO 的 FinalAlert.ini 被写
 *
 * 注意：Maps/Data 不放进来 —— 可能被 MOD 覆盖，保留硬链接能力。
 */
const WRITABLE_DIRS = new Set([
  'UserData',
  'Saved Games',
  'Screenshots',
  'Save',
  'Logs',
  'SettingsCache',
  'Client',
  'Resources',
  'EasyAntiCheat',
  'plugins',
  'GeneralsOnlineGameData',
  'Map Editor'
])

/**
 * 可能被修改的配置文件扩展名 —— 不硬链接到原版，
 * 而是「复制到该播放集的 config 目录 + playground 硬链接」。
 * 游戏/启动器对它们的修改落在 per-modset 副本上，原版不被改。
 * 含运行时必然被写的日志/崩溃统计/密钥等（.log/.dmp/.key）。
 */
const CONFIG_EXTS = new Set(['.ini', '.cfg', '.txt', '.json', '.log', '.dmp', '.key'])

function isConfigFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  return CONFIG_EXTS.has(ext)
}

/**
 * 全局设置文件（相对游戏根路径，正斜杠）——画质/快捷键/音量，**不按播放集**。
 * 存 resourceDir/<gameId>/settings/，playground 构建时硬链接进去（包覆盖后再链接，启动器设置优先）。
 * 游戏运行时的修改通过硬链接写回 settings/，重建 playground 不丢。
 */
const GLOBAL_SETTINGS_REL = new Set([
  'ddraw.ini', // 画质：分辨率/窗口模式/渲染器（游戏根目录）
  'Resources/Renderers.ini', // 画质：渲染器列表
  'KeyboardMD.ini', // 快捷键（用户改键覆盖项，游戏只读这个；KeyboardCommands.ini 是游戏自带定义，不用管）
  'RA2MO.ini' // 音量/游戏设置（settingsFile）
])

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/')
}

/** 链接失败统计（透传给用户，避免「文件缺失还返回成功」） */
interface LinkStats {
  failed: number
  errors: string[]
}

// ─── 工具 ──────────────────────────────────────────────

async function readConfig(): Promise<Record<string, string>> {
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json')
    return JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** 从 game.ini 读 installPath（安装目录只作为本体包的源） */
function readInstallPath(gameIniPath: string): string {
  try {
    const content = fs.readFileSync(gameIniPath, 'utf-8')
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^installPath=(.*)$/)
      if (m) return m[1].trim()
    }
  } catch { /* 文件不存在 */ }
  return ''
}

/**
 * 首次使用：本体包缺 KeyboardMD 等基础设置文件时，从安装目录抽一份进包。
 * 安装目录只作包的源；抽完以后构建完全不碰安装目录。
 */
function ensurePackageBaseSettings(installPath: string, basePkgDir: string): void {
  if (!installPath || !fs.existsSync(installPath)) return
  const rels = ['KeyboardMD.ini', 'RA2MO.ini', 'ddraw.ini', 'Resources/Renderers.ini']
  for (const rel of rels) {
    const pkg = path.join(basePkgDir, rel)
    const src = path.join(installPath, rel)
    if (!fs.existsSync(pkg) && fs.existsSync(src)) {
      try {
        fs.mkdirSync(path.dirname(pkg), { recursive: true })
        fs.copyFileSync(src, pkg)
        console.log(`[playground] 首次使用：从安装目录抽取 ${rel} 进本体包`)
      } catch (e) {
        console.error(`[playground] 抽取 ${rel} 失败: ${(e as Error).message}`)
      }
    }
  }
}

/** 递归统计文件数（跳过可写目录，与链接保持一致） */
function countFiles(root: string): number {
  let count = 0
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (WRITABLE_DIRS.has(entry.name)) continue
        count += countFiles(path.join(root, entry.name))
      } else if (entry.isFile()) {
        count++
      }
    }
  } catch { /* 权限等 */ }
  return count
}

/**
 * 清空目录（junction 安全）。
 * Windows junction 在 Node 中表现为 symlink —— 用 unlink 只删链接，
 * 绝不跟随 junction 递归删除（否则会误删该播放集的存档）。
 */
function clearDir(dir: string): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    let st: fs.Stats
    try {
      st = fs.lstatSync(full)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      fs.unlinkSync(full)
    } else if (st.isDirectory()) {
      clearDir(full)
      fs.rmdirSync(full)
    } else {
      fs.unlinkSync(full)
    }
  }
}

/** 硬链接，带瞬时错误重试（杀软 EPERM / 句柄占用） */
function linkWithRetry(src: string, dst: string): void {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.linkSync(src, dst)
      return
    } catch (e) {
      lastErr = e
      const err = e as NodeJS.ErrnoException
      if (attempt < 2 && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
        continue // 瞬时错误，重试
      }
      throw e
    }
  }
  throw lastErr
}

/**
 * 硬链接（已存在且 inode 相同则跳过；不同则删掉重建，MOD 覆盖顺序即后链接胜出）。
 * 返回是否成功；失败计入 stats。
 */
function hardlinkOrSkip(srcPath: string, dstPath: string, stats?: LinkStats): boolean {
  try {
    if (fs.existsSync(dstPath)) {
      try {
        // bigint 避免 NTFS 64 位文件 ID 转 Number 丢精度误判同一文件
        const s1 = fs.statSync(srcPath, { bigint: true })
        const s2 = fs.statSync(dstPath, { bigint: true })
        if (s1.dev === s2.dev && s1.ino === s2.ino) return true // 已是同一个文件
      } catch { /* 忽略 */ }
      fs.rmSync(dstPath, { force: true })
    }
    linkWithRetry(srcPath, dstPath)
    return true
  } catch (e) {
    if (stats) {
      stats.failed++
      if (stats.errors.length < 5) {
        stats.errors.push(`${path.basename(srcPath)}: ${(e as Error).message}`)
      }
    }
    return false
  }
}

/** 递归复制目录内容（首次为 per-modset 存档目录建立原版模板） */
function copyDirContents(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name)
    const dstPath = path.join(dstDir, entry.name)
    if (entry.isDirectory()) {
      copyDirContents(srcPath, dstPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath)
    } else if (entry.isSymbolicLink()) {
      try {
        fs.symlinkSync(fs.readlinkSync(srcPath), dstPath, 'junction')
      } catch { /* 防御：源里的 junction 重建失败则跳过 */ }
    }
  }
}

/**
 * 可写目录 → junction 指向该播放集的存档目录（saveTarget）。
 * 首次创建时从原版目录复制初始内容作为模板，之后该播放集独立演化。
 */
function ensureWritableJunction(srcDir: string, dstDir: string, saveTarget: string): void {
  if (fs.existsSync(dstDir)) {
    try {
      const st = fs.lstatSync(dstDir)
      if (st.isSymbolicLink() && fs.realpathSync(dstDir) === fs.realpathSync(saveTarget)) {
        return // 已是正确 junction
      }
      fs.unlinkSync(dstDir)
    } catch {
      fs.rmSync(dstDir, { recursive: true, force: true })
    }
  }

  if (!fs.existsSync(saveTarget)) {
    fs.mkdirSync(saveTarget, { recursive: true })
    if (fs.existsSync(srcDir)) {
      copyDirContents(srcDir, saveTarget)
    }
  } else {
    fs.mkdirSync(saveTarget, { recursive: true })
  }

  fs.symlinkSync(saveTarget, dstDir, 'junction')
}

/**
 * 配置文件 → per-modset 副本 + playground 硬链接。
 * 首次从原版复制到 saveTarget，之后直接硬链接（副本保留上次修改）。
 */
function linkConfigFile(srcPath: string, dstPath: string, saveTarget: string, stats?: LinkStats): void {
  fs.mkdirSync(path.dirname(saveTarget), { recursive: true })
  if (!fs.existsSync(saveTarget)) {
    try {
      fs.copyFileSync(srcPath, saveTarget)
    } catch {
      hardlinkOrSkip(srcPath, dstPath, stats)
      return
    }
  }
  hardlinkOrSkip(saveTarget, dstPath, stats)
}

/**
 * 原版基准：递归构建 playground。
 * - 可写目录 → junction 指向 per-modset 存档目录
 * - 配置文件 → per-modset 副本 + 硬链接（修改属于播放集）
 * - 源目录里的 junction/symlink → 在 playground 重建指向同目标的 junction
 * - 其余文件 → 直接硬链接原版
 */
function linkOriginal(
  srcRoot: string,
  dstRoot: string,
  saveRoot: string,
  stats: LinkStats,
  onFile?: () => void
): void {
  fs.mkdirSync(dstRoot, { recursive: true })
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    const srcPath = path.join(srcRoot, entry.name)
    const dstPath = path.join(dstRoot, entry.name)
    const rel = path.relative(srcRoot, srcPath)
    try {
      if (entry.isDirectory()) {
        if (WRITABLE_DIRS.has(entry.name)) {
          ensureWritableJunction(srcPath, dstPath, path.join(saveRoot, rel))
        } else {
          linkOriginal(srcPath, dstPath, saveRoot, stats, onFile)
        }
      } else if (entry.isFile()) {
        // 全局设置文件（画质/快捷键/音量）不走 per-modset：基链接直接硬链接安装源，
        // 之后由 linkGlobalSettings 用 settings/ 覆盖（启动器设置优先）
        if (isConfigFile(entry.name) && !GLOBAL_SETTINGS_REL.has(normalizeRel(rel))) {
          linkConfigFile(srcPath, dstPath, path.join(saveRoot, 'config', rel), stats)
        } else {
          hardlinkOrSkip(srcPath, dstPath, stats)
        }
        onFile?.()
      } else if (entry.isSymbolicLink()) {
        // 源是 junction/symlink：重建指向同目标的 junction
        try {
          fs.symlinkSync(fs.readlinkSync(srcPath), dstPath, 'junction')
        } catch (e) {
          stats.failed++
          if (stats.errors.length < 5) stats.errors.push(`${rel}: ${(e as Error).message}`)
        }
      }
    } catch (e) {
      console.error(`[playground] 链接失败 ${srcPath}: ${(e as Error).message}`)
      stats.failed++
      if (stats.errors.length < 5) stats.errors.push(`${rel}: ${(e as Error).message}`)
    }
  }
}

/**
 * 全局设置（画质/快捷键/音量）→ 从 resourceDir/<gameId>/settings/ 硬链接进 playground。
 * 在包覆盖之后执行，启动器设置的设置文件优先于包自带。文件不存在时从本体包播种（无则建空文件）。
 * 游戏运行时的写入通过硬链接落回 settings/，重建不丢。
 */
function linkGlobalSettings(
  resourceDir: string,
  gameId: string,
  sourceDir: string,
  playground: string,
  stats: LinkStats
): void {
  const settingsRoot = path.join(resourceDir, gameId, 'settings')
  for (const rel of GLOBAL_SETTINGS_REL) {
    const globalSrc = path.join(settingsRoot, rel)
    if (!fs.existsSync(globalSrc)) {
      fs.mkdirSync(path.dirname(globalSrc), { recursive: true })
      const seedSrc = path.join(sourceDir, rel)
      try {
        if (fs.existsSync(seedSrc)) {
          fs.copyFileSync(seedSrc, globalSrc)
        } else {
          fs.writeFileSync(globalSrc, '', 'utf-8')
        }
      } catch (e) {
        console.error(`[playground] 播种全局设置失败 ${rel}: ${(e as Error).message}`)
        continue
      }
    }
    hardlinkOrSkip(globalSrc, path.join(playground, rel), stats)
  }
}

/** MOD 覆盖：把 MOD 目录的文件硬链接到 playground 同相对路径（后链接覆盖先链接） */
function linkMod(modDir: string, playground: string, stats: LinkStats): void {
  const walk = (srcDir: string, dstDir: string): void => {
    fs.mkdirSync(dstDir, { recursive: true })
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name)
      const dstPath = path.join(dstDir, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(srcPath, dstPath)
        } else if (entry.isFile()) {
          hardlinkOrSkip(srcPath, dstPath, stats)
        }
      } catch (e) {
        console.error(`[playground] MOD 链接失败 ${srcPath}: ${(e as Error).message}`)
        stats.failed++
        if (stats.errors.length < 5) stats.errors.push(`${path.basename(srcPath)}: ${(e as Error).message}`)
      }
    }
  }
  walk(modDir, playground)
}

/** 从 modsets.json 读当前播放集的包名列表（兼容旧 mods 字段） */
async function getPlaySetPackageNames(resourceDir: string, gameId: string, modSetId: string): Promise<string[]> {
  try {
    const modSetsPath = path.join(resourceDir, gameId, 'modsets.json')
    const data = JSON.parse(await readFile(modSetsPath, 'utf-8')) as Array<{
      id: string
      mods?: Array<{ id: string; name: string }>
      packages?: Array<{ id: string; name: string }>
    }>
    const set = data.find((m) => m.id === modSetId)
    const refs = set?.packages ?? set?.mods
    return refs?.map((m) => m.name) ?? []
  } catch {
    return []
  }
}

// ─── 主入口 ────────────────────────────────────────────

export async function applyPlayground(opts: PlaygroundApplyOptions): Promise<PlaygroundApplyResult> {
  const { gameId, modSetId, onProgress } = opts
  try {
    const config = await readConfig()
    const resourceDir = config.resourceDir
    if (!resourceDir) return { ok: false, error: '请先在设置中选择资源目录' }

    const playground = path.join(resourceDir, gameId, 'playground')
    const saveRoot = path.join(resourceDir, gameId, 'saves', modSetId)
    const stats: LinkStats = { failed: 0, errors: [] }

    // 1. 清空
    onProgress?.(3, '清理工作区...')
    clearDir(playground)
    fs.mkdirSync(playground, { recursive: true })
    onProgress?.(8, '工作区已清理')

    // 2. 游戏本体包作基准（MentalOmega 是安装目录的完整静态副本；可写目录不含）
    const basePkgDir = path.join(resourceDir, gameId, 'packages', 'MentalOmega')
    if (!fs.existsSync(basePkgDir)) {
      return { ok: false, error: '找不到游戏本体包 MentalOmega，请先在包管理中导入' }
    }
    const total = countFiles(basePkgDir)
    let done = 0
    onProgress?.(10, '链接游戏本体包...')
    linkOriginal(basePkgDir, playground, saveRoot, stats, () => {
      done++
      if (total > 0 && (done % 300 === 0 || done === total)) {
        const pct = 10 + Math.round((done / total) * 60)
        onProgress?.(Math.min(pct, 70), '链接游戏本体包...')
      }
    })

    // 3. 其余包覆盖（按播放集顺序，后覆盖胜出；MentalOmega 再次链接是幂等跳过）
    //    可写目录已在 linkOriginal 里按「本体包真实存在的目录」junction，不硬造其它游戏的可写目录
    const packageNames = await getPlaySetPackageNames(resourceDir, gameId, modSetId)
    if (packageNames.length > 0) {
      onProgress?.(72, '链接包文件...')
      for (const packageName of packageNames) {
        const pkgDir = path.join(resourceDir, gameId, 'packages', packageName)
        if (!fs.existsSync(pkgDir)) continue
        linkMod(pkgDir, playground, stats)
      }
      onProgress?.(96, '包文件已链接')
    }

    // 4. 全局设置（画质/快捷键/音量）→ 从 settings/ 硬链接（包覆盖之后，启动器设置优先）
    // 首次使用：本体包缺 KeyboardMD 等基础设置文件时，从安装目录抽一份进包（安装目录只是包的源）
    ensurePackageBaseSettings(readInstallPath(path.join(resourceDir, gameId, 'game.ini')), basePkgDir)
    // 快捷键键位表要全量（游戏直接读 KeyboardMD.ini）：先播种完整键位，再硬链接进游戏目录
    ensureFullKeyboardMap(basePkgDir, path.join(resourceDir, gameId, 'settings'))
    linkGlobalSettings(resourceDir, gameId, basePkgDir, playground, stats)

    // 5. 链接失败必须上报，不能「缺文件还返回成功」
    if (stats.failed > 0) {
      return {
        ok: false,
        error: `${stats.failed} 个文件链接失败：${stats.errors.slice(0, 3).join('；')}`
      }
    }

    onProgress?.(100, '完成')
    return { ok: true, playgroundPath: playground, mapsPath: path.join(resourceDir, gameId, 'maps') }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.message }
  }
}
