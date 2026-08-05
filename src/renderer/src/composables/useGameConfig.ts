import { ref, computed } from 'vue'
import type {
  IniGameLobbyConfig,
  IniRendererDef,
  IniClientConfig,
  IniControlDef,
  IniSize,
  GameModeConfig,
  MapConfig,
  KeyboardBinding,
  FileIntegrityCheck,
  CampaignBranch,
  TranslationFile
} from '../types/ini-layout'

const gameOptions = ref<IniGameLobbyConfig | null>(null)
const renderers = ref<IniRendererDef[]>([])
const clientConfig = ref<IniClientConfig | null>(null)
const dtaConfig = ref<Record<string, string>>({})
const windowLayouts = ref<Map<string, { size?: IniSize; controls: IniControlDef[] }>>(new Map())
const gameModes = ref<GameModeConfig[]>([])
const maps = ref<MapConfig[]>([])
const keyboardBindings = ref<KeyboardBinding[]>([])
const fileIntegrity = ref<FileIntegrityCheck[]>([])
const campaignBranches = ref<CampaignBranch[]>([])
const translations = ref<TranslationFile[]>([])
const loading = ref(false)

export function useGameConfig() {
  async function loadGameOptions(gamePath: string): Promise<IniGameLobbyConfig> {
    const data = await (window as any).api.gameOptions.load(gamePath)
    gameOptions.value = data
    return data
  }

  async function loadRenderers(gamePath: string): Promise<IniRendererDef[]> {
    const data = await (window as any).api.renderers.load(gamePath)
    renderers.value = data
    return data
  }

  async function loadDefaultRenderer(gamePath: string): Promise<string> {
    return (window as any).api.renderers.getDefault(gamePath)
  }

  async function loadClientConfig(gamePath: string): Promise<IniClientConfig> {
    const data = await (window as any).api.clientConfig.load(gamePath)
    clientConfig.value = data
    return data
  }

  async function loadDTAConfig(gamePath: string): Promise<Record<string, string>> {
    const data = await (window as any).api.clientConfig.getDTA(gamePath)
    dtaConfig.value = data
    return data
  }

  async function loadWindowLayout(
    gamePath: string,
    windowIniName: string,
    windowName?: string
  ): Promise<{ size?: IniSize; controls: IniControlDef[] }> {
    const key = `${gamePath}:${windowIniName}:${windowName ?? ''}`
    const cached = windowLayouts.value.get(key)
    if (cached) return cached
    const data = await (window as any).api.ini.loadWindowLayout(gamePath, windowIniName, windowName)
    windowLayouts.value.set(key, data)
    return data
  }

  async function loadGameModes(gamePath: string): Promise<GameModeConfig[]> {
    const data = await (window as any).api.gameMode.load(gamePath)
    gameModes.value = data
    return data
  }

  async function loadMaps(gamePath: string): Promise<MapConfig[]> {
    const data = await (window as any).api.maps.load(gamePath)
    maps.value = data
    return data
  }

  async function loadKeyboardBindings(gamePath: string): Promise<KeyboardBinding[]> {
    const data = await (window as any).api.keyboard.load(gamePath)
    keyboardBindings.value = data
    return data
  }

  async function loadFileIntegrity(gamePath: string): Promise<FileIntegrityCheck[]> {
    const data = await (window as any).api.integrity.check(gamePath)
    fileIntegrity.value = data
    return data
  }

  async function loadCampaign(gamePath: string): Promise<CampaignBranch[]> {
    const data = await (window as any).api.campaign.load(gamePath)
    campaignBranches.value = data
    return data
  }

  async function loadTranslations(dir: string): Promise<TranslationFile[]> {
    const data = await (window as any).api.translation.loadAll(dir)
    translations.value = data
    return data
  }

  async function loadAll(gamePath: string): Promise<void> {
    loading.value = true
    try {
      await Promise.all([
        loadGameOptions(gamePath),
        loadRenderers(gamePath),
        loadClientConfig(gamePath),
        loadDTAConfig(gamePath),
        loadGameModes(gamePath),
        loadMaps(gamePath),
        loadCampaign(gamePath),
        loadKeyboardBindings(gamePath),
        loadFileIntegrity(gamePath)
      ])
    } finally {
      loading.value = false
    }
  }

  function clearCache(): void {
    gameOptions.value = null
    renderers.value = []
    clientConfig.value = null
    dtaConfig.value = {}
    windowLayouts.value.clear()
    gameModes.value = []
    maps.value = []
    keyboardBindings.value = []
    fileIntegrity.value = []
    campaignBranches.value = []
    translations.value = []
  }

  const sides = computed(() => gameOptions.value?.sides ?? [])
  const mpColors = computed(() => gameOptions.value?.mpColors ?? [])
  const rendererList = computed(() =>
    renderers.value.map(r => ({
      value: r.key,
      label: r.uiName,
      dll: r.dllName
    }))
  )
  const gameName = computed(() => clientConfig.value?.longGameName ?? '')
  const gameExe = computed(() => clientConfig.value?.gameExecutableNames?.[0] ?? 'gamemd.exe')
  const missingFiles = computed(() =>
    fileIntegrity.value.filter(f => f.required && !f.exists).map(f => f.file)
  )

  return {
    gameOptions,
    renderers,
    clientConfig,
    dtaConfig,
    windowLayouts,
    gameModes,
    maps,
    keyboardBindings,
    fileIntegrity,
    campaignBranches,
    translations,
    loading,
    sides,
    mpColors,
    rendererList,
    gameName,
    gameExe,
    missingFiles,
    loadGameOptions,
    loadRenderers,
    loadDefaultRenderer,
    loadClientConfig,
    loadDTAConfig,
    loadWindowLayout,
    loadGameModes,
    loadMaps,
    loadKeyboardBindings,
    loadFileIntegrity,
    loadCampaign,
    loadTranslations,
    loadAll,
    clearCache
  }
}
