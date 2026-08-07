import { ref, computed } from 'vue'
import type { GameProfile } from '@renderer/types/profile'

// 固化的游戏列表
const availableGames: GameProfile[] = [
  {
    id: 'zero-hour',
    name: '绝命时刻',
    version: '1.0.0',
    installPath: '',
    layout: [
      { type: 'heading', value: '绝命时刻' },
      { type: 'text', value: '命令与征服：将军 - 绝命时刻' },
      { type: 'spacer' },
      { type: 'button', label: '启动游戏', action: 'launch', primary: true }
    ],
    actions: {
      launch: { type: 'launch', exe: '' }
    }
  },
  {
    id: 'mental-omega',
    name: '心灵终结',
    version: '3.0',
    installPath: '',
    layout: [
      { type: 'heading', value: '心灵终结' },
      { type: 'text', value: '命令与征服：红色警戒2 - 心灵终结' },
      { type: 'spacer' },
      { type: 'button', label: '启动游戏', action: 'launch', primary: true }
    ],
    actions: {
      launch: { type: 'launch', exe: '' }
    }
  }
]

// 已添加的游戏
const games = ref<GameProfile[]>([])
const activeId = ref<string | null>(null)
const loaded = ref(false)

// 从 game.ini 加载游戏列表
async function loadGamesFromDisk(): Promise<void> {
  if (loaded.value) return
  const data = await window.api.fs.loadAllGames()
  games.value = data.map((g) => ({
    id: g.id,
    name: g.name,
    version: '1.0.0',
    installPath: g.installPath,
    generalsPath: g.generalsPath,
    useGtd: g.useGtd,
    gtdPath: g.gtdPath,
    layout: [
      { type: 'heading', value: g.name },
      { type: 'text', value: g.id === 'mental-omega' ? '命令与征服：红色警戒2 - 心灵终结' : '命令与征服：将军 - 绝命时刻' },
      { type: 'spacer' },
      { type: 'button', label: '启动游戏', action: 'launch', primary: true }
    ],
    actions: {
      launch: {
        type: 'launch',
        exe: g.id === 'mental-omega'
          ? 'MentalOmegaClient.exe'
          : g.useGtd && g.gtdPath
            ? `${g.gtdPath}\\generals_td.exe`
            : `${g.generalsPath}\\Generals.exe`
      }
    }
  }))
  loaded.value = true
}

export function useGames() {
  const active = computed(() => games.value.find((g) => g.id === activeId.value) ?? null)
  const isEmpty = computed(() => games.value.length === 0)

  function select(id: string | null): void {
    activeId.value = id
  }

  function getAvailableGames(): GameProfile[] {
    return availableGames
  }

  function add(profile: GameProfile): void {
    const i = games.value.findIndex((g) => g.id === profile.id)
    if (i >= 0) games.value[i] = profile
    else games.value.push(profile)
  }

  return { games, active, activeId, isEmpty, select, add, getAvailableGames, loadGamesFromDisk }
}
