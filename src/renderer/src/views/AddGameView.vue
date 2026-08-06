<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useGames } from '@renderer/composables/useGames'
import type { GameProfile } from '@renderer/types/profile'

const emit = defineEmits<{
  add: [profile: GameProfile]
}>()

const { getAvailableGames } = useGames()

const selectedGame = ref<GameProfile | null>(null)
const generalsPath = ref('')
const zeroHourPath = ref('')
const useGtd = ref(false)
const gtdPath = ref('')
const resourceDir = ref('')
const errorMsg = ref('')
const discoveredPaths = ref<string[]>([])

const availableGames = getAvailableGames()

// 检测是否在同一分区
const samePartition = computed(() => {
  const gamePath = isMentalOmega.value ? generalsPath.value : zeroHourPath.value
  if (!resourceDir.value || !gamePath) return true
  const resDrive = resourceDir.value.slice(0, 1).toUpperCase()
  const gameDrive = gamePath.slice(0, 1).toUpperCase()
  return resDrive === gameDrive
})

const canSave = computed(() => {
  if (!generalsPath.value) return false
  if (!isMentalOmega.value && !zeroHourPath.value) return false
  if (!samePartition.value) return false
  if (useGtd.value && !gtdPath.value) return false
  return true
})

const isMentalOmega = computed(() => selectedGame.value?.id === 'mental-omega')

onMounted(async () => {
  resourceDir.value = (await window.api.fs.getConfig('resourceDir')) ?? ''
})

async function selectGame(game: GameProfile): Promise<void> {
  selectedGame.value = game
  errorMsg.value = ''
  discoveredPaths.value = await window.api.fs.discoverGamePaths(game.id)
}

function useDiscoveredPath(path: string): void {
  if (isMentalOmega.value) generalsPath.value = path
  else zeroHourPath.value = path
  checkPartition()
}

async function selectGeneralsPath(): Promise<void> {
  const r = await window.api.fs.selectDirectory()
  if (r.path) {
    generalsPath.value = r.path
    checkPartition()
  }
}

async function selectZeroHourPath(): Promise<void> {
  const r = await window.api.fs.selectDirectory()
  if (r.path) {
    zeroHourPath.value = r.path
    checkPartition()
  }
}

async function selectGtdPath(): Promise<void> {
  const r = await window.api.fs.selectDirectory()
  if (r.path) gtdPath.value = r.path
}

function checkPartition(): void {
  if (!resourceDir.value || !zeroHourPath.value) {
    errorMsg.value = ''
    return
  }
  if (!samePartition.value) {
    errorMsg.value = '游戏目录与数据目录不在同一分区，无法使用此功能。请将游戏安装到与数据目录相同的分区。'
  } else {
    errorMsg.value = ''
  }
}

async function confirm(): Promise<void> {
  if (!selectedGame.value) return

  const installDir = isMentalOmega.value ? generalsPath.value : zeroHourPath.value

  // 创建游戏数据目录
  await window.api.fs.createGameDirs({
    id: selectedGame.value.id,
    name: selectedGame.value.name,
    installPath: installDir,
    generalsPath: generalsPath.value,
    gtdPath: useGtd.value ? gtdPath.value : undefined
  })

  const profile = {
    ...selectedGame.value,
    installPath: installDir,
    generalsPath: generalsPath.value,
    useGtd: useGtd.value,
    gtdPath: useGtd.value ? gtdPath.value : undefined,
    actions: {
      launch: {
        type: 'launch' as const,
        exe: isMentalOmega.value
          ? 'MentalOmegaClient.exe'
          : useGtd.value
            ? `${gtdPath.value}\\GeneralsTD.exe`
            : `${generalsPath.value}\\Generals.exe`
      }
    }
  }
  emit('add', profile)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="border-b border-line px-6 py-4">
      <h1 class="text-[19px] font-light">添加游戏</h1>
    </header>

    <div class="flex-1 overflow-y-auto px-6 py-5">
      <!-- 游戏列表 -->
      <div v-if="!selectedGame">
        <div
          v-for="game in availableGames"
          :key="game.id"
          class="mb-3 flex cursor-pointer items-center gap-4 rounded border border-line bg-panel p-4 hover:border-accent hover:bg-panel-alt"
          @click="selectGame(game)"
        >
          <div class="grid h-12 w-12 shrink-0 place-items-center bg-panel-alt text-xl ring-1 ring-line">
            {{ game.name.slice(0, 1) }}
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="font-medium text-fg">{{ game.name }}</h3>
            <p class="text-[12px] text-fg-dim">{{ game.id === 'mental-omega' ? '命令与征服：红色警戒2 - 心灵终结' : '命令与征服：将军 - 绝命时刻' }}</p>
          </div>
          <span class="text-fg-dim">+</span>
        </div>
      </div>

      <!-- 路径设置 -->
      <div v-else>
        <div class="mb-4 flex items-center gap-2 text-fg-dim">
          <button class="hover:text-fg" @click="selectedGame = null">← 返回</button>
          <span>/</span>
          <span class="text-fg">{{ selectedGame.name }}</span>
        </div>

        <div v-if="discoveredPaths.length" class="mb-5 max-w-[640px] rounded border border-line bg-panel p-3">
          <p class="mb-2 text-[12px] text-fg-dim">检测到以下可能的安装目录，请确认后使用：</p>
          <div v-for="path in discoveredPaths" :key="path" class="mb-1 flex items-center justify-between gap-3 text-[12px]">
            <span class="truncate text-fg">{{ path }}</span>
            <button class="shrink-0 border border-line px-2 py-1 text-fg-dim hover:border-accent hover:text-fg" @click="useDiscoveredPath(path)">使用此目录</button>
          </div>
        </div>

        <div class="max-w-[480px]">
          <label class="mb-1 block text-[12px] text-fg-dim">
            {{ isMentalOmega ? '游戏安装目录' : 'Generals.exe 所在目录' }}
          </label>
          <div class="mb-4 flex gap-2">
            <input
              v-model="generalsPath"
              :placeholder="isMentalOmega ? '例如 D:\\MentalOmega' : '例如 C:\\Program Files\\EA Games\\Command & Conquer Generals'"
              class="flex-1 border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent"
            />
            <button
              class="shrink-0 border border-line px-3 py-2 text-[13px] text-fg-dim hover:border-accent hover:text-fg"
              @click="selectGeneralsPath"
            >
              浏览
            </button>
          </div>

          <!-- 绝命时刻需要第二个目录 -->
          <template v-if="!isMentalOmega">
            <label class="mb-1 block text-[12px] text-fg-dim">绝命时刻安装目录</label>
            <div class="mb-4 flex gap-2">
              <input
                v-model="zeroHourPath"
                placeholder="例如 C:\Program Files\EA Games\Command & Conquer Generals Zero Hour"
                class="flex-1 border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent"
              />
              <button
                class="shrink-0 border border-line px-3 py-2 text-[13px] text-fg-dim hover:border-accent hover:text-fg"
                @click="selectZeroHourPath"
              >
                浏览
              </button>
            </div>
          </template>

          <!-- GeneralsTD 引擎复选框（仅绝命时刻） -->
          <div v-if="!isMentalOmega" class="mb-4 flex items-center gap-2">
            <input
              id="use-gtd"
              v-model="useGtd"
              type="checkbox"
              class="h-4 w-4 accent-accent"
            />
            <label for="use-gtd" class="text-[13px] text-fg">启用 GeneralsTD 引擎</label>
          </div>

          <!-- GeneralsTD 目录（选中后显示） -->
          <div v-if="useGtd">
            <label class="mb-1 block text-[12px] text-fg-dim">GeneralsTD 目录</label>
            <div class="mb-4 flex gap-2">
              <input
                v-model="gtdPath"
                placeholder="例如 D:\GeneralsTD"
                class="flex-1 border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent"
              />
              <button
                class="shrink-0 border border-line px-3 py-2 text-[13px] text-fg-dim hover:border-accent hover:text-fg"
                @click="selectGtdPath"
              >
                浏览
              </button>
            </div>
          </div>

          <!-- 错误提示 -->
          <p v-if="errorMsg" class="mb-4 text-[13px] text-red-400">{{ errorMsg }}</p>

          <button
            class="bg-accent px-6 py-1.5 text-[13px] text-white hover:bg-accent-hi disabled:opacity-40"
            :disabled="!canSave"
            @click="confirm"
          >
            确认添加
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
