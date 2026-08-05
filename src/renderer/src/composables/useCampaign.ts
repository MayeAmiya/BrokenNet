import { ref, computed } from 'vue'
import type {
  CampaignConfig,
  CampaignBranch,
  CampaignSide,
  Mission,
  MissionProgress,
  CampaignUserSettings,
  Difficulty
} from '@renderer/types/campaign'

// ─── 播放集 → 战役配置映射 ─────────────────────────────

const CAMPAIGN_CONFIGS = new Map<string, CampaignConfig>()

// ─── 全局状态 ────────────────────────────────────────────

const currentModSetId = ref<string>('')
const config = ref<CampaignConfig | null>(null)
const selectedBranchId = ref<string | null>(null)
const selectedMissionCode = ref<string | null>(null)
const difficulty = ref<Difficulty>('medium')
const progress = ref<Map<string, MissionProgress>>(new Map())
const isLoading = ref(false)

// ─── 持久化：每个播放集独立存储 ─────────────────────────

const STORAGE_KEY = 'campaign-settings'

function loadSettings(modSetId: string): CampaignUserSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const all = JSON.parse(raw) as Record<string, CampaignUserSettings>
    return all[modSetId] ?? null
  } catch {
    return null
  }
}

function saveSettings(modSetId: string): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const all = raw ? JSON.parse(raw) as Record<string, CampaignUserSettings> : {}
    all[modSetId] = {
      modSetId,
      defaultDifficulty: difficulty.value,
      progress: Object.fromEntries(progress.value)
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // ignore
  }
}

// ─── 从 BattleClient.ini 加载真实数据 ───────────────────

function mapSideNameToId(sideName: string): string {
  const s = sideName.toLowerCase()
  if (s === 'allies') return 'allies'
  if (s === 'soviets') return 'soviets'
  if (s === 'epsilon') return 'epsilon'
  if (s === 'foehn') return 'foehn'
  return s || 'special'
}

function buildCampaignConfig(modSetId: string, gameId: string, branches: any[]): CampaignConfig {
  const sidesMap = new Map<string, CampaignSide>()
  const sideNames: Record<string, string> = {
    allies: '盟军',
    soviets: '苏联',
    epsilon: '厄普西隆',
    foehn: '焚风',
    special: '特殊行动'
  }

  const campaignBranches: CampaignBranch[] = branches.map((b: any) => {
    const sideId = mapSideNameToId(b.name)
    if (!sidesMap.has(sideId)) {
      sidesMap.set(sideId, { id: sideId, name: sideNames[sideId] ?? b.label })
    }

    const missions: Mission[] = b.missions.map((m: any) => ({
      codeName: m.id,
      name: m.description || m.id,
      // MO 的描述文本用 @ 作为换行符，转成真实换行
      description: (m.longDescription || m.description || '').replace(/@/g, '\n'),
      scenario: m.scenario,
      sideId: mapSideNameToId(m.sideName),
      finalMovie: m.finalMovie || undefined,
      buildOffAlly: m.buildOffAlly,
      // MO 是 YR 的 mod，用 Ra2Mode，不需要"资料片"（Firestorm）标记
      requiredAddon: false
    }))

    return {
      id: `${sideId}-campaign`,
      name: `${b.label}战役`,
      description: `${b.label}战役线`,
      sideId,
      missions
    }
  })

  return {
    modSetId,
    gameId,
    sides: Array.from(sidesMap.values()),
    branches: campaignBranches
  }
}

/** 异步加载战役数据（从 BattleClient.ini） */
async function loadCampaignData(modSetId: string, gameId: string, gamePath: string): Promise<void> {
  isLoading.value = true
  try {
    if (window.api?.campaign) {
      const branches = await window.api.campaign.load(gamePath)
      if (branches && branches.length > 0) {
        const cfg = buildCampaignConfig(modSetId, gameId, branches)
        CAMPAIGN_CONFIGS.set(modSetId, cfg)
        // 关键：加载完成后立即更新当前播放集的 config（否则 UI 一直显示"没有战役内容"）
        if (currentModSetId.value === modSetId) {
          config.value = cfg
          selectedBranchId.value = cfg.branches[0]?.id ?? null
          selectedMissionCode.value = cfg.branches[0]?.missions[0]?.codeName ?? null
        }
      }
    }
  } catch (err) {
    console.error('[Campaign] Failed to load campaign data:', err)
  }
  isLoading.value = false
}

// ─── 切换播放集 ──────────────────────────────────────────

function switchModSet(modSetId: string): void {
  // 1. 保存旧播放集的设置
  if (currentModSetId.value) {
    saveSettings(currentModSetId.value)
  }

  // 2. 加载新播放集的配置
  currentModSetId.value = modSetId
  config.value = CAMPAIGN_CONFIGS.get(modSetId) ?? null

  // 3. 加载新播放集的用户设置
  const saved = loadSettings(modSetId)
  if (saved) {
    difficulty.value = saved.defaultDifficulty
    progress.value = new Map(Object.entries(saved.progress))
  } else {
    difficulty.value = 'medium'
    progress.value = new Map()
  }

  // 4. 重置选择
  selectedBranchId.value = config.value?.branches[0]?.id ?? null
  selectedMissionCode.value = config.value?.branches[0]?.missions[0]?.codeName ?? null
}

// ─── Computed ────────────────────────────────────────────

const selectedBranch = computed<CampaignBranch | null>(() => {
  return config.value?.branches.find(b => b.id === selectedBranchId.value) ?? null
})

const selectedMission = computed<Mission | null>(() => {
  if (!selectedBranch.value || !selectedMissionCode.value) return null
  return selectedBranch.value.missions.find(m => m.codeName === selectedMissionCode.value) ?? null
})

const allMissions = computed<Mission[]>(() => {
  return config.value?.branches.flatMap(b => b.missions) ?? []
})

const totalMissions = computed(() => allMissions.value.length)

const completedCount = computed(() => {
  return Array.from(progress.value.values()).filter(p => p.completed).length
})

const campaignProgress = computed(() => {
  if (totalMissions.value === 0) return 0
  return Math.round((completedCount.value / totalMissions.value) * 100)
})

// ─── 方法 ────────────────────────────────────────────────

function selectBranch(branchId: string): void {
  selectedBranchId.value = branchId
  const branch = config.value?.branches.find(b => b.id === branchId)
  selectedMissionCode.value = branch?.missions[0]?.codeName ?? null
}

function selectMission(codeName: string): void {
  selectedMissionCode.value = codeName
}

function setDifficulty(d: Difficulty): void {
  difficulty.value = d
  // 立即保存难度，避免改了直接重启丢失
  if (currentModSetId.value) {
    saveSettings(currentModSetId.value)
  }
}

function getMissionProgress(codeName: string): MissionProgress | undefined {
  return progress.value.get(codeName)
}

function isMissionCompleted(codeName: string): boolean {
  return progress.value.get(codeName)?.completed ?? false
}

function isMissionLocked(_mission: Mission, _branch: CampaignBranch): boolean {
  // MO 战役配置不锁定任务（BattleClient.ini 无锁定标志），全部可选
  return false
}

function markCompleted(codeName: string, diff: Difficulty): void {
  const existing = progress.value.get(codeName)
  const bestOrder: Difficulty[] = ['easy', 'medium', 'hard']
  const newBest = existing?.bestDifficulty
    ? (bestOrder.indexOf(diff) > bestOrder.indexOf(existing.bestDifficulty) ? diff : existing.bestDifficulty)
    : diff

  progress.value.set(codeName, {
    codeName,
    completed: true,
    bestDifficulty: newBest,
    playCount: (existing?.playCount ?? 0) + 1,
    lastPlayedAt: Date.now()
  })

  // 自动保存
  if (currentModSetId.value) {
    saveSettings(currentModSetId.value)
  }
}

async function launchMission(
  mission: Mission,
  diff: Difficulty,
  gameDirIn: string,
  exe: string
): Promise<{ ok: boolean; error?: string }> {
  let gameDir = gameDirIn
  let mapsPath: string | undefined

  // 构建当前播放集的 playground 工作区（战役也从 playground 运行）
  const gameId = config.value?.gameId
  const modSetId = currentModSetId.value
  if (gameId) {
    const applyResult = await window.api.playground.apply(gameId, modSetId)
    if (!applyResult.ok || !applyResult.playgroundPath) {
      return { ok: false, error: applyResult.error ?? '工作区构建失败' }
    }
    gameDir = applyResult.playgroundPath
    mapsPath = applyResult.mapsPath
  }

  const diffMap = { easy: 0, medium: 1, hard: 2 }
  const humanDiff = diffMap[diff]
  const computerDiff = Math.abs(humanDiff - 2)

  const sideMap: Record<string, number> = { allies: 0, soviets: 1, epsilon: 2, foehn: 3 }
  // MO 用 Syringe.exe 启动，带 ExtraCommandLineParams
  const isMO = exe === 'Syringe.exe'
  const args = isMO ? ['"gamemd.exe"', '-SPAWN', '-CD', '-SPEEDCONTROL', '-LOG', '-AFFINITY:65535'] : []

  const result = await window.api.game.launch({
    gameDir,
    exe,
    args,
    spawnOptions: {
      mode: 'campaign',
      gameDir,
      playerName: 'Player',
      scenario: mission.scenario,
      side: sideMap[mission.sideId] ?? 0,
      color: 0,
      difficultyHuman: humanDiff,
      difficultyComputer: computerDiff,
      requiredAddon: mission.requiredAddon,
      buildOffAlly: mission.buildOffAlly,
      useYrMode: true,
      gameSpeed: 1,
      mpMapsPath: mapsPath
    }
  })

  if (result.ok) {
    markCompleted(mission.codeName, diff)
  }

  return result
}

function getSideName(sideId: string): string {
  return config.value?.sides.find(s => s.id === sideId)?.name ?? sideId
}

function hasCampaign(modSetId: string): boolean {
  return CAMPAIGN_CONFIGS.has(modSetId)
}

// ─── 导出 ────────────────────────────────────────────────

export function useCampaign() {
  return {
    config,
    isLoading,
    currentModSetId,
    selectedBranchId,
    selectedMissionCode,
    difficulty,
    progress,
    selectedBranch,
    selectedMission,
    allMissions,
    totalMissions,
    completedCount,
    campaignProgress,
    loadCampaignData,
    switchModSet,
    selectBranch,
    selectMission,
    setDifficulty,
    getMissionProgress,
    isMissionCompleted,
    isMissionLocked,
    markCompleted,
    launchMission,
    getSideName,
    hasCampaign
  }
}
