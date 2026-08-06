<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{ gamePath: string; original: boolean; revision: number }>()
type Mission = { id: string; map: string; nextMission: string; location: string; generalName: string }
type Campaign = { id: string; label: string; firstMission: string; playerFaction: string; missions: Mission[] }
type General = { index: number; enabled: boolean; name: string; rank: string; branch: string; strategy: string; campaign: string; playerTemplate: string }
const campaigns = ref<Campaign[]>([])
const generals = ref<General[]>([])
const challengeCampaigns = ref<Campaign[]>([])
const loading = ref(false)
const error = ref('')
const mode = ref<'campaign' | 'challenge'>('challenge')
const selectedCampaign = ref('')
const selectedGeneral = ref('')

const campaign = computed(() => campaigns.value.find((item) => item.id === selectedCampaign.value) ?? null)
const general = computed(() => generals.value.find((item) => item.campaign === selectedGeneral.value) ?? null)
const generalCampaign = computed(() => challengeCampaigns.value.find((item) => item.id.toLowerCase() === selectedGeneral.value.toLowerCase()) ?? null)
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
</script>

<template>
  <div class="flex h-full min-h-0 flex-col p-5">
    <div class="mb-4 flex items-center gap-2">
      <button v-if="original" class="px-4 py-2 text-[13px]" :class="mode === 'campaign' ? 'bg-accent text-white' : 'border border-line text-fg-dim'" @click="mode = 'campaign'">战役</button>
      <button class="px-4 py-2 text-[13px]" :class="mode === 'challenge' ? 'bg-accent text-white' : 'border border-line text-fg-dim'" @click="mode = 'challenge'">将军挑战</button>
      <span class="ml-2 text-[12px] text-fg-dim">{{ original ? 'Zero Hour 原版支持战役与挑战' : 'MOD 播放集仅支持挑战' }}</span>
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
        <div v-for="(mission, index) in campaign?.missions ?? []" :key="mission.id" class="mb-2 rounded border border-line bg-bg px-3 py-2">
          <div class="text-[13px] text-fg">{{ index + 1 }}. {{ mission.location || mission.id }}</div>
          <div class="mt-1 text-[11px] text-fg-dim">{{ mission.map }}<span v-if="mission.generalName"> · {{ mission.generalName }}</span></div>
        </div>
      </div>
    </div>
    <div v-else class="flex min-h-0 flex-1 gap-4">
      <div class="w-72 overflow-y-auto rounded border border-line bg-panel">
        <button v-for="item in generals" :key="item.index" class="block w-full border-b border-line px-4 py-3 text-left disabled:opacity-40" :class="selectedGeneral === item.campaign ? 'bg-accent/20 text-accent' : 'text-fg'" :disabled="!item.enabled" @click="selectedGeneral = item.campaign">
          <div class="text-[13px] font-medium">{{ readableTemplate(item.playerTemplate) }}</div><div class="mt-1 text-[11px] text-fg-dim">{{ item.name }}<span v-if="!item.enabled"> · 未启用</span></div>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto rounded border border-line bg-panel p-4">
        <h3 class="text-[15px] text-fg">{{ general ? readableTemplate(general.playerTemplate) : '' }}</h3>
        <p class="mt-2 text-[12px] text-fg-dim">{{ general?.strategy }}</p>
        <p class="mt-3 text-[12px] text-fg-dim">Campaign：{{ general?.campaign }}</p>
        <div class="mt-4 space-y-2">
          <div v-for="(mission, index) in generalCampaign?.missions ?? []" :key="mission.id" class="rounded border border-line bg-bg px-3 py-2">
            <div class="text-[13px] text-fg">{{ index + 1 }}. {{ mission.location || mission.id }}</div><div class="mt-1 text-[11px] text-fg-dim">{{ mission.map }}</div>
          </div>
          <p v-if="general && !generalCampaign" class="text-[12px] text-fg-dim">未在 Campaign.ini 中找到对应挑战路线。</p>
        </div>
      </div>
    </div>
  </div>
</template>
