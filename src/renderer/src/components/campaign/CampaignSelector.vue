<script setup lang="ts">
import { ref } from 'vue'
import type { Mission, Difficulty } from '@renderer/types/campaign'
import { DIFFICULTY_LABELS } from '@renderer/types/campaign'
import { useCampaign } from '@renderer/composables/useCampaign'

const props = defineProps<{
  gameDir: string
  exe: string
}>()

const {
  config, selectedBranch, selectedMission, difficulty,
  campaignProgress, completedCount, totalMissions,
  selectBranch, selectMission, setDifficulty,
  isMissionCompleted, isMissionLocked, getSideName,
  launchMission
} = useCampaign()

const launching = ref(false)
const launchError = ref('')

const difficulties: Difficulty[] = ['easy', 'medium', 'hard']

// 默认选中第一条战役线
if (config.value && config.value.branches.length > 0 && !selectedBranch.value) {
  selectBranch(config.value.branches[0].id)
}

async function handleLaunch(): Promise<void> {
  if (!selectedMission.value || launching.value) return
  launching.value = true
  launchError.value = ''
  const result = await launchMission(selectedMission.value, difficulty.value, props.gameDir, props.exe)
  if (!result.ok) {
    launchError.value = result.error ?? '启动失败'
  }
  launching.value = false
}

function missionStatus(m: Mission): string {
  if (!selectedBranch.value) return ''
  if (isMissionLocked(m, selectedBranch.value)) return 'locked'
  if (isMissionCompleted(m.codeName)) return 'completed'
  return 'available'
}
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
        <!-- 左栏：战役线选择（宽度随窗口按比例放宽，min 保证可读） -->
        <div class="flex w-[25%] min-w-[150px] shrink-0 flex-col border-r border-line bg-panel/50">
          <p class="px-3 pb-1 pt-3 text-[11px] font-bold uppercase text-fg-dim">战役线</p>
          <div class="flex-1 overflow-y-auto px-2 pb-2">
            <button
              v-for="branch in config.branches"
              :key="branch.id"
              class="mb-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] transition-colors"
              :class="selectedBranch?.id === branch.id
                ? 'bg-accent/20 text-accent'
                : 'text-fg hover:bg-panel-alt'"
              @click="selectBranch(branch.id)"
            >
              <span class="truncate">{{ branch.name }}</span>
            </button>
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

        <!-- 中栏：关卡列表（宽度随窗口按比例放宽） -->
        <div class="flex w-[25%] min-w-[200px] shrink-0 flex-col border-r border-line">
          <p class="px-4 pb-1 pt-3 text-[11px] font-bold uppercase text-fg-dim">
            {{ selectedBranch?.name ?? '选择战役线' }}
          </p>
          <div class="flex-1 overflow-y-auto px-2 pb-2">
            <div v-if="selectedBranch">
              <button
                v-for="(m, idx) in selectedBranch.missions"
                :key="m.codeName"
                class="mb-1 flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
                :class="[
                  selectedMission?.codeName === m.codeName
                    ? 'bg-accent/20 text-accent'
                    : missionStatus(m) === 'locked'
                      ? 'text-fg-dim/50'
                      : 'text-fg hover:bg-panel-alt'
                ]"
                :disabled="missionStatus(m) === 'locked'"
                @click="selectMission(m.codeName)"
              >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-panel-alt text-[11px] text-fg-dim">
                  {{ idx + 1 }}
                </span>
                <span class="truncate text-[13px]">{{ m.name }}</span>
                <span v-if="isMissionCompleted(m.codeName)" class="ml-auto text-[11px] text-green-500">&#10003;</span>
                <span v-else-if="missionStatus(m) === 'locked'" class="ml-auto text-[11px] text-fg-dim/50">&#128274;</span>
              </button>
            </div>
            <p v-else class="px-3 pt-4 text-[13px] text-fg-dim">请先选择一条战役线</p>
          </div>
        </div>

        <!-- 右栏：关卡详情 -->
        <div class="flex min-w-0 flex-1 flex-col">
          <template v-if="selectedMission">
            <div class="flex h-[180px] shrink-0 items-center justify-center border-b border-line bg-panel/30">
              <div class="text-center">
                <p class="text-[16px] font-bold text-fg">{{ selectedMission.name }}</p>
                <p class="mt-1 text-[12px] text-fg-dim">{{ getSideName(selectedMission.sideId) }}</p>
              </div>
            </div>
            <div class="flex-1 overflow-y-auto px-4 py-3">
              <p class="mb-3 whitespace-pre-line text-[13px] leading-relaxed text-fg">{{ selectedMission.description }}</p>
              <div class="space-y-1.5 text-[12px] text-fg-dim">
                <p>势力：{{ getSideName(selectedMission.sideId) }}</p>
                <p>地图：{{ selectedMission.scenario }}</p>
                <p v-if="isMissionCompleted(selectedMission.codeName)" class="text-green-500">&#10003; 已通关</p>
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
          <div v-else class="flex flex-1 items-center justify-center">
            <p class="text-[13px] text-fg-dim">选择一个关卡查看详情</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
