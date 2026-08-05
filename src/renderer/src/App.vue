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

onMounted(async () => {
  await loadGamesFromDisk()
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
        <GameView v-if="activeGame" :profile="activeGame" @update-profile="onUpdateProfile" />
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
  </div>
</template>
