<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Mission, Difficulty } from '@renderer/types/campaign'
import { DIFFICULTY_LABELS } from '@renderer/types/campaign'
import { useCampaign } from '@renderer/composables/useCampaign'

const props = defineProps<{
  gameDir: string
  exe: string
}>()

const {
  config, selectedLine, selectedMission, selectedMissionSection, difficulty,
  campaignProgress, completedCount, totalMissions,
  allLines, selectLine, selectMission, setDifficulty,
  isMissionUnavailable,
  launchMission
} = useCampaign()

const launching = ref(false)
const launchError = ref('')

const difficulties: Difficulty[] = ['easy', 'medium', 'hard']

/** 某条战役线可玩关卡数（未开放的计为锁定） */
function linePlayableCount(line: { sections: Array<{ missions: Mission[] }> }): number {
  return line.sections.reduce((n, s) => n + s.missions.filter((m) => m.enabled !== false).length, 0)
}

function lineTotalCount(line: { sections: Array<{ missions: Mission[] }> }): number {
  return line.sections.reduce((n, s) => n + s.missions.length, 0)
}

async function handleLaunch(): Promise<void> {
  if (!selectedMission.value || launching.value) return
  if (isMissionUnavailable(selectedMission.value)) return
  launching.value = true
  launchError.value = ''
  const result = await launchMission(selectedMission.value, difficulty.value, props.gameDir, props.exe)
  if (!result.ok) {
    launchError.value = result.error ?? '启动失败'
  }
  launching.value = false
}

/** 选中战役线是否全部未开放（右栏提示用） */
const selectedLineAllLocked = computed(() => {
  if (!selectedLine.value) return false
  const all = selectedLine.value.sections.flatMap((s) => s.missions)
  return all.length > 0 && all.every((m) => m.enabled === false)
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-fg">
    <!-- 无战役提示 -->
    <div v-if="!config" class="flex flex-1 items-center justify-center">
      <p class="text-[13px] text-fg-dim">当前播放集没有战役内容</p>
    </div>

    <template v-else>
      <!-- 顶部：总进度 -->
      <div class="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <div class="flex items-center gap-3">
          <span class="text-[13px] font-bold text-fg">战役模式</span>
          <span class="text-[12px] text-fg-dim">{{ completedCount }}/{{ totalMissions }} 已通关</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="h-2 w-[120px] overflow-hidden rounded-full bg-panel-alt">
            <div class="h-full bg-accent transition-all" :style="{ width: campaignProgress + '%' }"></div>
          </div>
          <span class="text-[11px] text-fg-dim">{{ campaignProgress }}%</span>
        </div>
      </div>

      <!-- 主体：左中右三栏 -->
      <div class="flex min-h-0 flex-1">
        <!-- 左栏：战役线（只列战役线本身，子分割放中间列表） -->
        <div class="flex w-[28%] min-w-[170px] shrink-0 flex-col border-r border-line bg-panel/50">
          <p class="px-3 pb-1 pt-3 text-[11px] font-bold uppercase text-fg-dim">战役线</p>
          <div class="flex-1 overflow-y-auto px-2 pb-2">
            <button
              v-for="line in allLines"
              :key="line.key"
              class="mb-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] transition-colors"
              :class="selectedLine?.key === line.key
                ? 'bg-accent/20 text-accent'
                : 'text-fg hover:bg-panel-alt'"
              @click="selectLine(line.key)"
            >
              <span class="truncate">{{ line.label }}</span>
              <span
                v-if="linePlayableCount(line) < lineTotalCount(line)"
                class="ml-auto shrink-0 text-[10px] text-fg-dim"
              >
                {{ linePlayableCount(line) }}/{{ lineTotalCount(line) }}
              </span>
            </button>
            <p v-if="allLines.length === 0" class="px-3 pt-4 text-[12px] text-fg-dim">没有可显示的战役</p>
          </div>
          <!-- 难度选择 -->
          <div class="border-t border-line px-3 py-2">
            <p class="mb-1.5 text-[11px] text-fg-dim">难度</p>
            <div class="flex gap-1">
              <button
                v-for="d in difficulties"
                :key="d"
                class="flex-1 rounded py-1 text-[12px] transition-colors"
                :class="difficulty === d
                  ? 'bg-accent text-white'
                  : 'bg-panel-alt text-fg-dim hover:text-fg'"
                @click="setDifficulty(d)"
              >
                {{ DIFFICULTY_LABELS[d] }}
              </button>
            </div>
          </div>
        </div>

        <!-- 中栏：关卡列表（子分割在这里分段显示） -->
        <div class="flex w-[32%] min-w-[230px] shrink-0 flex-col border-r border-line">
          <p class="px-4 pb-1 pt-3 text-[11px] font-bold uppercase text-fg-dim">
            {{ selectedLine?.label ?? '选择战役线' }}
          </p>
          <div class="flex-1 overflow-y-auto px-2 pb-2">
            <template v-if="selectedLine">
              <template v-for="(sec, si) in selectedLine.sections" :key="si">
                <!-- 子分割标题（如"欧洲联盟"） -->
                <p v-if="sec.header" class="px-2 pb-0.5 pt-3 text-[11px] font-bold text-fg-dim/80">
                  {{ sec.header }}
                </p>
                <button
                  v-for="(m, idx) in sec.missions"
                  :key="m.codeName"
                  class="mb-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
                  :class="[
                    isMissionUnavailable(m)
                      ? 'cursor-not-allowed text-fg-dim/40'
                      : selectedMission?.codeName === m.codeName
                        ? 'bg-accent/20 text-accent'
                        : 'text-fg hover:bg-panel-alt'
                  ]"
                  :disabled="isMissionUnavailable(m)"
                  @click="selectMission(m.codeName)"
                >
                  <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-panel-alt text-[11px] text-fg-dim">
                    {{ idx + 1 }}
                  </span>
                  <span class="truncate text-[13px]">{{ m.name }}</span>
                  <span v-if="isMissionUnavailable(m)" class="ml-auto shrink-0 text-[10px] text-fg-dim/60">🔒 未开放</span>
                </button>
              </template>
              <p v-if="selectedLine.sections.every((s) => s.missions.length === 0)" class="px-3 pt-4 text-[12px] text-fg-dim">该战役线没有关卡</p>
            </template>
            <p v-else class="px-3 pt-4 text-[13px] text-fg-dim">请先选择一条战役线</p>
          </div>
        </div>

        <!-- 右栏：关卡详情 -->
        <div class="flex min-w-0 flex-1 flex-col">
          <template v-if="selectedMission">
            <div class="flex h-[180px] shrink-0 items-center justify-center border-b border-line bg-panel/30">
              <div class="text-center">
                <p class="text-[16px] font-bold text-fg">{{ selectedMission.name }}</p>
                <p class="mt-1 text-[12px] text-fg-dim">
                  {{ selectedMissionSection?.header ?? selectedLine?.label }}
                </p>
              </div>
            </div>
            <div class="flex-1 overflow-y-auto px-4 py-3">
              <p class="mb-3 whitespace-pre-line text-[13px] leading-relaxed text-fg">{{ selectedMission.description }}</p>
              <div class="space-y-1.5 text-[12px] text-fg-dim">
                <p>势力：{{ selectedMissionSection?.header ?? selectedLine?.label }}</p>
                <p>地图：{{ selectedMission.scenario }}</p>
              </div>
            </div>
            <div class="shrink-0 border-t border-line px-4 py-3">
              <p v-if="launchError" class="mb-2 text-center text-[12px] text-red-400">{{ launchError }}</p>
              <button
                class="w-full rounded bg-accent py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-accent-hi disabled:opacity-50"
                :disabled="launching"
                @click="handleLaunch"
              >
                {{ launching ? '启动中...' : '开始任务' }}
              </button>
            </div>
          </template>
          <div v-else class="flex flex-1 flex-col items-center justify-center gap-2">
            <p class="text-[13px] text-fg-dim">
              {{ selectedLineAllLocked ? '该战役线关卡均未开放' : '选择一个关卡查看详情' }}
            </p>
            <p v-if="selectedLineAllLocked" class="max-w-[280px] text-center text-[11px] text-fg-dim/60">
              这些关卡在 BattleClient.ini 中标记为 Enabled=False，暂未开放。
            </p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
