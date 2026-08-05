import { ref, computed } from 'vue'
import type {
  CampaignConfig,
  CampaignAct,
  CampaignGroup,
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
const selectedLineKey = ref<string | null>(null)
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

/** 侧名 → sideId（SideName 可能有 X 后缀，如 AlliesX，剥掉后再映射） */
function mapSideNameToId(sideName: string): string {
  const s = sideName.toLowerCase().replace(/x$/, '')
  if (s === 'allies') return 'allies'
  if (s === 'soviets') return 'soviets'
  if (s === 'epsilon') return 'epsilon'
  if (s === 'foehn') return 'foehn'
  return s || 'special'
}

/** 关卡列表里的一段：子分割（组）标题 + 关卡；无子分割时 header 为 null */
export interface CampaignSection {
  header: string | null
  missions: Mission[]
}

/** 战役线（侧栏的一项）：一幕或独立分组，展开成若干段 */
export interface CampaignLineRef {
  key: string
  label: string
  sections: CampaignSection[]
}

function toMission(m: any): Mission {
  return {
    codeName: m.id,
    name: m.description || m.id,
    // MO 的描述文本用 @ 作为换行符，转成真实换行
    description: (m.longDescription || m.description || '').replace(/@/g, '\n'),
    scenario: m.scenario,
    sideId: mapSideNameToId(m.sideName),
    side: m.side,
    finalMovie: m.finalMovie || undefined,
    buildOffAlly: m.buildOffAlly,
    // MO 是 YR 的 mod，用 Ra2Mode，不需要"资料片"（Firestorm）标记
    requiredAddon: false,
    enabled: m.enabled
  }
}

function mapGroup(g: any): CampaignGroup {
  return {
    id: g.id,
    label: g.label,
    missions: (g.missions ?? []).map(toMission)
  }
}

function buildCampaignConfig(modSetId: string, gameId: string, layout: any): CampaignConfig {
  const acts: CampaignAct[] = (layout.acts ?? [])
    .map((a: any) => ({
      id: a.id,
      label: a.label,
      missions: (a.missions ?? []).map(toMission),
      groups: (a.groups ?? []).map(mapGroup).filter((g: CampaignGroup) => g.missions.length > 0)
    }))
    .filter((a: CampaignAct) => a.missions.length > 0 || a.groups.length > 0)

  const standalone: CampaignGroup[] = (layout.standalone ?? [])
    .map(mapGroup)
    .filter((g: CampaignGroup) => g.missions.length > 0)

  return {
    modSetId,
    gameId,
    acts,
    standalone
  }
}

/** 异步加载战役数据（从 BattleClient.ini） */
async function loadCampaignData(modSetId: string, gameId: string, gamePath: string): Promise<void> {
  isLoading.value = true
  try {
    if (window.api?.campaign) {
      const layout = await window.api.campaign.load(gamePath)
      if (layout && ((layout.acts?.length ?? 0) > 0 || (layout.standalone?.length ?? 0) > 0)) {
        const cfg = buildCampaignConfig(modSetId, gameId, layout)
        CAMPAIGN_CONFIGS.set(modSetId, cfg)
        // 关键：加载完成后立即更新当前播放集的 config（否则 UI 一直显示"没有战役内容"）
        if (currentModSetId.value === modSetId) {
          config.value = cfg
          selectDefault()
        }
      }
    }
  } catch (err) {
    console.error('[Campaign] Failed to load campaign data:', err)
  }
  isLoading.value = false
}

// ─── 战役线（侧栏）与选择 ───────────────────────────────

const allLines = computed<CampaignLineRef[]>(() => {
  if (!config.value) return []
  const actLines: CampaignLineRef[] = config.value.acts.map((act) => {
    const sections: CampaignSection[] = []
    if (act.missions.length > 0) sections.push({ header: null, missions: act.missions })
    for (const g of act.groups) sections.push({ header: g.label, missions: g.missions })
    return { key: act.id, label: act.label, sections }
  })
  const standalone: CampaignLineRef[] = config.value.standalone.map((g) => ({
    key: `/${g.id}`,
    label: g.label,
    sections: [{ header: null, missions: g.missions }]
  }))
  return [...actLines, ...standalone]
})

const selectedLine = computed<CampaignLineRef | null>(() => {
  return allLines.value.find((l) => l.key === selectedLineKey.value) ?? null
})

const selectedMission = computed<Mission | null>(() => {
  if (!selectedLine.value || !selectedMissionCode.value) return null
  const all = selectedLine.value.sections.flatMap((s) => s.missions)
  return all.find((m) => m.codeName === selectedMissionCode.value) ?? null
})

/** 选中的关卡所在段（用于详情栏显示"势力"子分割标题） */
const selectedMissionSection = computed<CampaignSection | null>(() => {
  if (!selectedLine.value || !selectedMissionCode.value) return null
  return selectedLine.value.sections.find((s) =>
    s.missions.some((m) => m.codeName === selectedMissionCode.value)
  ) ?? null
})

function selectLine(lineKey: string): void {
  const line = allLines.value.find((l) => l.key === lineKey)
  if (!line) return
  selectedLineKey.value = lineKey
  // 默认选中该线第一个可玩关卡；全部禁用则留空
  const all = line.sections.flatMap((s) => s.missions)
  selectedMissionCode.value = all.find((m) => m.enabled !== false)?.codeName ?? null
}

function selectMission(codeName: string): void {
  const all = selectedLine.value?.sections.flatMap((s) => s.missions) ?? []
  const mission = all.find((m) => m.codeName === codeName)
  if (!mission) return
  // 未开放的关卡不能选中（只能置灰展示）
  if (mission.enabled === false) return
  selectedMissionCode.value = codeName
}

function selectDefault(): void {
  const line = allLines.value.find((l) =>
    l.sections.some((s) => s.missions.some((m) => m.enabled !== false))
  ) ?? allLines.value[0]
  if (line) {
    selectedLineKey.value = line.key
    const all = line.sections.flatMap((s) => s.missions)
    selectedMissionCode.value = all.find((m) => m.enabled !== false)?.codeName ?? null
  } else {
    selectedLineKey.value = null
    selectedMissionCode.value = null
  }
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
  selectDefault()
}

// ─── Computed ────────────────────────────────────────────

/** 只统计可玩关卡（未开放的不计入分母，也无法通关） */
const allMissions = computed<Mission[]>(() => {
  return allLines.value.flatMap((l) => l.sections.flatMap((s) => s.missions.filter((m) => m.enabled !== false)))
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

/** 未开放的关卡（BattleClient.ini Enabled=False） */
function isMissionUnavailable(mission: Mission): boolean {
  return mission.enabled === false
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
  if (mission.enabled === false) {
    return { ok: false, error: '该关卡尚未开放，无法游玩' }
  }

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

  // 优先用 BattleClient.ini 的原始 Side 字段（MO 官方客户端的取值来源）
  const sideMap: Record<string, number> = { allies: 0, soviets: 1, epsilon: 2, foehn: 3 }
  const side = mission.side ?? (sideMap[mission.sideId] ?? 0)
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
      side,
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

function hasCampaign(modSetId: string): boolean {
  return CAMPAIGN_CONFIGS.has(modSetId)
}

// ─── 导出 ────────────────────────────────────────────────

export function useCampaign() {
  return {
    config,
    isLoading,
    currentModSetId,
    selectedLineKey,
    selectedMissionCode,
    difficulty,
    progress,
    allLines,
    selectedLine,
    selectedMission,
    selectedMissionSection,
    allMissions,
    totalMissions,
    completedCount,
    campaignProgress,
    loadCampaignData,
    switchModSet,
    selectLine,
    selectMission,
    setDifficulty,
    getMissionProgress,
    isMissionCompleted,
    isMissionUnavailable,
    markCompleted,
    launchMission,
    hasCampaign
  }
}
