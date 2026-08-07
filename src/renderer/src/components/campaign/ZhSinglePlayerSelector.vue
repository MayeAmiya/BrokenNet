<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{ gamePath: string; original: boolean; revision: number }>()
const emit = defineEmits<{ launch: [selection: { mode: 'campaign' | 'challenge'; id: string; mission?: string; map?: string; template?: string; side?: string; baseSide?: string; difficulty: number; fromStart: boolean }] }>()
type Mission = { id: string; map: string; nextMission: string; location: string; generalName: string }
type Campaign = { id: string; label: string; firstMission: string; playerFaction: string; missions: Mission[] }
type General = { index: number; enabled: boolean; name: string; rank: string; branch: string; strategy: string; campaign: string; playerTemplate: string; side: string; baseSide: string }
const campaigns = ref<Campaign[]>([])
const generals = ref<General[]>([])
const challengeCampaigns = ref<Campaign[]>([])
const loading = ref(false)
const error = ref('')
const mode = ref<'campaign' | 'challenge'>('challenge')
const selectedCampaign = ref('')
const selectedGeneral = ref('')
const difficulty = ref(1)
const selectedMission = ref('')

const campaign = computed(() => campaigns.value.find((item) => item.id === selectedCampaign.value) ?? null)
const general = computed(() => generals.value.find((item) => item.campaign === selectedGeneral.value) ?? null)
const generalCampaign = computed(() => {
  const selected = selectedGeneral.value.toLowerCase()
  const exact = challengeCampaigns.value.find((item) => item.id.toLowerCase() === selected)
  if (exact) return exact
  const simplify = (value: string) => value.toLowerCase().replace(/^faction/, '').replace(/general$/, '').replace(/challenge$/, '')
  const simplified = simplify(selectedGeneral.value)
  const byName = challengeCampaigns.value.find((item) => {
    const id = simplify(item.id)
    return id === simplified || id.includes(simplified) || simplified.includes(id)
  })
  if (byName) return byName
  // 原版/Contra 的 ChallengeMode.ini 按 GeneralPersona 索引对应 CHALLENGE_N。
  const persona = generals.value.find((item) => item.campaign.toLowerCase() === selected)
  return (persona ? challengeCampaigns.value.find((item) => item.id.toLowerCase() === `challenge_${persona.index}`) : null)
    ?? challengeCampaigns.value.find((item) => item.playerFaction.toLowerCase() === selected)
})
const selectedRoute = computed(() => mode.value === 'campaign'
  ? (campaign.value ?? campaigns.value[0] ?? null)
  : (generalCampaign.value ?? challengeCampaigns.value[0] ?? null))
const selectedMissionInfo = computed(() => selectedRoute.value?.missions.find((mission) => mission.id === selectedMission.value) ?? null)
const generalGroups = computed(() => {
  const groups = new Map<string, { label: string; items: General[] }>()
  for (const item of generals.value) {
    const route = challengeCampaigns.value.find((campaign) => campaign.id.toLowerCase() === item.campaign.toLowerCase())
    const key = (route?.playerFaction || item.branch || item.campaign || '其他').trim() || '其他'
    if (!groups.has(key)) groups.set(key, { label: key.replace(/^Faction/i, '').trim() || key, items: [] })
    groups.get(key)!.items.push(item)
  }
  return [...groups.values()]
})
function launchRoute(fromStart: boolean): void {
  const id = selectedRoute.value?.id
  if (!id) return
  const mission = selectedMission.value || selectedRoute.value.firstMission || selectedRoute.value.missions[0]?.id
  const missionInfo = selectedRoute.value.missions.find((item) => item.id === mission) ?? selectedRoute.value.missions[0]
  const campaignIdentity = id.toLowerCase() === 'usa' ? { template: 'FactionAmerica', side: 'America', baseSide: 'USA' }
    : id.toLowerCase() === 'china' || id.toLowerCase() === 'cn' ? { template: 'FactionChina', side: 'China', baseSide: 'China' }
    : { template: 'FactionGLA', side: 'GLA', baseSide: 'GLA' }
  emit('launch', { mode: mode.value, id, mission: missionInfo?.id, map: missionInfo?.map, template: mode.value === 'campaign' ? campaignIdentity.template : general.value?.playerTemplate, side: mode.value === 'campaign' ? campaignIdentity.side : general.value?.side, baseSide: mode.value === 'campaign' ? campaignIdentity.baseSide : general.value?.baseSide, difficulty: difficulty.value, fromStart })
}
function readableTemplate(value: string): string {
  return value
    .replace(/^Faction/i, '')
    .replace(/General$/i, ' General')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
}

async function load(): Promise<void> {
  loading.value = true; error.value = ''
  try {
    const data = await window.api.zhSinglePlayer.load(props.gamePath, props.original)
    campaigns.value = data.campaigns
    generals.value = data.generals
    challengeCampaigns.value = data.challengeCampaigns
    selectedCampaign.value = campaigns.value[0]?.id ?? ''
    selectedGeneral.value = generals.value.find((item) => item.enabled)?.campaign ?? generals.value[0]?.campaign ?? ''
    mode.value = props.original && campaigns.value.length ? 'campaign' : 'challenge'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { loading.value = false }
}

watch(() => [props.gamePath, props.original, props.revision], load, { immediate: true })
watch(() => [mode.value, selectedCampaign.value, selectedGeneral.value], () => {
  const route = mode.value === 'campaign' ? campaign.value : generalCampaign.value
  selectedMission.value = route?.firstMission || route?.missions[0]?.id || ''
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col p-5">
    <div class="mb-4 flex items-center gap-2">
      <button v-if="original" class="px-4 py-2 text-[13px]" :class="mode === 'campaign' ? 'bg-accent text-white' : 'border border-line text-fg-dim'" @click="mode = 'campaign'">战役</button>
      <button class="px-4 py-2 text-[13px]" :class="mode === 'challenge' ? 'bg-accent text-white' : 'border border-line text-fg-dim'" @click="mode = 'challenge'">将军挑战</button>
      <span class="ml-2 text-[12px] text-fg-dim">{{ original ? 'Zero Hour 原版支持战役与挑战' : 'MOD 播放集仅支持挑战' }}</span>
      <div class="ml-auto flex items-center gap-2 text-[12px] text-fg-dim">
        <span>难度</span><input v-model.number="difficulty" type="range" min="0" max="2" step="1" class="w-28" />
        <span>{{ ['简单', '普通', '困难'][difficulty] }}</span>
        <span class="ml-2 max-w-64 truncate rounded border border-accent/50 bg-accent/10 px-2 py-1 text-accent" :title="selectedMissionInfo ? `${selectedRoute?.label || selectedRoute?.id} · ${selectedMissionInfo.location || selectedMissionInfo.id}` : '尚未选择关卡'">
          {{ selectedMissionInfo ? `已选：${selectedMissionInfo.location || selectedMissionInfo.id}` : '未选择关卡' }}
        </span>
        <button class="ml-2 rounded border border-accent px-3 py-1.5 text-accent disabled:opacity-40" :disabled="!selectedRoute" @click="launchRoute(true)">从头开始</button>
        <button class="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-40" :disabled="!selectedRoute" @click="launchRoute(false)">从选中战役开始</button>
      </div>
    </div>
    <div v-if="loading" class="flex flex-1 items-center justify-center text-[13px] text-fg-dim">正在从 BIG 读取单人内容...</div>
    <div v-else-if="error" class="p-4 text-red-400">{{ error }}</div>
    <div v-else-if="mode === 'campaign'" class="flex min-h-0 flex-1 gap-4">
      <div class="w-64 overflow-y-auto rounded border border-line bg-panel">
        <button v-for="item in campaigns" :key="item.id" class="block w-full border-b border-line px-4 py-3 text-left" :class="selectedCampaign === item.id ? 'bg-accent/20 text-accent' : 'text-fg'" @click="selectedCampaign = item.id">
          <div class="text-[13px] font-medium">{{ item.id === 'USA' ? '美国战役' : item.id === 'GLA' ? '全球解放军战役' : item.id.toLowerCase() === 'china' ? '中国战役' : item.label || item.id }}</div><div class="mt-1 text-[11px] text-fg-dim">{{ item.playerFaction }} · {{ item.missions.length }} 关</div>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto rounded border border-line bg-panel p-4">
        <h3 class="mb-3 text-[15px] text-fg">{{ campaign?.label || campaign?.id }}</h3>
        <div v-for="(mission, index) in campaign?.missions ?? []" :key="mission.id" class="mb-2 flex cursor-pointer items-start gap-2 rounded border px-3 py-2 transition-colors" :class="selectedMission === mission.id ? 'border-accent bg-accent/20 ring-1 ring-accent/60' : 'border-line bg-bg hover:border-accent/50'" @click="selectedMission = mission.id">
          <span class="mt-0.5 w-4 text-accent">{{ selectedMission === mission.id ? '✓' : '' }}</span>
          <div class="text-[13px] text-fg">{{ index + 1 }}. {{ mission.location || mission.id }}</div>
          <div class="mt-1 text-[11px] text-fg-dim">{{ mission.map }}<span v-if="mission.generalName"> · {{ mission.generalName }}</span></div>
        </div>
      </div>
    </div>
    <div v-else class="flex min-h-0 flex-1 gap-4">
      <div class="w-72 overflow-y-auto rounded border border-line bg-panel">
        <template v-for="group in generalGroups" :key="group.label">
          <div class="border-b border-line bg-bg px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-accent">{{ group.label }}</div>
          <button v-for="item in group.items" :key="item.index" class="flex w-full items-start gap-2 border-b border-line px-4 py-3 text-left disabled:opacity-40" :class="selectedGeneral === item.campaign ? 'bg-accent/20 text-accent ring-inset ring-1 ring-accent/60' : 'text-fg'" :disabled="!item.enabled" @click="selectedGeneral = item.campaign">
            <span class="w-4 text-accent">{{ selectedGeneral === item.campaign ? '✓' : '' }}</span>
            <span><span class="block text-[13px] font-medium">{{ readableTemplate(item.playerTemplate) }}</span><span class="mt-1 block text-[11px] text-fg-dim">{{ item.name }}<span v-if="!item.enabled"> · 未启用</span></span></span>
          </button>
        </template>
      </div>
      <div class="flex-1 overflow-y-auto rounded border border-line bg-panel p-4">
        <h3 class="text-[15px] text-fg">{{ general ? readableTemplate(general.playerTemplate) : '' }}</h3>
        <p class="mt-2 text-[12px] text-fg-dim">{{ general?.strategy }}</p>
        <p class="mt-3 text-[12px] text-fg-dim">Campaign：{{ general?.campaign }}</p>
        <div class="mt-4 space-y-2">
          <div v-for="(mission, index) in generalCampaign?.missions ?? []" :key="mission.id" class="flex cursor-pointer items-start gap-2 rounded border px-3 py-2 transition-colors" :class="selectedMission === mission.id ? 'border-accent bg-accent/20 ring-1 ring-accent/60' : 'border-line bg-bg hover:border-accent/50'" @click="selectedMission = mission.id">
            <span class="mt-0.5 w-4 text-accent">{{ selectedMission === mission.id ? '✓' : '' }}</span>
            <div class="text-[13px] text-fg">{{ index + 1 }}. {{ mission.location || mission.id }}</div><div class="mt-1 text-[11px] text-fg-dim">{{ mission.map }}</div>
          </div>
          <p v-if="general && !generalCampaign" class="text-[12px] text-fg-dim">未在 Campaign.ini 中找到对应挑战路线。</p>
        </div>
      </div>
    </div>
  </div>
</template>
