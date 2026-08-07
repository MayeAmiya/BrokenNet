<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { GameProfile } from '@renderer/types/profile'
import type { RepoMod, ModManifest } from '@renderer/types/mod'
import type { IniRendererDef, IniGameCheckBoxOption, IniGameDropDownOption } from '@renderer/types/ini-layout'
import { useToast } from '@renderer/composables/useToast'
import { currentPlaygroundPath, playgroundRevision } from '@renderer/composables/lobby-state'
import { useGameConfig } from '@renderer/composables/useGameConfig'
import { computeLaunchGameOptions } from '@renderer/composables/gameOptions'
import LobbyView from './LobbyView.vue'
import CampaignSelector from '@renderer/components/campaign/CampaignSelector.vue'
import ZhSinglePlayerSelector from '@renderer/components/campaign/ZhSinglePlayerSelector.vue'
import KeyboardVisual from '@renderer/components/KeyboardVisual.vue'
import { useCampaign } from '@renderer/composables/useCampaign'

const props = defineProps<{ profile: GameProfile }>()
const emit = defineEmits<{
  updateProfile: [profile: GameProfile]
}>()
const status = ref('')
const launching = ref(false)
const { success: toastSuccess, error: toastError } = useToast()
const activeTab = ref('modsets')

// 战役系统
const { switchModSet, loadCampaignData } = useCampaign()

// INI 配置系统
const {
  rendererList: iniRendererList,
  gameOptions: iniGameOptions,
  clientConfig: iniClientConfig,
  loadRenderers,
  loadGameOptions,
  loadClientConfig
} = useGameConfig()

// 游戏设置
const useGtd = ref(false)
const gtdPath = ref(props.profile.gtdPath ?? '')
const useGenTool = ref(props.profile.useGenTool ?? true)

// 启用 GeneralsTD 时，GenTool 无效
watch(useGtd, (val) => {
  if (val) useGenTool.value = false
  // GeneralsTD 仅影响 ZH；MO 的单人战役和联机入口始终可用。
  if (!isMentalOmega.value && !val && (activeTab.value === 'campaign' || activeTab.value === 'multiplayer')) activeTab.value = 'modsets'
  void saveSettings()
})

watch(useGenTool, () => {
  void saveSettings()
})

// 资源目录
const resourceDir = ref('')

// 检测是否在同一分区
const samePartition = computed(() => {
  if (!resourceDir.value || !props.profile.installPath) return true
  const resDrive = resourceDir.value.slice(0, 1).toUpperCase()
  const gameDrive = props.profile.installPath.slice(0, 1).toUpperCase()
  return resDrive === gameDrive
})

const isMentalOmega = computed(() => props.profile.id === 'mental-omega')

const tabs = computed(() => {
  const allTabs = [
    { id: 'modsets', label: '播放集管理', disabled: !samePartition.value },
    // ZH 的单人/联机需要 TD；MO 不受 TD 开关影响。
    ...(isMentalOmega.value || useGtd.value
      ? [
          { id: 'campaign', label: isMentalOmega.value ? '单人战役' : '单人模式' },
          { id: 'multiplayer', label: '多人联机' }
        ]
      : []),
    { id: 'replays', label: '统计', disabled: !samePartition.value },
    { id: 'mods', label: '包管理' },
    { id: 'maps', label: '地图管理' },
    { id: 'keyboard', label: '快捷键设置', disabled: !props.profile.installPath, tip: '需要先设置游戏安装目录' },
    { id: 'settings', label: '游戏设置' }
  ]
  return allTabs
})

// 切换到 MOD 管理 tab 时自动刷新
watch(activeTab, (tab) => {
  if (tab === 'mods' && repoMods.value.length === 0) {
    loadRepoMods()
  }
  if (tab === 'maps') {
    loadMaps()
  }
  if (tab === 'replays') {
    loadReplays()
  }
})

// ==================== MOD 管理 ====================

// 仓库 MOD 列表
const repoMods = ref<RepoMod[]>([])
const repoLoading = ref(false)
const repoError = ref('')

// 选中的 MOD（用于查看详情/下载）
const selectedRepoMod = ref<RepoMod | null>(null)

// 选中 MOD 的 manifest（版本信息）
const selectedManifest = ref<ModManifest | null>(null)
const manifestLoading = ref(false)

// 选中 MOD 的 patches 和 addons 勾选状态
const selectedPatches = ref<Set<number>>(new Set())
const selectedAddons = ref<Set<number>>(new Set())

// Patches 和 Addons 的 manifest 信息
interface SubModManifest {
  name: string
  version?: string
  imageUrl?: string
}
const patchManifests = ref<Map<number, SubModManifest>>(new Map())
const addonManifests = ref<Map<number, SubModManifest>>(new Map())

// 下载进度
const downloadProgress = ref<Map<string, { status: string; progress: number }>>(new Map())
// 下载 URL 缓存（暂停/恢复用）
const downloadUrlCache = new Map<string, string>()

// 子 mod 下载进度
interface SubDownloadItem {
  name: string
  label: string
  status: string
  progress: number
}

const subDownloadsByMod = computed<Map<string, SubDownloadItem[]>>(() => {
  const map = new Map<string, SubDownloadItem[]>()
  for (const [key, val] of downloadProgress.value.entries()) {
    if (key.includes('_patch_') || key.includes('_addon_')) {
      const parentMod = key.includes('_patch_') ? key.split('_patch_')[0] : key.split('_addon_')[0]
      if (!map.has(parentMod)) map.set(parentMod, [])
      const label = key.includes('_patch_') ? `P${key.split('_patch_')[1]}` : `A${key.split('_addon_')[1]}`
      map.get(parentMod)!.push({ name: key, label, status: val.status, progress: val.progress })
    }
  }
  return map
})

// 已安装的 MOD
interface ModdbPackageSource {
  provider: string
  mod: string
  slug: string
  kind?: 'addon' | 'download'
  fileId?: string
  page?: string
}

interface ModdbInstallItem {
  mod: string
  slug: string
  kind: 'addon' | 'download'
}

const installedMods = ref<Array<{ name: string; path: string; source?: ModdbPackageSource }>>([])
const installedModNames = ref<string[]>([])
const installedModPackageNames = ref<string[]>([])
const zhPackageView = ref<'mods' | 'packages'>('mods')
const moddbPackageCommand = ref('')
const installingModdbPackage = ref(false)
const moddbDownloads = ref<Array<{ slug: string; status: string; progress: number }>>([])
const pendingInstallCommand = ref<any | null>(null)
const commandInstalling = ref(false)
const commandProgress = ref<Record<string, { status: string; progress: number; downloaded?: number; total?: number }>>({})
const localPackageNames = computed(() => new Set(installedMods.value.map((pkg) => pkg.name)))

async function installModdbPackageCommand(): Promise<void> {
  const match = moddbPackageCommand.value.trim().match(/^https?:\/\/www\.moddb\.com\/mods\/([^/]+)\/(addons|downloads)\/([a-z0-9][a-z0-9_-]{1,120})\/?$/i)
  if (!match) return toastError('请输入有效的 ModDB addon 页面网址')
  installingModdbPackage.value = true
  try {
    const result = await window.api.package.installModdbAddon(props.profile.id, match[1], match[3], match[2].toLowerCase() === 'downloads' ? 'download' : 'addon')
    if (!result.ok) return toastError(result.error ?? 'ModDB addon 下载失败')
    moddbPackageCommand.value = ''
    await loadInstalledMods()
    toastSuccess(`已安装 ModDB package「${match[3]}」`)
  } finally { installingModdbPackage.value = false }
}
const playsetCommandInput = ref<HTMLInputElement | null>(null)

async function exportPlaysetCommand(playset?: ModSet): Promise<void> {
  const set = playset ?? modSets.value.find((item) => item.id === selectedModSetId.value)
  if (!set) return toastError('请先选择一个播放集')
  if (set.packages.some((pkg) => localPackageNames.value.has(pkg.name) && pkg.name !== 'ZeroHour' && !installedMods.value.find((item) => item.name === pkg.name)?.source)) {
    return toastError('包含本地 package，当前无法导出安装指令')
  }
  const modPackages = set.packages.filter((pkg) => pkg.name !== 'ZeroHour' && installedModNames.value.includes(pkg.name) && !installedMods.value.find((item) => item.name === pkg.name)?.source)
  const mods = modPackages.map((pkg) => {
    const installed = installedModNames.value.filter((name) => name.startsWith(`${pkg.name}_`))
    const patches = installed.filter((name) => name.includes('_patch_')).map((name) => Number(name.split('_patch_')[1])).filter(Number.isInteger)
    const addons = installed.filter((name) => name.includes('_addon_')).map((name) => Number(name.split('_addon_')[1])).filter(Number.isInteger)
    return {
      id: pkg.name,
      patches,
      addons
    }
  })
  const command = { format: 'brokennet-playset', version: 3, gameId: props.profile.id, name: set.name, description: set.description, mods, packages: set.packages }
  const sourceCommands = set.packages
    .map((pkg) => installedMods.value.find((item) => item.name === pkg.name)?.source)
    .filter((source) => source?.provider === 'moddb')
    .map((source) => `Moddb:${source!.mod}:${source!.kind === 'download' ? 'Download' : 'Addon'}:${source!.slug}`)
  const text = [...sourceCommands, `BN1 ${JSON.stringify(command)}`].join('\n')
  void window.api.clipboard.writeText(text).then(() => toastSuccess('安装命令已复制到剪贴板'))
}

async function importPlaysetCommandFromClipboard(): Promise<void> {
  const text = await window.api.clipboard.readText()
  const moddbPackageIds = new Set<string>()
  const moddbPackages: ModdbInstallItem[] = []
  const normalizeCommandId = (value: string) => value.trim().toLowerCase().replace(/patch(\d+)/g, 'p$1').replace(/[^a-z0-9]/g, '')
  for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const moddb = line.match(/^Moddb:([^:]+):(Addon|Download):([a-z0-9][a-z0-9_-]{1,120})$/i) ?? line.match(/^https?:\/\/www\.moddb\.com\/mods\/([^/]+)\/(addons|downloads)\/([a-z0-9][a-z0-9_-]{1,120})\/?$/i)
    if (!moddb) continue
    moddbPackageIds.add(normalizeCommandId(moddb[3]))
    const kind = (moddb[2].toLowerCase() === 'download' || moddb[2].toLowerCase() === 'downloads') ? 'download' : 'addon'
    if (!moddbPackages.some((item) => normalizeCommandId(item.slug) === normalizeCommandId(moddb[3]))) {
      moddbPackages.push({ mod: moddb[1], slug: moddb[3], kind })
    }
  }
  const payload = text.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith('BN1 '))?.slice(4) ?? text.trim()
  try {
    const command = JSON.parse(payload)
    if (command.format === 'brokennet-playset') {
      if (Array.isArray(command.mods)) command.mods = command.mods.filter((mod: { id?: string }) => !mod.id || !moddbPackageIds.has(normalizeCommandId(mod.id)))
      if (!Array.isArray(command.packages)) command.packages = []
      for (const item of moddbPackages) {
        if (!command.packages.some((pkg: { name?: string }) => pkg.name && normalizeCommandId(pkg.name) === normalizeCommandId(item.slug))) {
          command.packages.push({ id: item.slug, name: item.slug })
        }
      }
      command.moddbPackages = moddbPackages
      commandProgress.value = {}
      pendingInstallCommand.value = command
      return
    }
    throw new Error('剪贴板中没有有效的 BN1 安装命令')
  } catch { toastError('剪贴板中没有有效的安装命令') }
}

async function confirmInstallCommand(): Promise<void> {
  if (!pendingInstallCommand.value || commandInstalling.value) return
  commandInstalling.value = true
  try {
    for (const item of (pendingInstallCommand.value.moddbPackages ?? []) as ModdbInstallItem[]) {
      commandProgress.value = {
        ...commandProgress.value,
        [item.slug]: commandProgress.value[item.slug] ?? { status: 'preparing', progress: 0 }
      }
      const result = await window.api.package.installModdbAddon(props.profile.id, item.mod, item.slug, item.kind)
      if (!result.ok) throw new Error(result.error ?? `ModDB package ${item.slug} 下载失败`)
      commandProgress.value = {
        ...commandProgress.value,
        [item.slug]: { ...commandProgress.value[item.slug], status: 'done', progress: 100 }
      }
    }
    await loadInstalledMods()
    await importPlaysetCommand({ target: { files: [new File([JSON.stringify(pendingInstallCommand.value)], 'clipboard.json')] } } as unknown as Event)
    pendingInstallCommand.value = null
  } catch (error) {
    toastError((error as Error).message || '安装命令执行失败')
  } finally { commandInstalling.value = false }
}

async function importPlaysetCommand(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    await readInstalledMods()
    const command = JSON.parse(await file.text()) as { format?: string; version?: number; gameId?: string; name?: string; description?: string; packages?: ModItem[]; mods?: Array<{ id: string; patches?: number[]; addons?: number[] }> }
    if (command.format !== 'brokennet-playset' || ![1, 2, 3].includes(command.version ?? 0) || command.gameId !== props.profile.id || !command.name || !Array.isArray(command.packages)) throw new Error('不是当前游戏的有效播放集指令')
    if (command.version === 3 && command.mods?.length) {
      const repoResult = repoMods.value.length ? { ok: true, data: { modDatas: repoMods.value } } : await window.api.mod.fetchRepoMods('zh')
      if (!repoResult.ok || !repoResult.data) throw new Error(('error' in repoResult ? repoResult.error : undefined) ?? '无法获取 ZH MOD 仓库')
      for (const requested of command.mods) {
        const normalizeModId = (value: string) => value.trim().toLowerCase().replace(/patch(\d+)/g, 'p$1').replace(/[^a-z0-9]/g, '')
        const requestedId = normalizeModId(requested.id)
        const repo = repoResult.data.modDatas.find((item) => normalizeModId(item.ModName) === requestedId)
        if (!repo) {
          if (installedMods.value.some((pkg) => normalizeModId(pkg.name) === requestedId)) continue
          throw new Error(`仓库中找不到 MOD：${requested.id}（当前清单共 ${repoResult.data.modDatas.length} 项）`)
        }
        const manifestResult = await window.api.mod.fetchManifest(repo.ModLink)
        const manifest = manifestResult.manifest as Record<string, unknown> | undefined
        const mainUrl = typeof manifest?.SimpleDownloadLink === 'string'
          ? manifest.SimpleDownloadLink
          : Array.isArray(manifest?.SimpleDownloadLink) ? String(manifest.SimpleDownloadLink[0] ?? '') : undefined
        if (!mainUrl) throw new Error(`无法解析 ${requested.id} 的主 MOD 下载地址`)
        if (!installedModNames.value.includes(requested.id)) {
          const downloaded = await window.api.mod.download(mainUrl, props.profile.id, requested.id)
          if (!downloaded.ok && !downloaded.alreadyInstalled) throw new Error(downloaded.error ?? `${requested.id} 下载失败`)
        }
        for (const index of [...(requested.patches ?? []).map((i) => ({ index: i, url: repo.ModPatches[i], prefix: 'patch' })), ...(requested.addons ?? []).map((i) => ({ index: i, url: repo.ModAddons[i], prefix: 'addon' }))]) {
          if (!index.url) throw new Error(`${requested.id} 的 ${index.prefix} 索引 ${index.index} 不存在`)
          const childName = `${requested.id}_${index.prefix}_${index.index}`
          if (installedModNames.value.includes(childName)) continue
          const childManifestResult = await window.api.mod.fetchManifest(index.url)
          const childManifest = childManifestResult.manifest as Record<string, unknown> | undefined
          const childDownloadUrl = typeof childManifest?.SimpleDownloadLink === 'string'
            ? childManifest.SimpleDownloadLink
            : Array.isArray(childManifest?.SimpleDownloadLink) ? String(childManifest.SimpleDownloadLink[0] ?? '') : undefined
          if (!childDownloadUrl) throw new Error(`无法解析 ${childName} 的下载地址`)
          const downloaded = await window.api.mod.download(childDownloadUrl, props.profile.id, childName)
          if (!downloaded.ok && !downloaded.alreadyInstalled) throw new Error(downloaded.error ?? `${childName} 下载失败`)
        }
        await readInstalledMods()
      }
    }
    const normalizePackageId = (value: string) => value.trim().toLowerCase().replace(/patch(\d+)/g, 'p$1').replace(/[^a-z0-9]/g, '')
    const importedPackages = command.packages.map((pkg) => {
      if (pkg.name === 'ZeroHour' || command.mods?.some((mod) => normalizePackageId(mod.id) === normalizePackageId(pkg.name))) return { id: pkg.id, name: pkg.name }
      const installed = installedMods.value.find((item) => normalizePackageId(item.name) === normalizePackageId(pkg.name))
      return installed ? { id: installed.name, name: installed.name } : { id: pkg.id, name: pkg.name }
    })
    const imported: ModSet = { id: `imported:${Date.now()}`, name: command.name, description: command.description ?? '导入的播放集', packages: importedPackages }
    modSets.value = [...modSets.value, imported]
    selectedModSetId.value = imported.id
    await saveModSetsToDisk()
    toastSuccess(`已导入播放集「${imported.name}」`)
  } catch (error) {
    toastError((error as Error).message || '播放集指令导入失败')
  }
}

// 加载仓库 MOD 列表
async function loadRepoMods(): Promise<void> {
  repoLoading.value = true
  repoError.value = ''
  try {
    const result = await window.api.mod.fetchRepoMods('zh')
    if (result.ok && result.data) {
      repoMods.value = result.data.modDatas
    } else {
      repoError.value = result.error ?? '获取 MOD 列表失败'
    }
  } catch (e) {
    repoError.value = (e as Error).message
  } finally {
    repoLoading.value = false
  }
}

// 选中 MOD 时加载 manifest
async function selectRepoMod(mod: RepoMod): Promise<void> {
  selectedRepoMod.value = mod
  selectedManifest.value = null
  selectedPatches.value = new Set()
  selectedAddons.value = new Set()
  patchManifests.value = new Map()
  addonManifests.value = new Map()
  manifestLoading.value = true

  // 根据磁盘上已安装的 patch/addon 初始化勾选状态
  const installed = (name: string) => installedModNames.value.includes(name)
  for (let i = 0; i < mod.ModPatches.length; i++) {
    if (installed(`${mod.ModName}_patch_${i}`)) selectedPatches.value.add(i)
  }
  for (let i = 0; i < mod.ModAddons.length; i++) {
    if (installed(`${mod.ModName}_addon_${i}`)) selectedAddons.value.add(i)
  }
  installedPatchState.value = new Set(selectedPatches.value)
  installedAddonState.value = new Set(selectedAddons.value)
  mainModNeedsUpdate.value = false
  needUpdate.value = false

  try {
    // 获取 MOD 本体 manifest
    const result = await window.api.mod.fetchManifest(mod.ModLink)
    if (result.ok && result.manifest) {
      selectedManifest.value = result.manifest as unknown as ModManifest

      // 对比远程版本和本地版本
      if (isModInstalled.value) {
        const remoteVersion = (result.manifest as Record<string, unknown>).Version as string ?? ''
        const localResult = await window.api.mod.getVersion(props.profile.id, mod.ModName)
        const localVersion = localResult.version ?? ''
        if (remoteVersion && localVersion && remoteVersion !== localVersion) {
          mainModNeedsUpdate.value = true
          needUpdate.value = true
        }
      }
    }

    // 获取所有 patches 的 manifest
    for (let i = 0; i < mod.ModPatches.length; i++) {
      const patchResult = await window.api.mod.fetchManifest(mod.ModPatches[i])
      if (patchResult.ok && patchResult.manifest) {
        const m = patchResult.manifest as Record<string, unknown>
        patchManifests.value.set(i, {
          name: (m.Name as string) ?? `补丁 ${i + 1}`,
          version: m.Version as string | undefined,
          imageUrl: m.UIImageSourceLink as string | undefined
        })
      } else {
        patchManifests.value.set(i, { name: `补丁 ${i + 1}` })
      }
    }

    // 获取所有 addons 的 manifest
    for (let i = 0; i < mod.ModAddons.length; i++) {
      const addonResult = await window.api.mod.fetchManifest(mod.ModAddons[i])
      if (addonResult.ok && addonResult.manifest) {
        const m = addonResult.manifest as Record<string, unknown>
        addonManifests.value.set(i, {
          name: (m.Name as string) ?? `Addon ${i + 1}`,
          version: m.Version as string | undefined,
          imageUrl: m.UIImageSourceLink as string | undefined
        })
      } else {
        addonManifests.value.set(i, { name: `Addon ${i + 1}` })
      }
    }
  } catch (e) {
    console.error('加载 manifest 失败:', e)
  } finally {
    manifestLoading.value = false
  }
}

// 切换 patch 勾选
function togglePatch(index: number): void {
  if (selectedPatches.value.has(index)) {
    selectedPatches.value.delete(index)
  } else {
    selectedPatches.value.add(index)
  }
  checkNeedUpdate()
}

// 切换 addon 勾选
function toggleAddon(index: number): void {
  if (selectedAddons.value.has(index)) {
    selectedAddons.value.delete(index)
  } else {
    selectedAddons.value.add(index)
  }
  checkNeedUpdate()
}

// 检查是否需要更新
const needUpdate = ref(false)
const installedPatchState = ref<Set<number>>(new Set())
const installedAddonState = ref<Set<number>>(new Set())
const mainModNeedsUpdate = ref(false)

function checkNeedUpdate(): void {
  if (!isModInstalled.value) return
  const patchChanged = installedPatchState.value.size !== selectedPatches.value.size ||
    [...installedPatchState.value].some(i => !selectedPatches.value.has(i))
  const addonChanged = installedAddonState.value.size !== selectedAddons.value.size ||
    [...installedAddonState.value].some(i => !selectedAddons.value.has(i))
  needUpdate.value = patchChanged || addonChanged || mainModNeedsUpdate.value
}

// 判断当前 MOD 是否已安装
const isModInstalled = computed(() => {
  if (!selectedRepoMod.value) return false
  return installedModNames.value.includes(selectedRepoMod.value!.ModName)
})

// 判断当前 MOD 是否正在下载
const isDownloading = computed(() => {
  if (!selectedRepoMod.value) return false
  return downloadProgress.value.get(selectedRepoMod.value.ModName)?.status === 'downloading'
})

// 下载 MOD（首次安装）
async function downloadMod(mod: RepoMod): Promise<void> {
  await readInstalledMods()
  if (installedModNames.value.includes(mod.ModName)) {
    downloadProgress.value.delete(mod.ModName)
    toastSuccess(`「${mod.ModName}」已经安装`)
    return
  }
  downloadProgress.value.set(mod.ModName, { status: 'downloading', progress: 0 })

  const manifestResult = await window.api.mod.fetchManifest(mod.ModLink)
  if (!manifestResult.ok || !manifestResult.manifest) {
    downloadProgress.value.set(mod.ModName, { status: 'error', progress: 0 })
    toastError(manifestResult.error ?? `无法获取「${mod.ModName}」的 manifest`)
    return
  }
  const manifest = manifestResult.manifest as Record<string, unknown>
  const downloadUrl = manifest.SimpleDownloadLink as string
  if (!downloadUrl) {
    downloadProgress.value.set(mod.ModName, { status: 'error', progress: 0 })
    toastError(`「${mod.ModName}」manifest 中没有有效下载地址`)
    return
  }

  downloadUrlCache.set(mod.ModName, downloadUrl)

  const result = await window.api.mod.download(downloadUrl, props.profile.id, mod.ModName)
  if (!result.ok) {
    if (result.alreadyInstalled) {
      downloadProgress.value.delete(mod.ModName)
      await loadInstalledMods()
      toastSuccess(`「${mod.ModName}」已经安装`)
      return
    }
    downloadProgress.value.set(mod.ModName, { status: 'error', progress: 0 })
    return
  }

  // 保存版本号
  const version = manifest.Version as string ?? ''
  if (version) {
    await window.api.mod.setVersion(props.profile.id, mod.ModName, version)
  }

  await downloadPatchesAndAddons(mod)

  installedPatchState.value = new Set(selectedPatches.value)
  installedAddonState.value = new Set(selectedAddons.value)
  mainModNeedsUpdate.value = false
  needUpdate.value = false

  downloadProgress.value.set(mod.ModName, { status: 'done', progress: 100 })
  loadInstalledMods()
}

// 修改：主mod有更新就重下主mod，再补下载缺失的 patch/addon
async function modifyMod(mod: RepoMod): Promise<void> {
  downloadProgress.value.set(mod.ModName, { status: 'downloading', progress: 0 })

  // 主 mod 有新版本，重新下载
  if (mainModNeedsUpdate.value) {
    const manifestResult = await window.api.mod.fetchManifest(mod.ModLink)
    if (manifestResult.ok && manifestResult.manifest) {
      const manifest = manifestResult.manifest as Record<string, unknown>
      const downloadUrl = manifest.SimpleDownloadLink as string
      if (downloadUrl) {
        const r = await window.api.mod.download(downloadUrl, props.profile.id, mod.ModName, true)
        if (r.ok) {
          const version = manifest.Version as string ?? ''
          if (version) await window.api.mod.setVersion(props.profile.id, mod.ModName, version)
        }
      }
    }
  }

  await downloadPatchesAndAddons(mod)

  installedPatchState.value = new Set(selectedPatches.value)
  installedAddonState.value = new Set(selectedAddons.value)
  mainModNeedsUpdate.value = false
  needUpdate.value = false

  downloadProgress.value.set(mod.ModName, { status: 'done', progress: 100 })
  loadInstalledMods()
}

// 并行下载选中的 patches 和 addons（跳过已安装的），聚合进度到主 mod
async function downloadPatchesAndAddons(mod: RepoMod): Promise<void> {
  const isInstalled = (name: string) => installedModNames.value.includes(name)

  // 收集需要下载的任务
  const downloadTasks: Array<{ name: string; url: string }> = []

  for (const idx of selectedPatches.value) {
    const patchName = `${mod.ModName}_patch_${idx}`
    if (isInstalled(patchName)) continue
    const patchUrl = mod.ModPatches[idx]
    if (!patchUrl) continue
    const r = await window.api.mod.fetchManifest(patchUrl)
    if (r.ok && r.manifest) {
      const url = (r.manifest as Record<string, unknown>).SimpleDownloadLink as string
      if (url) downloadTasks.push({ name: patchName, url })
    }
  }

  for (const idx of selectedAddons.value) {
    const addonName = `${mod.ModName}_addon_${idx}`
    if (isInstalled(addonName)) continue
    const addonUrl = mod.ModAddons[idx]
    if (!addonUrl) continue
    const r = await window.api.mod.fetchManifest(addonUrl)
    if (r.ok && r.manifest) {
      const url = (r.manifest as Record<string, unknown>).SimpleDownloadLink as string
      if (url) downloadTasks.push({ name: addonName, url })
    }
  }

  if (downloadTasks.length === 0) return

  // 并行下载，用计数器聚合进度到主 mod
  let completed = 0
  const total = downloadTasks.length
  const progressMap = new Map<string, number>()

  const tasks = downloadTasks.map(task => {
    // 监听这个子下载的进度
    const removeListener = window.api.mod.onDownloadProgress((data) => {
      if (data.modName === task.name) {
        progressMap.set(task.name, data.progress)
        // 聚合：所有子下载的平均进度
        let sum = 0
        for (const p of progressMap.values()) sum += p
        const avg = Math.round(sum / total)
        downloadProgress.value.set(mod.ModName, {
          status: 'downloading',
          progress: avg
        })
      }
      // 子下载完成
      if (data.modName === task.name && data.status === 'done') {
        progressMap.set(task.name, 100)
        completed++
      }
    })

    return window.api.mod.download(task.url, props.profile.id, task.name).finally(() => {
      if (typeof removeListener === 'function') removeListener()
    })
  })

  await Promise.all(tasks)
}

// 删除 MOD（repo 下载的包）
async function deleteMod(modName: string): Promise<void> {
  const result = await window.api.package.delete(props.profile.id, modName)
  if (result.ok) {
    // 也删除关联的 patch/addon
    const mod = repoMods.value.find(m => m.ModName === modName)
    if (mod) {
      for (let i = 0; i < mod.ModPatches.length; i++) {
        await window.api.package.delete(props.profile.id, `${modName}_patch_${i}`)
      }
      for (let i = 0; i < mod.ModAddons.length; i++) {
        await window.api.package.delete(props.profile.id, `${modName}_addon_${i}`)
      }
    }
    installedPatchState.value = new Set()
    installedAddonState.value = new Set()
    needUpdate.value = false
    loadInstalledMods()
  }
}

// 加载已安装的包（ZH 下载 UI 的"已安装"标记 + 播放集右栏可用包都靠它）
async function readInstalledMods(): Promise<void> {
  const result = await window.api.package.list(props.profile.id)
  if (result.ok) {
    installedMods.value = result.packages
  }
  const modResult = await window.api.mod.listInstalled(props.profile.id)
  if (modResult.ok) installedModNames.value = [...new Set([...modResult.mods, ...modResult.packages])]
  installedModPackageNames.value = installedMods.value.map((pkg) => pkg.name)
}

async function loadInstalledMods(): Promise<void> {
  await readInstalledMods()
  if (!isMentalOmega.value) {
    await window.api.modset.ensureDefault(props.profile.id)
    await loadModSets()
  }
}

// 导入文件夹 / 导入压缩包 / 拖拽导入（共用导入结果处理）
async function handleImportResult(result: { ok: boolean; imported?: string[]; error?: string }): Promise<void> {
  if (result.ok && result.imported?.length) {
    toastSuccess(`已导入 ${result.imported.length} 个包`)
    await loadInstalledMods()
  } else if (result.error && result.error !== '已取消') {
    toastError(result.error)
  }
}

function openPackagesFolder(): void {
  void window.api.fs.openPackagesDir(props.profile.id)
}
function openPlaygroundFolder(): void {
  void window.api.fs.openPlaygroundDir(props.profile.id)
}

async function importFolder(): Promise<void> {
  await handleImportResult(await window.api.package.importFolder(props.profile.id))
}

async function importArchive(): Promise<void> {
  await handleImportResult(await window.api.package.importArchive(props.profile.id))
}

// 拖拽导入：从 e.dataTransfer 提取本地路径（文件夹/压缩包均可）
async function onDropImport(e: DragEvent): Promise<void> {
  e.preventDefault()
  dropActive.value = false
  const paths: string[] = []
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    const p = (f as any).path
    if (p) paths.push(p)
  }
  if (paths.length) await handleImportResult(await window.api.package.importPaths(props.profile.id, paths))
}

const dropActive = ref(false)

// 删除包
async function deletePackage(name: string): Promise<void> {
  if (!confirm(`删除包「${name}」？`)) return
  const result = await window.api.package.delete(props.profile.id, name)
  if (result.ok) {
    await loadInstalledMods()
  } else {
    toastError(result.error ?? '删除失败')
  }
}

// 暂停下载
async function pauseDownload(modName: string): Promise<void> {
  await window.api.mod.pauseDownload(modName)
  downloadProgress.value.set(modName, {
    status: 'paused',
    progress: downloadProgress.value.get(modName)?.progress ?? 0
  })
}

// 恢复下载（重新触发下载，后端会用 Range 头续传）
async function resumeDownload(modName: string): Promise<void> {
  const url = downloadUrlCache.get(modName)
  if (!url) {
    // 没有缓存 URL，需要重新获取 manifest
    const mod = repoMods.value.find(m => m.ModName === modName)
    if (mod) {
      await downloadMod(mod)
    }
    return
  }

  // 有缓存 URL，直接重新下载（后端会用 Range 头续传）
  downloadProgress.value.set(modName, { status: 'downloading', progress: 0 })
  const result = await window.api.mod.download(url, props.profile.id, modName)
  if (result.ok) {
    downloadProgress.value.set(modName, { status: 'done', progress: 100 })
    loadInstalledMods()
  } else {
    // paused 状态已由 onDownloadProgress 设置，只处理 error
    if (result.error !== '下载已暂停') {
      downloadProgress.value.set(modName, { status: 'error', progress: 0 })
    }
  }
}

// 取消下载
async function cancelDownload(modName: string): Promise<void> {
  await window.api.mod.cancelDownload(modName)
  downloadProgress.value.delete(modName)
  downloadUrlCache.delete(modName)
}

// 监听下载进度（全局，组件卸载时清理）
const removeGlobalListener = window.api.mod.onDownloadProgress((data) => {
  downloadProgress.value.set(data.modName, {
    status: data.status,
    progress: data.progress
  })
  const previous = commandProgress.value[data.modName]
  const nextProgress = data.status === 'done' ? 100 : Math.max(previous?.progress ?? 0, data.progress ?? 0)
  commandProgress.value = { ...commandProgress.value, [data.modName]: { status: data.status, progress: nextProgress, downloaded: Math.max(previous?.downloaded ?? 0, data.downloaded ?? 0), total: Math.max(previous?.total ?? 0, data.total ?? 0) } }
})

onUnmounted(() => {
  if (typeof removeGlobalListener === 'function') removeGlobalListener()
})

// MOD 项
interface ModItem {
  id: string
  name: string
}

// 播放集
interface ModSet {
  id: string
  name: string
  description: string
  background?: string
  packages: ModItem[]
}

// 播放集持久化
async function loadModSets(): Promise<void> {
  const result = await window.api.modset.list(props.profile.id)
  if (result.ok) {
    modSets.value = result.modSets
    // 恢复上次选中的播放集（已持久化且仍存在才生效）
    const saved = localStorage.getItem(modSetStorageKey.value)
    if (saved && modSets.value.some((m) => m.id === saved)) {
      selectedModSetId.value = saved
    }
  }
}

async function saveModSetsToDisk(): Promise<boolean> {
  // 关键：Vue 的 ref/reactive 值是 Proxy，Electron IPC 无法 structured-clone（"An object could not be cloned"）。
  // 必须深克隆成普通对象再传。
  const plain = JSON.parse(JSON.stringify(modSets.value))
  const r = await window.api.modset.save(props.profile.id, plain)
  console.log('[saveModSetsToDisk]', props.profile.id, plain.length, '个播放集:', plain.map((s: any) => s.id), '->', r)
  if (!r.ok) {
    toastError(r.error ?? '播放集保存失败')
    return false
  }
  return true
}

// 已安装的主 MOD（用于播放集右侧列表，排除 patch/addon 子项）
const downloadedMods = computed<ModItem[]>(() => {
  return installedMods.value
    .filter((m) => !m.name.includes('_patch_') && !m.name.includes('_addon_'))
    .map((m) => ({ id: m.name, name: m.name }))
})

const modSets = ref<ModSet[]>([
  { id: 'vanilla', name: '原版', description: '不加载任何 MOD', packages: [] }
])

const selectedModSetId = ref<string>('vanilla')
// 当前选中的播放集按游戏持久化（localStorage），重启后恢复
const modSetStorageKey = computed(() => `selected-modset-${props.profile.id}`)
const showDropdown = ref(false)
const dropdownRef = ref<HTMLDivElement | null>(null)
const editingModSetId = ref<string | null>(null)
const editingModSet = ref<ModSet | null>(null)
const showCreateForm = ref(false)
const newModSet = ref({ name: '', description: '' })

// 下拉框 click-outside 关闭
function handleDropdownClickOutside(e: MouseEvent): void {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    showDropdown.value = false
  }
}

onMounted(async () => {
  const stopModdbProgress = window.api.package.onModdbProgress((data) => {
    const existing = moddbDownloads.value.find((item) => item.slug === data.slug)
    if (existing) { existing.status = data.status; existing.progress = data.progress }
    else moddbDownloads.value.push({ slug: data.slug, status: data.status, progress: data.progress })
    const previous = commandProgress.value[data.slug]
    commandProgress.value = {
      ...commandProgress.value,
      [data.slug]: {
        status: data.status,
        progress: data.status === 'done' ? 100 : Math.max(previous?.progress ?? 0, data.progress ?? 0),
        downloaded: Math.max(previous?.downloaded ?? 0, data.received ?? 0),
        total: Math.max(previous?.total ?? 0, data.total ?? 0)
      }
    }
  })
  onUnmounted(stopModdbProgress)
  document.addEventListener('click', handleDropdownClickOutside)
  resourceDir.value = (await window.api.fs.getConfig('resourceDir')) ?? ''
  // 确保默认"原版"播放集存在（游戏本体视为包），再加载播放集
  await window.api.modset.ensureDefault(props.profile.id)
  await readInstalledMods()
  await loadModSets() // 内部会恢复上次选中的播放集
  // 首次用当前播放集重建 playground（地图/战役数据源），再初始化战役
  await rebuildPlayground(selectedModSetId.value)
  switchModSet(selectedModSetId.value)
  if (props.profile.installPath) {
    loadCampaignData(selectedModSetId.value, props.profile.id, currentPlaygroundPath.value || props.profile.installPath)
  }
})

// 播放集切换时同步战役状态
watch(selectedModSetId, (id) => {
  switchModSet(id)
  if (props.profile.installPath) {
    loadCampaignData(id, props.profile.id, currentPlaygroundPath.value || props.profile.installPath)
  }
})

// 切换播放集重建 playground 完成（版本号递增）→ 单人战役从新 playground 重新加载
watch(playgroundRevision, () => {
  if (currentPlaygroundPath.value && props.profile.installPath) {
    loadCampaignData(selectedModSetId.value, props.profile.id, currentPlaygroundPath.value)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', handleDropdownClickOutside)
  window.removeEventListener('keydown', onCaptureKeydown, true)
})

// 拖拽状态
const dragSource = ref<'left' | 'right' | null>(null)
const dragIndex = ref<number>(-1)
const dragOverTarget = ref<'left' | 'right' | null>(null)
const dragOverIndex = ref<number>(-1)

// 当前选中的播放集
const selectedModSet = computed(() => modSets.value.find((m) => m.id === selectedModSetId.value) ?? null)

// 当前播放集中已有的 MOD ID
const editingModIds = computed(() => new Set(editingModSet.value?.packages.map((m) => m.id) ?? []))

// 右侧可用 MOD（排除已添加的）
const availableMods = computed(() => downloadedMods.value.filter((m) => !editingModIds.value.has(m.id)))

function selectModSet(id: string): void {
  selectedModSetId.value = id
  showDropdown.value = false
  localStorage.setItem(modSetStorageKey.value, id)
  // 启用播放集：重建 playground（删旧+按新播放集硬链接覆盖），地图/战役数据源随之更新
  void rebuildPlayground(id)
}

/** 用指定播放集重建 playground 并记录路径（全局设置从 settings/ 硬链接，见 playground-manager） */
async function rebuildPlayground(modSetId: string): Promise<void> {
  console.log('[GameView] 开始重建 playground，播放集:', modSetId)
  try {
    const res = await window.api.playground.apply(props.profile.id, modSetId)
    console.log('[GameView] playground.apply 结果:', JSON.stringify({ ok: res.ok, path: res.playgroundPath, error: res.error }))
    if (res.ok && res.playgroundPath) {
      currentPlaygroundPath.value = res.playgroundPath
      playgroundRevision.value++ // 路径固定，重建成功用版本号通知大厅/战役重载
      console.log('[GameView] playground 已重建:', res.playgroundPath, 'modSet:', modSetId, 'rev:', playgroundRevision.value)
    }
  } catch (e) {
    console.error('[GameView] playground 重建失败:', e)
  }
}

async function launch(): Promise<void> {
  if (launching.value) return
  launching.value = true
  const isMO = props.profile.id === 'mental-omega'
  // MO 用 Syringe.exe（Ares 加载器）启动 gamemd.exe，不是 MentalOmegaClient.exe
  const exe = isMO
    ? 'Syringe.exe'
    : props.profile.useGtd && props.profile.gtdPath
      ? `${props.profile.gtdPath}\\GeneralsTD.exe`
      : `${props.profile.generalsPath}\\Generals.exe`
  // MO 启动：Syringe.exe "gamemd.exe" -SPAWN -CD ... （Syringe 第一个参数是游戏本体名）
  // ZH 直接启动：generals.exe [-win]，不走 spawn.ini（对齐 GenLauncher）
  // 窗口化判定：windowMode 可能没加载（从播放集管理直接启动时 settings 没开过），
  // 这时读 Options.ini 的 Windowed 判断 —— 窗口化就传 -win。
  let windowed = windowMode.value === 'windowed' || windowMode.value === 'borderless'
  if (!isMO && !useGtd.value) {
    try {
      const res = await window.api.options.read(getGameType())
      if (res?.options?.Windowed?.trim() === 'yes') windowed = true
    } catch { /* 读不到用 UI 状态 */ }
  }
  const args = isMO
    ? ['"gamemd.exe"', '-SPAWN', '-CD', '-SPEEDCONTROL', '-LOG', '-AFFINITY:65535']
    : (windowed ? ['-win'] : [])

  try {
    // 构建当前播放集的 playground 工作区（游戏从 playground 运行），期间显示进度
    status.value = '准备游戏工作区...'
    const removeListener = window.api.playground.onProgress(({ percent, label }) => {
      status.value = `${label} ${percent}%`
    })
    try {
      const applyResult = await window.api.playground.apply(props.profile.id, selectedModSetId.value)
      if (!applyResult.ok || !applyResult.playgroundPath) {
        status.value = applyResult.error ?? '工作区构建失败'
        return
      }
      const gameDir = applyResult.playgroundPath

      status.value = '启动中...'
      // 直接启动无大厅：用 GameOptions.ini 的默认勾选状态生成游戏选项（对齐 xna ApplySpawnIniCode）
      let extraSettings: Record<string, string> = {}
      try {
        const opts = await window.api.mpLobbyOptions.load(gameDir)
        if (opts) {
          const cbV: Record<string, boolean> = {}
          for (const cb of opts.checkboxes) if (cb.visible) cbV[cb.name] = cb.checked
          const ddV: Record<string, number> = {}
          for (const dd of opts.dropdowns) ddV[dd.name] = dd.defaultIndex
          extraSettings = computeLaunchGameOptions(opts.checkboxes, opts.dropdowns, cbV, ddV, opts.forcedSpawnIniOptions).spawnIniSettings
        }
      } catch { /* 无 GameOptions.ini 时跳过游戏选项 */ }

      const result = await window.api.game.launch({
        gameDir,
        exe: exe.split('\\').pop() ?? 'Syringe.exe',
        args,
        // ZH 视角高度：自定义时启动前原地改 GameData.ini 的 .big（playground 硬链接的）
        cameraHeight: isMO ? undefined : (zhUseCustomCamera.value ? zhCameraHeight.value : 0),
        spawnOptions: {
          mode: 'skirmish',
          gameDir,
          playerName: 'Player',
          scenario: 'spawnmap.ini', // 注意：直接启动无地图上下文，spawnmap 需由 lobby 流程生成（地图管理制作中）
          side: 0,
          color: 0,
          playerCount: 2,
          aiPlayers: 1,
          extraSettings,
          mpMapsPath: applyResult.mapsPath,
          seed: Math.floor(Math.random() * 99999999)
        }
      })
      if (result.ok) {
        status.value = '游戏已启动'
      } else {
        status.value = result.error ?? '启动失败'
      }
    } finally {
      if (typeof removeListener === 'function') removeListener()
    }
  } finally {
    launching.value = false
  }
}

/** 播放集管理里「启动游戏」：先把该播放集设为当前（未选中时），再走正常启动链 */
async function launchPlaySetFromCard(mod: ModSet): Promise<void> {
  if (launching.value) return
  if (mod.id !== selectedModSetId.value) {
    selectedModSetId.value = mod.id
    localStorage.setItem(modSetStorageKey.value, mod.id)
  }
  await launch()
}

/** 播放集管理右上角「启动游戏」：启动当前选中的播放集 */
async function launchSelectedPlaySet(): Promise<void> {
  if (launching.value) return
  const mod = selectedModSet.value
  if (!mod) return
  await launchPlaySetFromCard(mod)
}

function startEdit(mod: ModSet): void {
  editingModSetId.value = mod.id
  editingModSet.value = { ...mod, packages: [...mod.packages] }
}

async function saveEdit(): Promise<void> {
  if (!editingModSet.value || !editingModSetId.value) return
  const i = modSets.value.findIndex((m) => m.id === editingModSetId.value)
  if (i >= 0) modSets.value[i] = { ...editingModSet.value }
  editingModSetId.value = null
  editingModSet.value = null
  await saveModSetsToDisk()
}

function cancelEdit(): void {
  editingModSetId.value = null
  editingModSet.value = null
}

async function deleteModSet(id: string): Promise<void> {
  modSets.value = modSets.value.filter((m) => m.id !== id)
  if (selectedModSetId.value === id) {
    selectedModSetId.value = 'vanilla'
    localStorage.setItem(modSetStorageKey.value, 'vanilla')
  }
  await saveModSetsToDisk()
}

// 删除确认
const showDeleteConfirm = ref(false)
const pendingDeleteId = ref('')

function confirmDeleteModSet(mod: ModSet): void {
  pendingDeleteId.value = mod.id
  showDeleteConfirm.value = true
}

function cancelDelete(): void {
  showDeleteConfirm.value = false
  pendingDeleteId.value = ''
}

async function executeDelete(): Promise<void> {
  await deleteModSet(pendingDeleteId.value)
  showDeleteConfirm.value = false
  pendingDeleteId.value = ''
}

function shareModSet(_id: string): void {
  status.value = '分享功能开发中...'
}

async function createModSet(): Promise<void> {
  if (!newModSet.value.name) return
  modSets.value.push({
    id: `mod-${Date.now()}`,
    name: newModSet.value.name,
    description: newModSet.value.description,
    packages: []
  })
  newModSet.value = { name: '', description: '' }
  showCreateForm.value = false
  await saveModSetsToDisk()
}

// 复制播放集：深拷贝内容 + 新 id/名称（副本），直接落盘
async function copyModSet(mod: ModSet): Promise<void> {
  const base = mod.name.replace(/\s*（副本）\s*$/, '')
  const copy: ModSet = {
    ...mod,
    id: isMentalOmega.value ? `mod-${Date.now()}` : `zh-copy:${mod.packages[1]?.name ?? 'vanilla'}:${Date.now()}`,
    name: `${base}（副本）`,
    packages: mod.packages.map((p) => ({ ...p }))
  }
  modSets.value.push(copy)
  toastSuccess(`已复制播放集「${mod.name}」`)
  await saveModSetsToDisk()
}

// 拖拽：从右侧添加 MOD
function addMod(mod: ModItem): void {
  if (!editingModSet.value) return
  editingModSet.value.packages.push({ ...mod })
}

// 拖拽：从左侧移除 MOD
function removeMod(index: number): void {
  if (!editingModSet.value) return
  editingModSet.value.packages.splice(index, 1)
}

// 拖拽开始
function onDragStart(source: 'left' | 'right', index: number): void {
  dragSource.value = source
  dragIndex.value = index
}

// 拖拽悬停（高亮放置区域）
function onDragOver(target: 'left' | 'right', index: number): void {
  dragOverTarget.value = target
  dragOverIndex.value = index
}

function onDragLeave(): void {
  dragOverTarget.value = null
  dragOverIndex.value = -1
}

// 拖拽放下
function onDrop(target: 'left' | 'right', targetIndex: number): void {
  if (!editingModSet.value) return

  if (dragSource.value === 'right' && target === 'left') {
    // 从右侧添加到左侧
    const mod = availableMods.value[dragIndex.value]
    if (mod) editingModSet.value.packages.splice(targetIndex, 0, { ...mod })
  } else if (dragSource.value === 'left' && target === 'right') {
    // 从左侧移除
    editingModSet.value.packages.splice(dragIndex.value, 1)
  } else if (dragSource.value === 'left' && target === 'left') {
    // 左侧内部排序
    const mods = editingModSet.value.packages
    const item = mods.splice(dragIndex.value, 1)[0]
    if (item) mods.splice(targetIndex, 0, item)
  }

  dragSource.value = null
  dragIndex.value = -1
  dragOverTarget.value = null
  dragOverIndex.value = -1
}

// 拖拽结束（取消）
function onDragEnd(): void {
  dragSource.value = null
  dragIndex.value = -1
  dragOverTarget.value = null
  dragOverIndex.value = -1
}

// ==================== 画质设置 ====================

const graphicsLoading = ref(false)
const graphicsSaving = ref(false)

// 画质选项
const resolution = ref('1920×1080')
const resolutionList = ref<string[]>([])
const zhOptions = ref<Record<string, string>>({})
const zhMaxParticleCount = ref(2500)
const zhTextureQuality = ref(1)
// 视角高度（对齐 GenLauncher）：CameraHeight=0 用默认视角；>0 自定义（滑杆 310–850）
const zhCameraHeight = ref(310)
const zhUseCustomCamera = ref(false)
// ZH 窗口模式：Options.ini Windowed，启动时传 -win
const windowMode = ref<'fullscreen' | 'windowed' | 'borderless'>('fullscreen')
const ZH_GRAPHICS_TOGGLES = [
  { key: 'UseShadowVolumes', label: '3D 阴影' },
  { key: 'UseShadowDecals', label: '2D 阴影' },
  { key: 'UseCloudMap', label: '云层阴影' },
  { key: 'ShowTrees', label: '场景物件' },
  { key: 'BuildingOcclusion', label: '建筑物遮挡' },
  { key: 'ExtraAnimations', label: '额外动画' },
  { key: 'UseLightMap', label: '额外地面光照' },
  { key: 'ShowSoftWaterEdge', label: '平滑水面边缘' },
  { key: 'HeatEffects', label: '热浪效果' },
  { key: 'UseAlternateMouse', label: '备用鼠标' }
]

// MO 画质选项（不依赖 Options.ini，直接从渲染补丁的 ddraw.ini 读写）
const MO_RESOLUTION_LIST = [
  '640×480', '800×600', '1024×768', '1152×864',
  '1280×720', '1280×768', '1280×800', '1280×960', '1280×1024',
  '1360×768', '1366×768', '1440×900', '1600×900',
  '1600×1024', '1600×1200', '1680×1050',
  '1920×1080', '1920×1200', '1920×1440',
  '2560×1440', '3840×2160'
]
const moRendererKey = ref('')
const moResolution = ref('1920×1080')
const moWindowMode = ref<'fullscreen' | 'windowed' | 'borderless'>('fullscreen')
const moPrevRendererKey = ref('')
// 画质档位：RA2MO.ini [Options] DetailLevel，0=低 1=中 2=高
const moDetailLevel = ref(1)
const MO_DETAIL_LEVELS = [
  { value: 0, label: '低' },
  { value: 1, label: '中' },
  { value: 2, label: '高' }
]

// 判断游戏类型
function getGameType(): 'zh' | 'gen' {
  return props.profile.id === 'zero-hour' ? 'zh' : 'gen'
}

// 加载画质设置
async function loadGraphicsSettings(): Promise<void> {
  graphicsLoading.value = true
  try {
    const installPath = props.profile.installPath

    if (isMentalOmega.value) {
      // ===== 心灵终结：从 Resources/Renderers.ini + ddraw.ini 加载 =====
      await loadRenderers(installPath)

      // 读取之前保存的渲染器选择
      const savedKey = await window.api.fs.getConfig(`mo_renderer_${props.profile.id}`)
      if (savedKey && iniRendererList.value.some(r => r.value === savedKey)) {
        moRendererKey.value = savedKey
      } else if (iniRendererList.value.length > 0) {
        moRendererKey.value = iniRendererList.value[0].value
      }
      moPrevRendererKey.value = moRendererKey.value

      // 从渲染器配置文件读取窗口模式 + 分辨率
      if (moRendererKey.value) {
        const wm = await window.api.rendererManager.readWindowed(installPath, moRendererKey.value)
        if (wm.borderless) moWindowMode.value = 'borderless'
        else if (wm.windowed) moWindowMode.value = 'windowed'
        else moWindowMode.value = 'fullscreen'

        const res = await window.api.rendererManager.readResolution(installPath, moRendererKey.value)
        if (res) {
          moResolution.value = `${res.width}×${res.height}`
          if (!MO_RESOLUTION_LIST.includes(moResolution.value)) {
            MO_RESOLUTION_LIST.push(moResolution.value)
          }
        }
      }

      // 画质档位：settings/RA2MO.ini [Options] DetailLevel
      try {
        moDetailLevel.value = await window.api.quality.read(props.profile.id)
      } catch { /* 读不到用默认 */ }
      return
    }

    // ===== 绝命时刻：从 Options.ini 加载 =====
    const gameType = getGameType()

    const promises: Promise<any>[] = [
      window.api.options.read(gameType),
      window.api.options.getResolutions(gameType)
    ]

    if (installPath) {
      promises.push(loadRenderers(installPath))
      promises.push(loadGameOptions(installPath))
      promises.push(loadClientConfig(installPath))
    }

    const [optionsResult, resolutionsResult] = await Promise.all(promises)

    if (optionsResult.ok && optionsResult.options) {
      const opts = optionsResult.options
      zhOptions.value = { ...opts }
      resolution.value = (opts.Resolution?.trim().replace(/\s+/g, '×') ?? '1920×1080')
      zhMaxParticleCount.value = Number.parseInt(opts.MaxParticleCount?.trim() ?? '2500', 10) || 2500
      const textureReduction = Number.parseInt(opts.TextureReduction?.trim() ?? '1', 10)
      zhTextureQuality.value = Math.max(0, Math.min(2, 2 - textureReduction))
      const cameraHeight = Number.parseInt(opts.CameraHeight?.trim() ?? '0', 10)
      zhUseCustomCamera.value = cameraHeight > 0
      zhCameraHeight.value = cameraHeight > 0 ? Math.max(310, Math.min(850, cameraHeight)) : 310
      // 窗口模式：Options.ini Windowed（对齐 GenLauncher，启动时传 -win）
      windowMode.value = opts.Windowed?.trim() === 'yes' ? 'windowed' : 'fullscreen'
    }

    if (resolutionsResult.list) {
      resolutionList.value = resolutionsResult.list
    }
  } finally {
    graphicsLoading.value = false
  }
}

// 保存画质设置
async function saveGraphicsSettings(): Promise<void> {
  graphicsSaving.value = true
  try {
    const installPath = props.profile.installPath

    if (isMentalOmega.value) {
      // ===== 心灵终结：写入渲染补丁配置 =====
      const resourcesPath = `${installPath}\\Resources`

      // 切换了渲染器：先清理旧渲染器文件
      if (moPrevRendererKey.value && moPrevRendererKey.value !== moRendererKey.value) {
        await window.api.rendererManager.clean(installPath, resourcesPath, moPrevRendererKey.value)
      }

      // 应用渲染器（复制 DLL + 首次创建配置模板）
      const applyResult = await window.api.rendererManager.apply(installPath, resourcesPath, moRendererKey.value)
      if (!applyResult.ok) {
        graphicsSaving.value = false
        return
      }

      // 写入窗口模式
      const windowed = moWindowMode.value === 'windowed' || moWindowMode.value === 'borderless'
      const borderless = moWindowMode.value === 'borderless'
      await window.api.rendererManager.writeWindowed(installPath, resourcesPath, moRendererKey.value, windowed, borderless, props.profile.id)

      // 写入分辨率
      const [w, h] = moResolution.value.split('×').map(Number)
      await window.api.rendererManager.writeResolution(installPath, resourcesPath, moRendererKey.value, w, h, props.profile.id)

      // 持久化渲染器选择
      await window.api.fs.setConfig(`mo_renderer_${props.profile.id}`, moRendererKey.value)
      moPrevRendererKey.value = moRendererKey.value

      // 画质档位：settings/RA2MO.ini [Options] DetailLevel
      await window.api.quality.write(props.profile.id, moDetailLevel.value)
    } else {
      // ===== 绝命时刻：写入 Options.ini =====
      const gameType = getGameType()
      const options: Record<string, string> = {
        ...zhOptions.value,
        Resolution: ' ' + resolution.value.replace('×', ' '),
        MaxParticleCount: ' ' + Math.max(100, Math.min(5000, Math.round(zhMaxParticleCount.value))),
        TextureReduction: ' ' + (2 - zhTextureQuality.value),
        CameraHeight: ' ' + (zhUseCustomCamera.value ? Math.max(310, Math.min(850, Math.round(zhCameraHeight.value))) : 0),
        Windowed: windowMode.value === 'windowed' || windowMode.value === 'borderless' ? ' yes' : ' no'
      }
      await window.api.options.write(gameType, options)
    }
  } finally {
    graphicsSaving.value = false
  }
}

// 切换到游戏设置 tab 时加载画质设置（已合并进游戏设置）
watch(activeTab, (tab) => {
  if (tab === 'settings') {
    loadGraphicsSettings()
    if (isMentalOmega.value) loadSoundSettings()
  }
  if (tab === 'keyboard') {
    loadKeyboardBindings()
  }
})

// ==================== 音量设置 ====================
// 全局音量：读/写 settings/RA2MO.ini [Sound]，playground 构建时硬链接进游戏目录
const soundValues = ref<Record<string, number>>({})
const soundLoading = ref(false)
const soundSliders = [
  { key: 'SoundVolume', label: '音效' },
  { key: 'ScoreVolume', label: '音乐' },
  { key: 'VoiceVolume', label: '单位语音' }
]

async function loadSoundSettings(): Promise<void> {
  soundLoading.value = true
  try {
    soundValues.value = await window.api.sound.read(props.profile.id)
  } finally {
    soundLoading.value = false
  }
}

async function saveSoundSettings(): Promise<void> {
  // 深克隆（Vue 响应式 Proxy 不能过 IPC structured-clone）
  const plain = JSON.parse(JSON.stringify(soundValues.value))
  const result = await window.api.sound.write(props.profile.id, plain)
  if (!result.ok) {
    toastError(result.error ?? '保存失败')
  }
}

/** 统一保存：画质 + 音量（设置页只留一个保存按钮） */
async function saveAllSettings(): Promise<void> {
  if (!useGtd.value) await saveGraphicsSettings()
  if (isMentalOmega.value) await saveSoundSettings()
  toastSuccess('设置已保存')
}

/** 统一重新加载：画质 + 音量 */
async function reloadAllSettings(): Promise<void> {
  if (!useGtd.value) await loadGraphicsSettings()
  if (isMentalOmega.value) await loadSoundSettings()
}

function zhOptionEnabled(key: string): boolean {
  return zhOptions.value[key]?.trim() === 'yes'
}

function setZhOption(key: string, enabled: boolean): void {
  zhOptions.value = { ...zhOptions.value, [key]: enabled ? ' yes' : ' no' }
}

// ==================== 快捷键设置 ====================
// 游戏只读 KeyboardMD.ini（用户改键覆盖项），定义来自游戏自带的 KeyboardCommands.ini（静态只读）

interface KeyboardBindingItem {
  command: string
  uiName: string
  category: string
  description: string
  defaultKey: string
  currentKey: string
}

const keyboardBindings = ref<KeyboardBindingItem[]>([])
const keyboardLoading = ref(false)
const keyboardSaving = ref(false)
const editingCommand = ref<string | null>(null)
const captureMsg = ref('')

// 加载快捷键
async function loadKeyboardBindings(): Promise<void> {
  keyboardLoading.value = true
  editingCommand.value = null
  captureMsg.value = ''
  try {
    const result = await window.api.keyboard.load(props.profile.installPath, props.profile.id)
    keyboardBindings.value = result
  } finally {
    keyboardLoading.value = false
  }
}

// 保存快捷键（后端会整段同步，改回默认的绑定自动移出配置文件）
async function saveKeyboardBindings(): Promise<void> {
  keyboardSaving.value = true
  cancelKeyEdit()
  try {
    const snapshot = keyboardBindings.value.map((b) => ({
      command: b.command,
      currentKey: b.currentKey,
      defaultKey: b.defaultKey
    }))
    await window.api.keyboard.save(props.profile.installPath, snapshot, props.profile.id)
    toastSuccess('快捷键设置已保存')
  } finally {
    keyboardSaving.value = false
  }
}

// 恢复默认
async function resetKeyboardBindings(): Promise<void> {
  cancelKeyEdit()
  for (const b of keyboardBindings.value) {
    b.currentKey = b.defaultKey
  }
  // 深克隆成普通对象（Vue 响应式 Proxy 不能过 IPC structured-clone）
  const plain = JSON.parse(JSON.stringify(keyboardBindings.value))
  await window.api.keyboard.save(props.profile.installPath, plain, props.profile.id)
  toastSuccess('已恢复默认快捷键')
}

// 开始编辑（进入按键捕获模式）
function startKeyEdit(command: string): void {
  if (editingCommand.value === command) return
  editingCommand.value = command
  captureMsg.value = '按下新的按键...（Esc 取消）'
}

function cancelKeyEdit(): void {
  editingCommand.value = null
  captureMsg.value = ''
}

// MO 里只接受标准键盘输入：鼠标侧键、浏览器导航、多媒体键、F13+、系统键等一律不支持
const BLOCKED_KEYS = new Set([
  // 鼠标侧键 / 浏览器导航
  'GoBack', 'GoForward', 'BrowserBack', 'BrowserForward', 'Unidentified',
  // 多媒体 / 音量 / 启动键（扩展键，MO 不识别）
  'MediaPlayPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'LaunchMail', 'LaunchApp1', 'LaunchApp2',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute',
  // 扩展功能键与系统键
  'ContextMenu', 'PrintScreen', 'NumLock', 'ScrollLock', 'CapsLock', 'Pause',
  'AltGraph', 'Process', 'Dead', 'Clear', 'Hyper', 'Super', 'Fn', 'FnLock',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24'
])

// 把键盘事件转成游戏侧按键名；不支持/扩展/鼠标键返回 null
function eventToKeyName(e: KeyboardEvent): string | null {
  const k = e.key
  if (BLOCKED_KEYS.has(k)) return null
  const map: Record<string, string> = {
    ' ': 'Space',
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Meta: 'Win',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Insert: 'Insert',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }
  if (map[k]) return map[k]
  if (/^F\d{1,2}$/.test(k)) return k
  if (k.length === 1) return k.toUpperCase()
  return null // 其他未知/扩展键不接受
}

// ─── Windows VK 码 ↔ 键名（KeyboardMD.ini / KeyboardCommands.ini 存的是 VK 码）───
const VK_NAMES: Record<number, string> = {
  8: 'Backspace', 9: 'Tab', 12: 'Numpad5', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt',
  20: 'CapsLock', 27: 'Esc', 32: 'Space', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 45: 'Insert', 46: 'Delete', 91: 'Win',
  144: 'NumLock', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
  219: '[', 220: '\\', 221: ']', 222: "'"
}
for (let i = 48; i <= 57; i++) VK_NAMES[i] = String(i - 48) // 0-9
for (let i = 65; i <= 90; i++) VK_NAMES[i] = String.fromCharCode(i) // A-Z
for (let i = 96; i <= 105; i++) VK_NAMES[i] = `Numpad${i - 96}` // 小键盘 0-9
const NPUN = { 106: '*', 107: '+', 109: '-', 110: '.', 111: '/' } as Record<number, string>
for (const [c, n] of Object.entries(NPUN)) VK_NAMES[Number(c)] = `Numpad${n}`
for (let i = 112; i <= 123; i++) VK_NAMES[i] = `F${i - 111}` // F1-F12

const NAME_TO_VK: Record<string, number> = {}
for (const [code, name] of Object.entries(VK_NAMES)) NAME_TO_VK[name.toLowerCase()] = Number(code)

/** VK 码字符串 → 显示键名（非数字/未知则原样） */
function vkToKeyName(raw: string): string {
  const n = parseInt(raw, 10)
  if (!isNaN(n) && VK_NAMES[n]) return VK_NAMES[n]
  return raw
}

/** 键名 → VK 码（用于改键后写回配置文件，游戏只认 VK 码） */
function keyNameToVk(name: string): number | null {
  const n = NAME_TO_VK[name.trim().toLowerCase()]
  return n ?? null
}

// 捕获按键
function onCaptureKeydown(e: KeyboardEvent): void {
  if (!editingCommand.value) return
  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape') {
    cancelKeyEdit()
    return
  }

  const keyName = eventToKeyName(e)
  if (keyName === null) {
    captureMsg.value = '该按键不支持（MO 仅支持标准键盘按键，不含鼠标侧键/扩展键）'
    return
  }
  // 写回配置必须用 VK 码（游戏只认这个），显示时再转回键名
  const vk = keyNameToVk(keyName)
  const newVal = vk != null ? String(vk) : keyName
  const b = keyboardBindings.value.find((x) => x.command === editingCommand.value)
  if (b) {
    // 占用了已有快捷键 → 提示冲突（仍然允许设置），按显示键名比较
    const conflict = keyboardBindings.value.find(
      (x) => x.command !== b.command && vkToKeyName(x.currentKey).toLowerCase() === vkToKeyName(newVal).toLowerCase()
    )
    b.currentKey = newVal
    if (conflict) {
      captureMsg.value = `快捷键已被「${conflict.uiName}」使用，仍将绑定（原绑定会被覆盖）`
    } else {
      captureMsg.value = `已绑定 ${vkToKeyName(newVal)}`
    }
  }
  editingCommand.value = null
}

// 键盘示意图的 code → 游戏侧按键名
const VISUAL_CODE_TO_KEY: Record<string, string> = {
  esc: 'Esc', backspace: 'Backspace', tab: 'Tab', enter: 'Enter',
  caps: 'CapsLock', lshift: 'Shift', rshift: 'Shift',
  lctrl: 'Ctrl', rctrl: 'Ctrl', lalt: 'Alt', ralt: 'Alt',
  lwin: 'Win', rwin: 'Win', menu: 'Menu', space: 'Space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  insert: 'Insert', delete: 'Delete', home: 'Home', end: 'End',
  pgup: 'PageUp', pgdn: 'PageDown'
}

function visualCodeToKeyName(code: string): string {
  if (VISUAL_CODE_TO_KEY[code]) return VISUAL_CODE_TO_KEY[code]
  if (/^f\d{1,2}$/.test(code)) return code.toUpperCase()
  if (code.length === 1) return code.toUpperCase()
  return code
}

// 从键盘示意图点击：定位到绑定该键的命令并开始编辑
function onVisualKeyClick(key: string): void {
  const norm = (s: string) => s.toLowerCase()
  const binding = keyboardBindings.value.find(
    (b) => norm(vkToKeyName(b.currentKey)) === norm(key) || norm(vkToKeyName(b.defaultKey)) === norm(key)
  )
  if (binding) {
    startKeyEdit(binding.command)
  } else if (editingCommand.value) {
    // 正在编辑时点示意图上的键 = 直接设为该键（存 VK 码）
    const b = keyboardBindings.value.find((x) => x.command === editingCommand.value)
    if (b) {
      const name = visualCodeToKeyName(key)
      const vk = keyNameToVk(name)
      b.currentKey = vk != null ? String(vk) : name
    }
    editingCommand.value = null
  }
}

// 供键盘示意图展示的高亮数据（VK 码转成键名，示意图才能识别高亮）
const visualBindings = computed(() =>
  keyboardBindings.value
    .filter((b) => b.currentKey)
    .map((b) => ({ key: vkToKeyName(b.currentKey), label: b.uiName, command: b.command }))
)

const editingBinding = computed(() =>
  keyboardBindings.value.find((b) => b.command === editingCommand.value) ?? null
)

// 重复绑定检测（同一按键被多条命令占用）
const conflictHints = computed(() => {
  const byKey = new Map<string, string[]>()
  for (const b of keyboardBindings.value) {
    if (!b.currentKey) continue
    const key = b.currentKey.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(b.uiName)
  }
  return [...byKey.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([key, names]) => ({ key, names }))
})

// 按类别分组
const bindingGroups = computed(() => {
  const groups = new Map<string, KeyboardBindingItem[]>()
  for (const b of keyboardBindings.value) {
    const cat = b.category || '其他'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(b)
  }
  return [...groups.entries()]
})

// 监听捕获按键
watch(editingCommand, (cmd) => {
  if (cmd) {
    window.addEventListener('keydown', onCaptureKeydown, true)
  } else {
    window.removeEventListener('keydown', onCaptureKeydown, true)
  }
})

// 游戏设置函数
async function selectGtdPath(): Promise<void> {
  const r = await window.api.fs.selectDirectory()
  if (r.path) {
    gtdPath.value = r.path
    useGtd.value = true
    useGenTool.value = false // 选择 GeneralsTD 目录时自动禁用 GenTool
    await saveSettings()
  }
}

async function saveSettings(): Promise<void> {
  const updatedProfile = {
    ...props.profile,
    useGtd: useGtd.value,
    gtdPath: useGtd.value ? gtdPath.value : undefined,
    useGenTool: useGenTool.value,
    actions: {
      launch: {
        type: 'launch' as const,
        exe: useGtd.value
          ? `${gtdPath.value}\\GeneralsTD.exe`
          : `${props.profile.generalsPath}\\Generals.exe`
      }
    }
  }
  emit('updateProfile', updatedProfile)

  // 写入 game.ini 文件（await + 校验，资源目录未设置时能发现失败）
  const result = await window.api.fs.updateGameConfig(props.profile.id, {
    useGtd: useGtd.value,
    gtdPath: useGtd.value ? gtdPath.value : undefined,
    useGenTool: useGenTool.value
  })

  status.value = result.ok ? '设置已保存' : (result.error ?? '设置保存失败')
}

// 地图管理
interface MapItem {
  id: string
  name: string
  size: number
}

const maps = ref<MapItem[]>([])

async function loadMaps(): Promise<void> {
  const result = await window.api.maps.listLibrary(props.profile.id)
  if (result.ok) {
    maps.value = result.maps.map(m => ({
      id: m.id,
      name: m.name,
      size: m.size
    }))
  }
}

// 导入地图（文件夹包 / .map / 压缩包）
async function importMap(): Promise<void> {
  const result = await window.api.maps.import(props.profile.id)
  if (result.ok && result.imported?.length) {
    toastSuccess(`已导入 ${result.imported.length} 个地图`)
    await loadMaps()
  } else if (result.error && result.error !== '已取消') {
    toastError(result.error)
  }
}

// 删除地图包
async function deleteMap(name: string): Promise<void> {
  if (!confirm(`删除地图「${name}」？`)) return
  const result = await window.api.maps.delete(props.profile.id, name)
  if (result.ok) {
    await loadMaps()
  } else {
    toastError(result.error ?? '删除失败')
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

async function openMapsDir(): Promise<void> {
  await window.api.fs.openMapsDir(props.profile.id)
}

// 回放管理
interface ReplayItem {
  id: string
  name: string
  size: number
}

const replays = ref<ReplayItem[]>([])

async function loadReplays(): Promise<void> {
  const result = await window.api.fs.listReplays(props.profile.id)
  if (result.ok) {
    replays.value = result.files.map(f => ({
      id: f.path,
      name: f.name,
      size: f.size
    }))
  }
}

async function openReplaysDir(): Promise<void> {
  await window.api.fs.openReplaysDir(props.profile.id)
}

/**
 * 派发 profile 里声明的动作。能做什么完全由这个 switch 决定，
 * 远程只能挑，不能加 —— 这是不下发可执行代码的关键。
 */
async function run(key: string): Promise<void> {
  const action = props.profile.actions[key]
  if (!action) {
    status.value = `未知动作：${key}`
    return
  }

  switch (action.type) {
    case 'hardlink': {
      const r = await window.api.fs.hardlink(action.src, action.dest, action.overwrite ?? false)
      status.value = r.ok ? '硬链接已创建' : `失败：${r.error}`
      break
    }
    // launch / openUrl / writeConfig / verify 的 main 进程实现还没写
    default:
      status.value = `动作 ${action.type} 尚未实现`
  }
}
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <!-- 导航栏 -->
    <nav class="flex gap-1 border-b border-line px-6">
        <button
        v-for="tab in tabs"
        :key="tab.id"
        class="px-4 py-2 text-[13px] transition-colors"
        :class="{
          'border-b-2 border-accent text-fg': activeTab === tab.id,
          'text-fg-dim hover:text-fg': activeTab !== tab.id && !tab.disabled,
          'cursor-not-allowed text-fg-dim/40': tab.disabled
        }"
        :disabled="tab.disabled"
        :title="tab.disabled ? (tab.tip || '此功能已禁用') : ''"
        @click="!tab.disabled && (activeTab = tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <!-- 不同分区提示 -->
    <div v-if="!samePartition" class="bg-yellow-900/30 px-6 py-2 text-[12px] text-yellow-500">
      数据目录与游戏目录不在同一分区，硬链接功能不可用。MOD管理、播放集管理、地图管理、回放管理已禁用。
    </div>

    <!-- 开始游戏内容 -->
    <div v-if="activeTab === 'start'" class="flex flex-1 flex-col overflow-hidden">
      <!-- 顶部：标题 + 播放集选择 -->
      <div class="border-b border-line px-6 py-4">
        <div class="flex items-center gap-6">
          <h1 class="text-[19px] font-light">{{ profile.name }}</h1>
          <div class="relative flex-1 max-w-[300px]" ref="dropdownRef">
            <button
              class="flex w-full items-center justify-between border border-line bg-panel px-3 py-2 text-[13px] hover:border-accent"
              @click="showDropdown = !showDropdown"
            >
              <span>{{ selectedModSet?.name ?? '选择播放集' }}</span>
              <span class="text-fg-dim">{{ showDropdown ? '▲' : '▼' }}</span>
            </button>
            <div
              v-if="showDropdown"
              class="absolute left-0 right-0 z-10 mt-1 border border-line bg-panel shadow-lg"
            >
              <div
                v-for="mod in modSets"
                :key="mod.id"
                class="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] hover:bg-panel-alt"
                :class="selectedModSetId === mod.id ? 'bg-panel-alt' : ''"
                @click="selectModSet(mod.id)"
              >
                <span
                  class="inline-flex h-4 w-4 items-center justify-center border border-line"
                  :class="selectedModSetId === mod.id ? 'bg-accent border-accent' : ''"
                >
                  <span v-if="selectedModSetId === mod.id" class="text-[10px] text-white">✓</span>
                </span>
                <span>{{ mod.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 中间：播放集内容 + 开始按钮 -->
      <div class="flex flex-1 overflow-hidden">
        <!-- 左侧：当前播放集内容 -->
        <div class="flex flex-1 flex-col border-r border-line overflow-y-auto px-6 py-4">
          <p class="mb-2 text-[12px] text-fg-dim">当前播放集内容</p>
          <div
            v-for="(mod, i) in selectedModSet?.packages ?? []"
            :key="mod.id"
            class="flex items-center gap-2 border border-line bg-panel px-3 py-2 text-[13px] not-last:mb-1"
          >
            <span class="text-fg-dim">{{ i + 1 }}.</span>
            <span>{{ mod.name }}</span>
          </div>
          <p v-if="!selectedModSet?.packages.length" class="text-[13px] text-fg-dim">
            此播放集无包
          </p>
        </div>

        <!-- 右侧：开始游戏（居中突出） -->
        <div class="flex flex-1 flex-col items-center justify-center p-6">
          <div class="text-center">
            <p class="mb-6 text-[13px] text-fg-dim">
              当前播放集：{{ selectedModSet?.name ?? '未选择' }}
              <span v-if="selectedModSet?.packages.length" class="text-fg-dim">
                （{{ selectedModSet.packages.length }} 个包）
              </span>
            </p>
            <button
              class="bg-accent px-12 py-4 text-[17px] font-medium text-white hover:bg-accent-hi active:scale-[0.98] transition-transform disabled:opacity-50"
              :disabled="launching"
              @click="launch"
            >
              {{ launching ? '准备中...' : '开始游戏' }}
            </button>
            <p v-if="status" class="mt-4 text-[13px] text-fg-dim">{{ status }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 播放集管理 -->
    <div v-else-if="activeTab === 'modsets'" class="flex flex-1 overflow-hidden">
      <!-- 播放集列表 -->
      <div v-if="!editingModSet" class="flex flex-1 flex-col overflow-y-auto px-6 py-5">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-[15px] font-medium text-fg">播放集列表</h2>
          <div class="flex gap-2">
            <!-- ZH 非 GeneralsTD：启动当前选中的播放集 -->
            <button
              v-if="!isMentalOmega && !useGtd"
              class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi disabled:opacity-50"
              :disabled="launching || !selectedModSet"
              @click="launchSelectedPlaySet"
            >
              {{ launching ? '启动中...' : `启动游戏（${selectedModSet?.name ?? ''}）` }}
            </button>
            <button
              class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
              @click="openPlaygroundFolder"
            >
              打开 playground 文件夹
            </button>
            <button
              v-if="!isMentalOmega"
              class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
              @click="importPlaysetCommandFromClipboard"
            >
              粘贴安装命令
            </button>
            <button
              v-if="isMentalOmega && !showCreateForm"
              class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi"
              @click="showCreateForm = true"
            >
              新建播放集
            </button>
          </div>
        </div>

        <!-- 新建表单 -->
        <div v-if="showCreateForm" class="mb-4 rounded border border-line bg-panel p-4">
          <h3 class="mb-3 font-medium text-fg">新建播放集</h3>
          <label class="mb-1 block text-[12px] text-fg-dim">名称</label>
          <input
            v-model="newModSet.name"
            placeholder="输入播放集名称"
            class="mb-3 w-full max-w-[400px] border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
          />
          <label class="mb-1 block text-[12px] text-fg-dim">描述</label>
          <textarea
            v-model="newModSet.description"
            placeholder="输入播放集描述"
            rows="3"
            class="mb-3 w-full max-w-[400px] resize-none border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
          ></textarea>
          <div class="flex gap-2">
            <button
              class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi disabled:opacity-40"
              :disabled="!newModSet.name"
              @click="createModSet"
            >
              创建
            </button>
            <button
              class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
              @click="showCreateForm = false"
            >
              取消
            </button>
          </div>
        </div>

        <!-- 播放集卡片列表 -->
        <div class="space-y-3">
          <div
            v-for="mod in modSets"
            :key="mod.id"
            class="rounded border border-line bg-panel p-4"
          >
          <div class="mb-2 flex items-start justify-between">
            <div>
              <h3 class="font-medium text-fg">{{ mod.name }}</h3>
              <p class="mt-0.5 text-[12px] text-fg-dim">{{ mod.description }}</p>
              <p v-if="mod.packages.length" class="mt-1 text-[12px] text-fg-dim">
                包含 {{ mod.packages.length }} 个包
              </p>
            </div>
            <span
              v-if="selectedModSetId === mod.id"
              class="text-[12px] text-accent"
            >
              当前选中
            </span>
          </div>
          <div class="flex gap-2">
            <button
              v-if="selectedModSetId !== mod.id"
              class="border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-fg"
              @click="selectModSet(mod.id)"
            >
              启用
            </button>
            <button
              class="border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-fg"
              @click="startEdit(mod)"
            >
              修改
            </button>
            <button
              class="border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-fg"
              @click="copyModSet(mod)"
            >
              复制
            </button>
            <button
              v-if="!isMentalOmega && !mod.packages.some(pkg => localPackageNames.has(pkg.name) && pkg.name !== 'ZeroHour' && !installedMods.find(item => item.name === pkg.name)?.source)"
              class="border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-fg"
              @click="exportPlaysetCommand(mod)"
            >
              复制安装命令
            </button>
            <button
              class="border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-red-400"
              @click="confirmDeleteModSet(mod)"
            >
              删除
            </button>
          </div>
          </div>
        </div>
      </div>

      <!-- 播放集编辑界面 -->
      <div v-else class="flex flex-1 flex-col overflow-hidden">
        <!-- 顶部栏 -->
        <div class="flex items-center justify-between border-b border-line px-6 py-3">
          <div class="flex items-center gap-3">
            <button
              class="text-[13px] text-fg-dim hover:text-fg"
              @click="cancelEdit"
            >
              ← 返回
            </button>
            <span class="text-fg">/</span>
            <span class="text-[13px] font-medium text-fg">{{ editingModSet.name }}</span>
          </div>
          <button
            class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi"
            @click="saveEdit"
          >
            保存
          </button>
        </div>

        <!-- 名称/描述编辑 -->
        <div class="flex gap-4 border-b border-line px-6 py-3">
          <label class="flex items-center gap-2 text-[12px] text-fg-dim">
            名称
            <input
              v-model="editingModSet.name"
              class="w-48 border border-line bg-bg px-2 py-1 text-[13px] text-fg outline-none focus:border-accent"
            />
          </label>
          <label class="flex flex-1 items-center gap-2 text-[12px] text-fg-dim">
            描述
            <input
              v-model="editingModSet.description"
              class="flex-1 border border-line bg-bg px-2 py-1 text-[13px] text-fg outline-none focus:border-accent"
            />
          </label>
        </div>

        <!-- ZH：两栏包编辑（MOD 作为整体包，不拆分） -->
        <div v-if="!isMentalOmega" class="flex flex-1 overflow-hidden">
          <!-- 左侧：播放集中的包（可拖拽排序/移除） -->
          <div class="flex flex-1 flex-col border-r border-line">
            <div class="border-b border-line px-4 py-2 text-[12px] text-fg-dim">
              播放集内容（拖拽排序，拖到右侧删除）
            </div>
            <div
              class="flex-1 overflow-y-auto p-4"
              :class="dragOverTarget === 'left' && dragOverIndex === (editingModSet?.packages.length ?? 0) ? 'bg-accent/10' : ''"
              @dragover.prevent
              @dragenter.prevent="onDragOver('left', editingModSet?.packages.length ?? 0)"
              @dragleave="onDragLeave()"
              @drop="onDrop('left', editingModSet?.packages.length ?? 0)"
            >
              <div
                v-for="(mod, i) in editingModSet?.packages"
                :key="mod.id"
                class="mb-2 flex cursor-grab items-center gap-3 border bg-panel px-3 py-2 text-[13px] active:cursor-grabbing transition-colors"
                :class="{
                  'border-line': dragOverTarget !== 'left' || dragOverIndex !== i,
                  'border-accent bg-accent/10': dragOverTarget === 'left' && dragOverIndex === i,
                  'opacity-50': dragSource === 'left' && dragIndex === i
                }"
                draggable="true"
                @dragstart="onDragStart('left', i)"
                @dragend="onDragEnd"
                @dragover.prevent
                @dragenter.prevent="onDragOver('left', i)"
                @dragleave="onDragLeave()"
                @drop.stop="onDrop('left', i)"
              >
                <span class="text-fg-dim">{{ i + 1 }}.</span>
                <span class="flex-1">{{ mod.name }}</span>
                <span
                  class="cursor-pointer text-fg-dim hover:text-red-400"
                  @click="removeMod(i)"
                >
                  ✕
                </span>
              </div>
              <p v-if="!editingModSet?.packages.length" class="text-center text-[13px] text-fg-dim">
                拖拽右侧包到此处添加
              </p>
            </div>
          </div>

          <!-- 右侧：已安装的包列表 -->
          <div class="flex flex-1 flex-col">
            <div class="border-b border-line px-4 py-2 text-[12px] text-fg-dim">
              已安装的包（拖到左侧添加）
            </div>
            <div
              class="flex-1 overflow-y-auto p-4"
              :class="dragOverTarget === 'right' ? 'bg-red-500/10' : ''"
              @dragover.prevent
              @dragenter.prevent="onDragOver('right', 0)"
              @dragleave="onDragLeave()"
              @drop="onDrop('right', 0)"
            >
              <div
                v-for="(mod, i) in availableMods"
                :key="mod.id"
                class="mb-2 flex cursor-grab items-center border border-line bg-panel px-3 py-2 text-[13px] active:cursor-grabbing hover:bg-panel-alt transition-colors"
                :class="{
                  'opacity-50': dragSource === 'right' && dragIndex === i,
                  'bg-red-500/10 border-red-500/30': dragOverTarget === 'right' && dragOverIndex === i
                }"
                draggable="true"
                @dragstart="onDragStart('right', i)"
                @dragend="onDragEnd"
                @dragover.prevent
                @dragenter.prevent="onDragOver('right', i)"
                @dragleave="onDragLeave()"
                @click="addMod(mod)"
              >
                <span>{{ mod.name }}</span>
              </div>
              <p v-if="!availableMods.length" class="text-center text-[13px] text-fg-dim">
                所有包已添加
              </p>
            </div>
          </div>
        </div>

        <!-- MO 两栏包编辑布局 -->
        <div v-else class="flex flex-1 overflow-hidden">
          <!-- 左侧：播放集中的 MOD（可拖拽排序） -->
          <div class="flex flex-1 flex-col border-r border-line">
            <div class="border-b border-line px-4 py-2 text-[12px] text-fg-dim">
              播放集内容（拖拽排序，拖到右侧删除）
            </div>
            <div
              class="flex-1 overflow-y-auto p-4"
              :class="dragOverTarget === 'left' && dragOverIndex === (editingModSet?.packages.length ?? 0) ? 'bg-accent/10' : ''"
              @dragover.prevent
              @dragenter.prevent="onDragOver('left', editingModSet?.packages.length ?? 0)"
              @dragleave="onDragLeave()"
              @drop="onDrop('left', editingModSet?.packages.length ?? 0)"
            >
              <div
                v-for="(mod, i) in editingModSet?.packages"
                :key="mod.id"
                class="mb-2 flex cursor-grab items-center gap-3 border bg-panel px-3 py-2 text-[13px] active:cursor-grabbing transition-colors"
                :class="{
                  'border-line': dragOverTarget !== 'left' || dragOverIndex !== i,
                  'border-accent bg-accent/10': dragOverTarget === 'left' && dragOverIndex === i,
                  'opacity-50': dragSource === 'left' && dragIndex === i
                }"
                draggable="true"
                @dragstart="onDragStart('left', i)"
                @dragend="onDragEnd"
                @dragover.prevent
                @dragenter.prevent="onDragOver('left', i)"
                @dragleave="onDragLeave()"
                @drop.stop="onDrop('left', i)"
              >
                <span class="text-fg-dim">{{ i + 1 }}.</span>
                <span class="flex-1">{{ mod.name }}</span>
                <span
                  class="cursor-pointer text-fg-dim hover:text-red-400"
                  @click="removeMod(i)"
                >
                  ✕
                </span>
              </div>
              <p
                v-if="!editingModSet?.packages.length"
                class="text-center text-[13px] text-fg-dim"
              >
                拖拽右侧包到此处添加
              </p>
            </div>
          </div>

          <!-- 右侧：已安装的包列表 -->
          <div class="flex flex-1 flex-col">
            <div class="border-b border-line px-4 py-2 text-[12px] text-fg-dim">
              已安装的包（拖到左侧添加）
            </div>
            <div
              class="flex-1 overflow-y-auto p-4"
              :class="dragOverTarget === 'right' ? 'bg-red-500/10' : ''"
              @dragover.prevent
              @dragenter.prevent="onDragOver('right', 0)"
              @dragleave="onDragLeave()"
              @drop="onDrop('right', 0)"
            >
              <div
                v-for="(mod, i) in availableMods"
                :key="mod.id"
                class="mb-2 flex cursor-grab items-center border border-line bg-panel px-3 py-2 text-[13px] active:cursor-grabbing hover:bg-panel-alt transition-colors"
                :class="{
                  'opacity-50': dragSource === 'right' && dragIndex === i,
                  'bg-red-500/10 border-red-500/30': dragOverTarget === 'right' && dragOverIndex === i
                }"
                draggable="true"
                @dragstart="onDragStart('right', i)"
                @dragend="onDragEnd"
                @dragover.prevent
                @dragenter.prevent="onDragOver('right', i)"
                @dragleave="onDragLeave()"
                @click="addMod(mod)"
              >
                <span>{{ mod.name }}</span>
              </div>
              <p
                v-if="!availableMods.length"
                class="text-center text-[13px] text-fg-dim"
              >
                所有包已添加
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- MOD 管理 -->
    <div v-else-if="activeTab === 'mods'" class="flex flex-1 overflow-hidden">
      <!-- 心灵终结：本地包管理（导入/删除，按播放集顺序覆盖） -->
      <div v-if="isMentalOmega" class="flex flex-1 flex-col px-6 py-5">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-[15px] font-medium text-fg">包管理</h2>
          <div class="flex gap-2">
            <button
              class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
              @click="loadInstalledMods"
            >
              刷新
            </button>
            <button
              class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
              @click="openPackagesFolder"
            >
              打开包文件夹
            </button>
            <button
              class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
              @click="importFolder"
            >
              导入文件夹
            </button>
            <button
              class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi"
              @click="importArchive"
            >
              导入压缩包
            </button>
          </div>
        </div>
        <p class="mb-3 text-[12px] text-fg-dim">
          支持文件夹或 zip/7z/rar 压缩包，也可直接拖入。包按播放集顺序覆盖到游戏工作区，后覆盖胜出。
        </p>
        <div
          class="flex-1 overflow-y-auto rounded border border-dashed p-3 transition-colors"
          :class="dropActive ? 'border-accent bg-accent/5' : 'border-line'"
          @dragover.prevent="dropActive = true"
          @dragleave.prevent="dropActive = false"
          @drop="onDropImport"
        >
          <div
            v-for="pkg in installedMods"
            :key="pkg.name"
            class="mb-2 flex items-center justify-between rounded border border-line bg-panel px-4 py-3"
          >
            <div>
              <h3 class="text-[13px] font-medium text-fg">{{ pkg.name }}</h3>
            </div>
            <button
              class="border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-red-400"
              @click="deletePackage(pkg.name)"
            >
              删除
            </button>
          </div>
          <p v-if="!installedMods.length" class="mt-8 text-center text-[13px] text-fg-dim">
            暂无包，点击导入或直接拖入文件夹/压缩包
          </p>
        </div>
      </div>

      <!-- 绝命时刻：MOD 管理 -->
      <template v-else>
      <div v-if="zhPackageView === 'packages'" class="flex flex-1 flex-col overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div class="flex items-center gap-1">
              <button class="rounded px-2 py-1 text-[12px] text-fg-dim hover:text-fg" @click="zhPackageView = 'mods'">可用 MOD</button>
              <button class="rounded bg-accent px-2 py-1 text-[12px] text-white">本地 package</button>
            </div>
            <p class="mt-1 text-[11px] text-fg-dim">仅浏览 packages 目录；不会自动创建 MOD 播放集</p>
          </div>
          <div class="flex gap-3">
            <button class="text-[12px] text-fg-dim hover:text-fg" @click="importFolder">添加文件夹</button>
            <button class="text-[12px] text-fg-dim hover:text-fg" @click="importArchive">添加压缩包</button>
            <button class="text-[12px] text-fg-dim hover:text-fg" @click="openPackagesFolder">打开目录</button>
            <button class="text-[12px] text-fg-dim hover:text-fg" @click="loadInstalledMods">刷新</button>
          </div>
        </div>
        <div class="border-b border-line px-4 py-3">
          <div class="mb-2 text-[12px] text-fg-dim">解析 ModDB 命令并下载 package</div>
          <div class="flex gap-2">
            <input v-model="moddbPackageCommand" class="min-w-0 flex-1 border border-line bg-bg px-3 py-1.5 text-[12px] outline-none focus:border-accent" placeholder="https://www.moddb.com/mods/contra/addons/bossaddon1" @keyup.enter="installModdbPackageCommand" />
            <button class="shrink-0 bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent-hi disabled:opacity-50" :disabled="installingModdbPackage" @click="installModdbPackageCommand">{{ installingModdbPackage ? '下载中...' : '解析下载' }}</button>
          </div>
          <div v-if="moddbDownloads.length" class="mt-3 space-y-1">
            <div v-for="item in moddbDownloads" :key="item.slug" class="rounded border border-line bg-panel px-3 py-2 text-[12px]">
              <div class="flex justify-between"><span>{{ item.slug }}</span><span class="text-fg-dim">{{ item.status === 'done' ? '已完成' : `${item.progress}%` }}</span></div>
              <div class="mt-1 h-1 bg-bg"><div class="h-1 bg-accent transition-all" :style="{ width: `${item.progress}%` }" /></div>
            </div>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-4">
          <div v-if="!installedModPackageNames.length" class="mt-8 text-center text-[13px] text-fg-dim">
            暂无本地 package，可导入文件夹或压缩包
          </div>
          <div v-else class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div v-for="pkg in installedMods.filter(p => installedModPackageNames.includes(p.name))" :key="pkg.name" class="flex items-center justify-between rounded border border-line px-3 py-3">
              <div>
                <div class="text-[13px] text-fg">{{ pkg.name }}</div>
                <div class="mt-1 flex items-center gap-2 text-[11px] text-fg-dim">
                  <span>{{ pkg.source?.provider === 'moddb' ? 'ModDB package · 可重新下载' : '本地 package' }}</span>
                  <a v-if="pkg.source?.provider === 'moddb'" :href="pkg.source.page ?? `https://www.moddb.com/mods/${pkg.source.mod}/addons/${pkg.source.slug}`" target="_blank" rel="noreferrer" class="text-blue-400 hover:text-blue-300 hover:underline">打开 ModDB</a>
                </div>
              </div>
              <button class="text-[12px] text-red-400 hover:text-red-300" @click="deletePackage(pkg.name)">删除</button>
            </div>
          </div>
        </div>
      </div>
      <template v-else>
      <!-- 左侧：仓库 MOD 列表 -->
      <div class="flex w-[320px] flex-col border-r border-line">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <div class="flex items-center gap-1">
            <button class="rounded px-2 py-1 text-[12px]" :class="zhPackageView === 'mods' ? 'bg-accent text-white' : 'text-fg-dim hover:text-fg'" @click="zhPackageView = 'mods'">可用 MOD</button>
            <button class="rounded px-2 py-1 text-[12px] text-fg-dim hover:text-fg" @click="zhPackageView = 'packages'">本地 package</button>
          </div>
          <button
            class="text-[12px] text-fg-dim hover:text-fg"
            @click="loadRepoMods"
          >
            刷新
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <!-- 加载中 -->
          <div v-if="repoLoading" class="p-4 text-center text-[13px] text-fg-dim">
            加载中...
          </div>

          <!-- 错误 -->
          <div v-else-if="repoError" class="p-4 text-center text-[13px] text-red-400">
            {{ repoError }}
          </div>

          <!-- MOD 列表 -->
          <div v-else>
            <div
              v-for="mod in repoMods"
              :key="mod.ModName"
              class="relative cursor-pointer border-b border-line px-4 py-3"
              :class="{
                'bg-panel-alt': selectedRepoMod?.ModName === mod.ModName,
                'hover:bg-panel-alt': selectedRepoMod?.ModName !== mod.ModName
              }"
              @click="selectRepoMod(mod)"
            >
              <!-- 下载进度条背景 -->
              <div
                v-if="downloadProgress.get(mod.ModName)"
                class="absolute inset-0 transition-all duration-300"
                :class="{
                  'bg-accent/20': downloadProgress.get(mod.ModName)?.status === 'downloading',
                  'bg-yellow-500/20': downloadProgress.get(mod.ModName)?.status === 'paused',
                  'bg-green-500/20': downloadProgress.get(mod.ModName)?.status === 'done'
                }"
                :style="{
                  width: (downloadProgress.get(mod.ModName)?.progress ?? 0) + '%'
                }"
              />
              <!-- 内容 -->
              <div class="relative">
                <div class="flex items-center justify-between">
                  <span class="text-[13px] text-fg">{{ mod.ModName }}</span>
                  <!-- 已安装标记 -->
                  <span
                    v-if="installedModNames.includes(mod.ModName)"
                    class="text-[10px] text-green-500"
                  >
                    已安装
                  </span>
                  <!-- 下载状态 -->
                  <span
                    v-if="downloadProgress.get(mod.ModName)?.status === 'downloading'"
                    class="text-[11px] text-accent"
                  >
                    {{ downloadProgress.get(mod.ModName)?.progress }}%
                  </span>
                  <span
                    v-else-if="downloadProgress.get(mod.ModName)?.status === 'paused'"
                    class="text-[11px] text-yellow-500"
                  >
                    已暂停 {{ downloadProgress.get(mod.ModName)?.progress }}%
                  </span>
                </div>
                <div class="mt-1 text-[11px] text-fg-dim">
                  {{ mod.ModPatches.length }} 补丁 · {{ mod.ModAddons.length }} 附属
                </div>
              </div>
            </div>

            <!-- 子 mod 下载项（独立列表项） -->
            <template v-for="mod in repoMods" :key="'sub-' + mod.ModName">
              <div
                v-for="item in subDownloadsByMod.get(mod.ModName) ?? []"
                :key="item.name"
                class="relative cursor-pointer border-b border-line px-4 py-2 pl-8"
                @click="selectRepoMod(mod)"
              >
                <div
                  class="absolute inset-0 transition-all duration-300"
                  :class="{
                    'bg-accent/20': item.status === 'downloading',
                    'bg-yellow-500/20': item.status === 'paused',
                    'bg-green-500/20': item.status === 'done'
                  }"
                  :style="{ width: (item.progress ?? 0) + '%' }"
                />
                <div class="relative flex items-center justify-between">
                  <span class="text-[12px] text-fg-dim">{{ item.label }}</span>
                  <span
                    v-if="item.status === 'downloading'"
                    class="text-[10px] text-accent"
                  >
                    {{ item.progress }}%
                  </span>
                  <span
                    v-else-if="item.status === 'paused'"
                    class="text-[10px] text-yellow-500"
                  >
                    已暂停 {{ item.progress }}%
                  </span>
                  <span
                    v-else-if="item.status === 'done'"
                    class="text-[10px] text-green-500"
                  >
                    ✓
                  </span>
                </div>
              </div>
            </template>

            <p v-if="!repoMods.length" class="p-4 text-center text-[13px] text-fg-dim">
              点击"刷新"获取 MOD 列表
            </p>
          </div>
        </div>
      </div>
      </template>

      <template v-if="zhPackageView === 'mods'">
      <!-- 右侧：MOD 详情 + 下载 -->
      <div class="flex flex-1 flex-col overflow-hidden">
        <div v-if="selectedRepoMod" class="flex flex-1 flex-col overflow-hidden p-6">
          <!-- MOD 信息（可滚动区域） -->
          <div class="flex-1 overflow-y-auto">
            <!-- 封面图 -->
            <div v-if="selectedManifest?.UIImageSourceLink" class="mb-3">
              <img
                :src="selectedManifest.UIImageSourceLink"
                class="max-h-[180px] w-full object-contain"
              />
            </div>
            <!-- 名称、版本、链接 -->
            <div class="mb-4">
              <h2 class="text-[15px] font-medium text-fg">{{ selectedRepoMod.ModName }}</h2>
              <p v-if="selectedManifest" class="mt-1 text-[12px] text-fg-dim">
                版本: {{ selectedManifest.Version }}
              </p>
              <p v-if="manifestLoading" class="mt-1 text-[12px] text-fg-dim">加载版本信息...</p>
              <div class="mt-2 flex gap-3">
                <a
                  v-if="selectedManifest?.ModDBLink"
                  :href="selectedManifest.ModDBLink"
                  target="_blank"
                  class="text-[11px] text-accent hover:underline"
                >
                  ModDB
                </a>
                <a
                  v-if="selectedManifest?.DiscordLink"
                  :href="selectedManifest.DiscordLink"
                  target="_blank"
                  class="text-[11px] text-accent hover:underline"
                >
                  Discord
                </a>
              </div>
            </div>

            <!-- Patches 列表 -->
            <div v-if="selectedRepoMod.ModPatches.length" class="mb-4">
              <h4 class="mb-2 text-[12px] font-medium text-fg-dim">补丁 (Patches)</h4>
              <div class="space-y-1">
                <label
                  v-for="(_, i) in selectedRepoMod.ModPatches"
                  :key="i"
                  class="relative flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-[12px]"
                  :class="selectedPatches.has(i) ? 'border-accent bg-accent/10' : 'border-line hover:bg-panel-alt'"
                >
                  <input
                    type="checkbox"
                    :checked="selectedPatches.has(i)"
                    class="h-3.5 w-3.5 accent-accent"
                    @change="togglePatch(i)"
                  />
                  <span :class="selectedPatches.has(i) ? 'text-fg' : 'text-fg-dim'">
                    {{ patchManifests.get(i)?.name ?? `补丁 ${i + 1}` }}
                  </span>
                  <span v-if="patchManifests.get(i)?.version" class="text-fg-dim">
                    {{ patchManifests.get(i)!.version }}
                  </span>
                </label>
              </div>
            </div>

            <!-- Addons 列表 -->
            <div v-if="selectedRepoMod.ModAddons.length" class="mb-4">
              <h4 class="mb-2 text-[12px] font-medium text-fg-dim">附属修改 (Addons)</h4>
              <div class="space-y-1">
                <label
                  v-for="(_, i) in selectedRepoMod.ModAddons"
                  :key="i"
                  class="relative flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-[12px]"
                  :class="selectedAddons.has(i) ? 'border-accent bg-accent/10' : 'border-line hover:bg-panel-alt'"
                >
                  <input
                    type="checkbox"
                    :checked="selectedAddons.has(i)"
                    class="h-3.5 w-3.5 accent-accent"
                    @change="toggleAddon(i)"
                  />
                  <span :class="selectedAddons.has(i) ? 'text-fg' : 'text-fg-dim'">
                    {{ addonManifests.get(i)?.name ?? `Addon ${i + 1}` }}
                  </span>
                  <span v-if="addonManifests.get(i)?.version" class="text-fg-dim">
                    {{ addonManifests.get(i)!.version }}
                  </span>
                </label>
              </div>
            </div>
          </div>

          <!-- 操作按钮（固定底部，不参与滚动） -->
          <div class="shrink-0 border-t border-line pt-4">
            <!-- 下载中：显示暂停/恢复/取消按钮 -->
            <div v-if="downloadProgress.get(selectedRepoMod.ModName)?.status === 'downloading'" class="flex gap-2">
              <button
                class="flex-1 bg-yellow-600 py-2 text-[13px] font-medium text-white hover:bg-yellow-700"
                @click="pauseDownload(selectedRepoMod.ModName)"
              >
                暂停
              </button>
              <button
                class="flex-1 border border-red-500 py-2 text-[13px] text-red-500 hover:bg-red-500/10"
                @click="cancelDownload(selectedRepoMod.ModName)"
              >
                取消
              </button>
            </div>
            <!-- 暂停中：显示恢复/取消按钮 -->
            <div v-else-if="downloadProgress.get(selectedRepoMod.ModName)?.status === 'paused'" class="flex gap-2">
              <button
                class="flex-1 bg-accent py-2 text-[13px] font-medium text-white hover:bg-accent-hi"
                @click="resumeDownload(selectedRepoMod.ModName)"
              >
                恢复下载
              </button>
              <button
                class="flex-1 border border-red-500 py-2 text-[13px] text-red-500 hover:bg-red-500/10"
                @click="cancelDownload(selectedRepoMod.ModName)"
              >
                取消
              </button>
            </div>
            <!-- 未安装：显示下载按钮 -->
            <div v-else-if="!isModInstalled" class="flex gap-2">
              <button
                class="flex-1 bg-accent py-2 text-[13px] font-medium text-white hover:bg-accent-hi disabled:opacity-50"
                @click="downloadMod(selectedRepoMod)"
              >
                下载
              </button>
            </div>

            <!-- 已安装：显示删除和修改按钮 -->
            <div v-else class="flex gap-2">
              <button
                class="flex-1 border border-red-500 py-2 text-[13px] text-red-500 hover:bg-red-500/10"
                @click="deleteMod(selectedRepoMod.ModName)"
              >
                删除
              </button>
              <button
                class="flex-1 bg-accent py-2 text-[13px] font-medium text-white hover:bg-accent-hi disabled:opacity-50"
                :disabled="isDownloading"
                @click="modifyMod(selectedRepoMod)"
              >
                修改
              </button>
            </div>
          </div>
        </div>

        <!-- 未选中 MOD -->
        <div v-else class="flex flex-1 items-center justify-center">
          <p class="text-[13px] text-fg-dim">← 从左侧选择一个 MOD 查看详情</p>
        </div>
      </div>

      <!-- 底部：已安装 MOD + 导入按钮 -->
      <div
        class="absolute bottom-0 left-0 right-0 border-t border-line bg-panel transition-colors"
        :class="dropActive ? 'bg-accent/10 border-accent' : ''"
        @dragover.prevent="dropActive = true"
        @dragleave.prevent="dropActive = false"
        @drop="onDropImport"
      >
        <div class="flex items-center justify-between px-4 py-2">
          <span class="text-[12px] text-fg-dim">已安装: {{ installedMods.length }} 个 MOD</span>
          <div class="flex gap-2">
            <button
              class="text-[12px] text-fg-dim hover:text-fg"
              @click="importFolder"
            >
              导入文件夹
            </button>
            <button
              class="text-[12px] text-fg-dim hover:text-fg"
              @click="importArchive"
            >
              导入压缩包
            </button>
            <button
              class="text-[12px] text-fg-dim hover:text-fg"
              @click="loadInstalledMods"
            >
              刷新
            </button>
          </div>
        </div>
      </div>
      </template>
      </template>
    </div>

    <!-- 地图管理 -->
    <div v-else-if="activeTab === 'maps'" class="flex flex-1 flex-col overflow-hidden px-6 py-5">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-[15px] font-medium text-fg">地图管理</h2>
        <div class="flex gap-2">
          <button
            class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
            @click="loadMaps"
          >
            刷新
          </button>
          <button
            class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
            @click="openMapsDir"
          >
            打开目录
          </button>
          <button
            class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi"
            @click="importMap"
          >
            导入地图
          </button>
        </div>
      </div>
      <p class="mb-3 text-[12px] text-fg-dim">
        下载/导入的地图存为文件夹包（maps/图名/），游戏通过 MPMapsPath 直接读取；可选配置（模式/预设）格式待定。
      </p>

      <div class="flex-1 overflow-y-auto">
        <div
          v-for="map in maps"
          :key="map.id"
          class="mb-2 flex items-center justify-between rounded border border-line bg-panel px-4 py-3"
        >
          <div>
            <h3 class="text-[13px] font-medium text-fg">{{ map.name }}</h3>
            <p class="mt-0.5 text-[12px] text-fg-dim">{{ formatSize(map.size) }}</p>
          </div>
          <button
            class="border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-red-400"
            @click="deleteMap(map.name)"
          >
            删除
          </button>
        </div>

        <p v-if="!maps.length" class="mt-8 text-center text-[13px] text-fg-dim">
          暂无地图，点击"导入地图"选择地图文件夹/.map/压缩包
        </p>
      </div>
    </div>

    <!-- 回放管理 -->
    <div v-else-if="activeTab === 'replays'" class="flex flex-1 flex-col overflow-hidden px-6 py-5">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-[15px] font-medium text-fg">回放管理</h2>
        <div class="flex gap-2">
          <button
            class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
            @click="loadReplays"
          >
            刷新
          </button>
          <button
            class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi"
            @click="openReplaysDir"
          >
            打开目录
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto">
        <div
          v-for="replay in replays"
          :key="replay.id"
          class="mb-2 flex items-center justify-between rounded border border-line bg-panel px-4 py-3"
        >
          <div>
            <h3 class="text-[13px] font-medium text-fg">{{ replay.name }}</h3>
            <p class="mt-0.5 text-[12px] text-fg-dim">{{ formatSize(replay.size) }}</p>
          </div>
        </div>

        <p v-if="!replays.length" class="mt-8 text-center text-[13px] text-fg-dim">
          暂无回放，点击"打开目录"查看回放文件夹
        </p>
      </div>
    </div>

    <!-- 战役模式 -->
    <div v-else-if="activeTab === 'campaign'" class="flex flex-1 flex-col overflow-hidden w-full min-h-0">
      <CampaignSelector
        v-if="isMentalOmega"
        :game-dir="profile.installPath"
        :exe="profile.id === 'mental-omega' ? 'Syringe.exe' : profile.useGtd && profile.gtdPath ? 'GeneralsTD.exe' : 'Generals.exe'"
      />
      <ZhSinglePlayerSelector
        v-else
        :game-path="currentPlaygroundPath || profile.installPath"
        :original="selectedModSetId === 'vanilla'"
        :revision="playgroundRevision"
      />
    </div>

    <!-- 多人游戏（仅 MO；ZH 联机独立逻辑暂未实现，不挂载 LobbyView 以免自动连上 MO 的 CnCNet 频道） -->
    <div v-else-if="activeTab === 'multiplayer'" class="flex flex-1 flex-col overflow-hidden w-full min-h-0">
      <LobbyView
        v-if="isMentalOmega"
        :game-id="profile.id"
        :current-mod-set-id="selectedModSetId"
        :mod-sets="modSets"
        :game-path="profile.generalsPath ?? profile.installPath"
        @update:current-mod-set-id="selectModSet"
        @back="activeTab = 'modsets'"
      />
      <div v-else class="flex flex-1 items-center justify-center">
        <p class="text-[14px] text-fg-dim">绝命时刻联机暂未支持（ZH 走独立联机逻辑，不复用 MO 的 CnCNet 路径）</p>
      </div>
    </div>

    <!-- 快捷键设置 -->
    <div v-else-if="activeTab === 'keyboard'" class="flex flex-1 flex-col overflow-hidden">
      <!-- 顶部栏 -->
      <div class="flex items-center justify-between border-b border-line px-6 py-3">
        <div class="flex items-center gap-3">
          <h2 class="text-[15px] font-medium text-fg">快捷键设置</h2>
          <span v-if="captureMsg" class="text-[12px]" :class="captureMsg.startsWith('快捷键已被') ? 'text-yellow-500' : 'text-accent-hi'">
            {{ captureMsg }}
          </span>
        </div>
        <div class="flex gap-2">
          <button
            class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
            :disabled="keyboardSaving"
            @click="resetKeyboardBindings"
          >
            恢复默认
          </button>
          <button
            class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi disabled:opacity-50"
            :disabled="keyboardLoading || keyboardSaving"
            @click="saveKeyboardBindings"
          >
            {{ keyboardSaving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>

      <div v-if="keyboardLoading" class="flex flex-1 items-center justify-center">
        <p class="text-[13px] text-fg-dim">加载中...</p>
      </div>

      <template v-else>
      <!-- 空状态 -->
      <div v-if="!keyboardBindings.length" class="flex flex-1 items-center justify-center">
        <p class="text-[13px] text-fg-dim">未找到键盘配置文件（Resources\KeyboardCommands.ini）</p>
      </div>

      <div v-else class="flex min-h-0 flex-1">
        <!-- 左侧：绑定列表 -->
        <div class="flex w-[400px] shrink-0 flex-col border-r border-line overflow-y-auto">
          <div
            v-for="[cat, items] in bindingGroups"
            :key="cat"
            class="border-b border-line px-4 py-3"
          >
            <h4 class="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-dim">{{ cat }}</h4>
            <div class="space-y-1.5">
              <button
                v-for="b in items"
                :key="b.command"
                class="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left transition-colors"
                :class="editingCommand === b.command ? 'bg-accent/15 ring-1 ring-accent' : 'hover:bg-panel-alt'"
                :title="b.description"
                @click="startKeyEdit(b.command)"
              >
                <span class="min-w-0 flex-1 truncate text-[12px] text-fg">{{ b.uiName }}</span>
                <span
                  class="inline-block w-[64px] shrink-0 rounded border border-line bg-panel px-2 py-0.5 text-center font-mono text-[11px]"
                  :class="editingCommand === b.command ? 'border-accent text-accent-hi' : b.currentKey !== b.defaultKey ? 'border-accent/50 text-accent-hi' : 'text-fg-dim'"
                >
                  {{ editingCommand === b.command ? '?...' : vkToKeyName(b.currentKey) || '未绑定' }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- 右侧：键盘示意图 -->
        <div class="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
          <p class="mb-3 text-[12px] text-fg-dim">
            点击左侧任意快捷键进行绑定，然后按下新按键。高亮按键为已绑定，可点击直接定位。
          </p>
          <div class="flex min-h-0 flex-1 items-center justify-center py-4">
            <div class="w-full max-w-[860px]">
              <KeyboardVisual
                :bindings="visualBindings"
                :selected-key="editingBinding?.currentKey ?? ''"
                @key-click="onVisualKeyClick"
              />
            </div>
          </div>

          <!-- 冲突说明 -->
          <div v-if="conflictHints.length" class="mt-4 space-y-1">
            <p class="text-[11px] text-fg-dim">检测到重复绑定：</p>
            <p v-for="h in conflictHints" :key="h.key" class="text-[11px] text-yellow-500">
              {{ h.key }} → {{ h.names.join('、') }}
            </p>
          </div>
        </div>
      </div>
      </template>
    </div>

    <!-- 游戏设置 -->
    <div v-else-if="activeTab === 'settings'" class="flex flex-1 flex-col overflow-hidden px-6 py-5">
      <div class="flex-1 overflow-y-auto">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-[15px] font-medium text-fg">游戏设置</h2>
          <div class="flex gap-2">
            <button
              class="border border-line px-3 py-1.5 text-[12px] text-fg-dim hover:text-fg"
              :disabled="useGtd || graphicsLoading || soundLoading"
              @click="reloadAllSettings"
            >
              重新加载
            </button>
            <button
              class="bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent-hi disabled:opacity-50"
              :disabled="useGtd || graphicsLoading || graphicsSaving || soundLoading"
              @click="saveAllSettings"
            >
              {{ graphicsSaving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>

        <div class="max-w-[900px] space-y-6">
          <!-- 绝命时刻：启动设置 -->
          <section v-if="!isMentalOmega" class="rounded border border-line bg-panel p-4">
            <h3 class="mb-4 text-[13px] font-medium text-fg">启动设置</h3>
            <div class="space-y-4">
              <div v-if="profile.generalsPath">
                <label class="mb-1 block text-[12px] text-fg-dim">Generals 目录</label>
                <div class="border border-line bg-bg px-3 py-2 text-[13px]">{{ profile.generalsPath }}</div>
              </div>

              <div class="flex items-center gap-2">
                <input id="use-gtd" v-model="useGtd" type="checkbox" class="h-4 w-4 accent-accent" disabled />
                <label for="use-gtd" class="text-[13px] text-fg-dim">启用 GeneralsTD 引擎（暂未开放）</label>
              </div>

              <div v-if="useGtd">
                <label class="mb-1 block text-[12px] text-fg-dim">GeneralsTD 目录</label>
                <div class="flex gap-2">
                  <div class="flex-1 border border-line bg-bg px-3 py-2 text-[13px]">{{ gtdPath || '未设置' }}</div>
                  <button
                    class="shrink-0 border border-line px-3 py-2 text-[13px] text-fg-dim hover:border-accent hover:text-fg"
                    @click="selectGtdPath"
                  >
                    浏览
                  </button>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <input id="use-gentool" v-model="useGenTool" type="checkbox" class="h-4 w-4 accent-accent" :disabled="useGtd" />
                <label for="use-gentool" class="text-[13px] text-fg">启用 GenTool</label>
                <span v-if="useGtd" class="text-[11px] text-fg-dim">（启用 GeneralsTD 时无效）</span>
              </div>
            </div>
          </section>

          <!-- 画质设置（左）+ 音量设置（右）并列 -->
          <div class="flex flex-col gap-4 lg:flex-row lg:items-start">
          <section class="w-full shrink-0 rounded border border-line bg-panel p-4 lg:w-[380px]">
            <h3 class="mb-4 text-[13px] font-medium text-fg">画质设置</h3>

            <div v-if="graphicsLoading" class="flex items-center justify-center py-8">
              <p class="text-[13px] text-fg-dim">加载中...</p>
            </div>

            <template v-else>
              <!-- 心灵终结 -->
              <div v-if="isMentalOmega" class="space-y-4">
                <div>
                  <label class="mb-1 block text-[12px] text-fg-dim">渲染补丁</label>
                  <select
                    v-model="moRendererKey"
                    class="w-full border border-line bg-bg px-3 py-2 text-[13px] text-fg"
                  >
                    <option v-if="iniRendererList.length === 0" value="">默认</option>
                    <option v-for="r in iniRendererList" :key="r.value" :value="r.value">{{ r.label }}</option>
                  </select>
                  <p class="mt-1 text-[11px] text-fg-dim">选择渲染补丁后将复制对应 DLL 到游戏目录</p>
                </div>

                <div>
                  <label class="mb-1 block text-[12px] text-fg-dim">分辨率</label>
                  <select v-model="moResolution" class="w-full border border-line bg-bg px-3 py-2 text-[13px] text-fg">
                    <option v-for="res in MO_RESOLUTION_LIST" :key="res" :value="res">{{ res }}</option>
                  </select>
                </div>

                <div>
                  <label class="mb-2 block text-[12px] text-fg-dim">窗口模式</label>
                  <div class="space-y-2">
                    <label class="flex items-center gap-2 text-[13px]">
                      <input v-model="moWindowMode" type="radio" value="fullscreen" class="accent-accent" />
                      <span class="text-fg">全屏</span>
                    </label>
                    <label class="flex items-center gap-2 text-[13px]">
                      <input v-model="moWindowMode" type="radio" value="windowed" class="accent-accent" />
                      <span class="text-fg">窗口化</span>
                    </label>
                    <label class="flex items-center gap-2 text-[13px]">
                      <input v-model="moWindowMode" type="radio" value="borderless" class="accent-accent" />
                      <span class="text-fg">无边框窗口化</span>
                    </label>
                  </div>
                </div>

                <div>
                  <label class="mb-1 block text-[12px] text-fg-dim">画质</label>
                  <select v-model.number="moDetailLevel" class="w-full border border-line bg-bg px-3 py-2 text-[13px] text-fg">
                    <option v-for="d in MO_DETAIL_LEVELS" :key="d.value" :value="d.value">{{ d.label }}</option>
                  </select>
                </div>
              </div>

              <!-- GeneralsTD 的画质配置格式将在引擎接入阶段单独实现。 -->
              <div v-else-if="useGtd" class="py-8 text-center text-[13px] text-fg-dim">
                GeneralsTD 画质设置暂未实现
              </div>

              <!-- 原版绝命时刻：对齐 GenLauncher 的 Options.ini 画质项。 -->
              <div v-else class="space-y-4">
                <div>
                  <label class="mb-1 block text-[12px] text-fg-dim">分辨率</label>
                  <select v-model="resolution" class="w-full border border-line bg-bg px-3 py-2 text-[13px] text-fg">
                    <option v-for="res in resolutionList" :key="res" :value="res">{{ res }}</option>
                  </select>
                </div>

                <div>
                  <label class="mb-2 block text-[12px] text-fg-dim">窗口模式</label>
                  <div class="space-y-2">
                    <label class="flex items-center gap-2 text-[13px]">
                      <input v-model="windowMode" type="radio" value="fullscreen" class="accent-accent" />
                      <span class="text-fg">全屏</span>
                    </label>
                    <label class="flex items-center gap-2 text-[13px]">
                      <input v-model="windowMode" type="radio" value="windowed" class="accent-accent" />
                      <span class="text-fg">窗口化（启动传 -win）</span>
                    </label>
                  </div>
                </div>

                <div>
                  <div class="mb-1 flex items-center justify-between text-[12px]">
                    <label class="text-fg-dim">最大粒子数</label>
                    <span class="text-fg">{{ zhMaxParticleCount }}</span>
                  </div>
                  <input v-model.number="zhMaxParticleCount" type="range" min="100" max="5000" step="100" class="w-full accent-accent" />
                </div>

                <div>
                  <label class="mb-1 block text-[12px] text-fg-dim">纹理质量</label>
                  <select v-model.number="zhTextureQuality" class="w-full border border-line bg-bg px-3 py-2 text-[13px] text-fg">
                    <option :value="0">低</option>
                    <option :value="1">中</option>
                    <option :value="2">高</option>
                  </select>
                </div>

                <div>
                  <label class="mb-2 block text-[12px] text-fg-dim">画质选项</label>
                  <div class="grid grid-cols-2 gap-2">
                    <label v-for="option in ZH_GRAPHICS_TOGGLES" :key="option.key" class="flex items-center gap-2 text-[12px] text-fg">
                      <input
                        type="checkbox"
                        class="accent-accent"
                        :checked="zhOptionEnabled(option.key)"
                        @change="setZhOption(option.key, ($event.target as HTMLInputElement).checked)"
                      />
                      <span>{{ option.label }}</span>
                    </label>
                    <label class="flex items-center gap-2 text-[12px] text-fg">
                      <input
                        type="checkbox"
                        class="accent-accent"
                        :checked="zhOptions.DynamicLOD?.trim() === 'no'"
                        @change="setZhOption('DynamicLOD', !($event.target as HTMLInputElement).checked)"
                      />
                      <span>禁用动态细节层次</span>
                    </label>
                  </div>
                </div>

                <!-- 视角高度（对齐 GenLauncher：默认视角 / 自定义 310–850） -->
                <div>
                  <label class="mb-2 block text-[12px] text-fg-dim">视角高度</label>
                  <div class="space-y-2">
                    <label class="flex items-center gap-2 text-[13px]">
                      <input v-model="zhUseCustomCamera" type="radio" :value="false" class="accent-accent" />
                      <span class="text-fg">默认视角</span>
                    </label>
                    <label class="flex items-center gap-2 text-[13px]">
                      <input v-model="zhUseCustomCamera" type="radio" :value="true" class="accent-accent" />
                      <span class="text-fg">自定义视角</span>
                    </label>
                  </div>
                  <div v-if="zhUseCustomCamera" class="mt-2">
                    <div class="mb-1 flex items-center justify-between text-[12px]">
                      <span class="text-fg-dim">高度</span>
                      <span class="text-fg">{{ zhCameraHeight }}</span>
                    </div>
                    <input v-model.number="zhCameraHeight" type="range" min="310" max="850" step="10" class="w-full accent-accent" />
                  </div>
                </div>
              </div>
            </template>
          </section>

          <!-- 音量设置（右） -->
          <section v-if="isMentalOmega" class="flex-1 rounded border border-line bg-panel p-4">
            <h3 class="mb-4 text-[13px] font-medium text-fg">音量设置</h3>
            <div class="space-y-4">
              <div v-for="s in soundSliders" :key="s.key">
                <div class="mb-1 flex items-center justify-between">
                  <label class="text-[12px] text-fg-dim">{{ s.label }}</label>
                  <span class="text-[12px] text-fg">{{ soundValues[s.key] ?? 0 }}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  v-model.number="soundValues[s.key]"
                  class="w-full accent-accent"
                />
              </div>
              <p v-if="soundLoading" class="text-[12px] text-fg-dim">加载中...</p>
            </div>
          </section>
          </div>
        </div>

        <p v-if="status && activeTab === 'settings'" class="mt-3 text-[13px] text-fg-dim">{{ status }}</p>
      </div>
    </div>

    <!-- 其他 tab 内容 -->
    <div v-else class="flex-1 overflow-y-auto px-6 py-5">
      <p class="text-fg-dim">{{ tabs.find((t) => t.id === activeTab)?.label }} - 开发中</p>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="pendingInstallCommand" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="!commandInstalling && (pendingInstallCommand = null)">
      <div class="w-[560px] max-w-[90vw] border border-line bg-panel p-5 shadow-xl">
        <h3 class="mb-2 text-[15px] font-medium text-fg">安装计划：{{ pendingInstallCommand.name }}</h3>
        <p class="mb-3 text-[12px] text-fg-dim">确认后将自动下载缺失的 MOD、patch 和 addon，完成后创建播放集。</p>
        <div class="mb-4 max-h-[260px] space-y-2 overflow-y-auto">
          <div v-for="mod in pendingInstallCommand.mods ?? []" :key="mod.id" class="border border-line px-3 py-2">
            <div class="text-[13px] text-fg">{{ mod.id }}</div>
            <div class="mt-1 text-[11px] text-fg-dim">patch: {{ (mod.patches ?? []).join(', ') || '无' }} · addon: {{ (mod.addons ?? []).join(', ') || '无' }}</div>
            <template v-for="item in [mod.id, ...(mod.patches ?? []).map((i: number) => `${mod.id}_patch_${i}`), ...(mod.addons ?? []).map((i: number) => `${mod.id}_addon_${i}`)]" :key="item">
              <div v-if="commandInstalling" class="mt-1 flex items-center gap-2 text-[11px] text-fg-dim"><span class="min-w-0 flex-1 truncate">{{ item }}</span><span>{{ commandProgress[item]?.status === 'done' ? '完成' : commandProgress[item]?.status === 'extracting' ? '正在解压' : commandProgress[item]?.total ? `${commandProgress[item]?.progress ?? 0}%` : commandProgress[item]?.downloaded ? `已下载 ${(commandProgress[item].downloaded! / 1024 / 1024).toFixed(1)} MB` : '准备下载' }}</span></div>
              <div v-if="commandInstalling" class="h-1 bg-bg"><div class="h-1 bg-accent transition-all" :style="{ width: `${commandProgress[item]?.progress ?? 0}%` }" /></div>
            </template>
          </div>
          <div v-for="pkg in pendingInstallCommand.moddbPackages ?? []" :key="`moddb:${pkg.slug}`" class="border border-blue-500/40 px-3 py-2">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate text-[13px] text-fg">{{ pkg.slug }}</div>
                <div class="mt-1 text-[11px] text-blue-400">ModDB {{ pkg.kind === 'download' ? 'download' : 'addon' }} package · {{ pkg.mod }}</div>
              </div>
              <span class="shrink-0 text-[11px] text-fg-dim">{{ commandProgress[pkg.slug]?.status === 'done' ? '完成' : commandProgress[pkg.slug]?.status === 'extracting' ? '正在解压' : commandInstalling ? `${commandProgress[pkg.slug]?.progress ?? 0}%` : '待安装' }}</span>
            </div>
            <div v-if="commandInstalling" class="mt-2 h-1 bg-bg"><div class="h-1 bg-blue-500 transition-all" :style="{ width: `${commandProgress[pkg.slug]?.progress ?? 0}%` }" /></div>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg" :disabled="commandInstalling" @click="pendingInstallCommand = null">取消</button>
          <button class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi disabled:opacity-50" :disabled="commandInstalling" @click="confirmInstallCommand">{{ commandInstalling ? '安装中...' : '确认安装' }}</button>
        </div>
      </div>
    </div>

    <div
      v-if="showDeleteConfirm"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="cancelDelete"
    >
      <div class="w-[360px] border border-line bg-panel p-5 shadow-xl">
        <h3 class="mb-2 text-[14px] font-medium text-fg">确认删除</h3>
        <p class="mb-4 text-[13px] text-fg-dim">
          确定要删除播放集「{{ modSets.find(m => m.id === pendingDeleteId)?.name }}」吗？此操作不可撤销。
        </p>
        <div class="flex justify-end gap-2">
          <button
            class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
            @click="cancelDelete"
          >
            取消
          </button>
          <button
            class="bg-red-600 px-4 py-1.5 text-[13px] text-white hover:bg-red-700"
            @click="executeDelete"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
