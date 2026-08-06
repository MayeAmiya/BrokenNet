<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import TitleBar from './components/TitleBar.vue'
import ActivityBar from './components/ActivityBar.vue'
import GameView from './views/GameView.vue'
import AccountView from './views/AccountView.vue'
import SettingsView from './views/SettingsView.vue'
import EmptyView from './views/EmptyView.vue'
import AddGameView from './views/AddGameView.vue'
import { useGames } from './composables/useGames'
import { useAuth } from './composables/useAuth'
import { useToast } from './composables/useToast'
import type { GameProfile } from './types/profile'

// current 要么是固定面板名，要么是某个游戏的 id
const current = ref<string>('empty')

const { games, isEmpty, select, add, loadGamesFromDisk } = useGames()
const { user, isLoggedIn } = useAuth()
const { toasts } = useToast()

// ─── 首启引导：未设置资源库时弹出，让用户选择位置创建 BrokenNetLib ───
const needsSetup = ref(false)
const setupPath = ref('')
const setupError = ref('')
const settingUp = ref(false)

async function onChooseResourceDir(): Promise<void> {
  const r = await window.api.fs.selectDirectory()
  if (r?.path) {
    setupPath.value = r.path
    setupError.value = ''
  }
}

async function onConfirmResourceDir(): Promise<void> {
  if (!setupPath.value || settingUp.value) return
  settingUp.value = true
  setupError.value = ''
  try {
    const res = await window.api.fs.initResourceDir(setupPath.value)
    if (res.ok) {
      needsSetup.value = false
      await loadGamesFromDisk()
    } else {
      setupError.value = res.error ?? '创建失败'
    }
  } catch (e) {
    setupError.value = (e as Error).message
  } finally {
    settingUp.value = false
  }
}

onMounted(async () => {
  await loadGamesFromDisk()
  // 首次启动（未配置资源库）→ 弹出引导
  const resourceDir = await window.api.fs.getConfig('resourceDir')
  needsSetup.value = !resourceDir
  // 启动即应用界面缩放（默认 125%，可从设置页调整）
  const scale = parseInt(localStorage.getItem('ui-scale') ?? '125', 10)
  if (!isNaN(scale)) document.documentElement.style.zoom = `${scale / 100}`
})

const activeGame = computed(() => games.value.find((g) => g.id === current.value) ?? null)

function onSelect(key: string): void {
  if (key === 'add') {
    current.value = 'add'
    select(null)
    return
  }
  current.value = key
  select(key === 'settings' || key === 'account' ? null : key)
}

function onAddGame(profile: GameProfile): void {
  add(profile)
  current.value = profile.id
  select(profile.id)
}

function onUpdateProfile(profile: GameProfile): void {
  add(profile) // add 函数会更新已有游戏
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <TitleBar />

    <div class="flex min-h-0 flex-1">
      <ActivityBar :current="current" @select="onSelect" />

      <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <GameView v-if="activeGame" :key="activeGame.id" :profile="activeGame" @update-profile="onUpdateProfile" />
        <SettingsView v-else-if="current === 'settings'" />
        <AccountView v-else-if="current === 'account'" />
        <AddGameView v-else-if="current === 'add'" @add="onAddGame" />
        <EmptyView v-else />
      </main>
    </div>

    <footer
      class="flex h-6 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-[12px] text-fg-dim"
    >
      <span>{{ isEmpty ? '未添加游戏' : `${games.length} 个游戏` }}</span>
      <span>{{ isLoggedIn ? `已登录：${user?.name}` : '未登录' }}</span>
    </footer>

    <!-- Toast 提示 -->
    <div class="fixed bottom-10 left-1/2 z-50 -translate-x-1/2 space-y-2">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="rounded px-4 py-2 text-[13px] text-white shadow-lg transition-all"
        :class="{
          'bg-green-600': toast.type === 'success',
          'bg-red-600': toast.type === 'error',
          'bg-gray-600': toast.type === 'info'
        }"
      >
        {{ toast.message }}
      </div>
    </div>

    <!-- 首启引导：选择资源库位置（创建 BrokenNetLib） -->
    <div v-if="needsSetup" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div class="w-[480px] rounded-lg border border-line bg-panel p-6 shadow-2xl">
        <h2 class="text-[16px] font-medium text-fg">欢迎使用 BrokenNet</h2>
        <p class="mt-3 text-[13px] leading-6 text-fg-dim">
          首次启动需要设置<b class="text-fg">资源库</b>位置。确认后将在所选位置创建
          <b class="text-accent">BrokenNetLib</b> 文件夹，以后游戏本体和 mod 都会存放在这里。
        </p>
        <p class="mt-1 text-[13px] leading-6 text-fg-dim">
          请选择与已安装游戏本体相同的位置，让资源库和它们放在一起。
        </p>

        <div class="mt-4 flex items-center gap-2">
          <input
            readonly
            :value="setupPath"
            placeholder="未选择位置"
            class="min-w-0 flex-1 border border-line bg-bg px-3 py-2 text-[13px] outline-none"
          />
          <button
            class="shrink-0 border border-line px-3 py-2 text-[13px] text-fg-dim hover:border-accent hover:text-fg"
            @click="onChooseResourceDir"
          >
            选择位置
          </button>
        </div>
        <p v-if="setupError" class="mt-2 text-[12px] text-red-400">{{ setupError }}</p>

        <button
          class="mt-5 w-full bg-accent py-2 text-[13px] text-white hover:bg-accent-hi disabled:opacity-40"
          :disabled="!setupPath || settingUp"
          @click="onConfirmResourceDir"
        >
          {{ settingUp ? '创建中...' : '开始使用' }}
        </button>
      </div>
    </div>
  </div>
</template>
