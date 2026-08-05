<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Room } from '@renderer/types/lobby'

const props = defineProps<{
  rooms: Room[]
  isLoading: boolean
  chatCollapsed?: boolean
}>()

const emit = defineEmits<{
  join: [room: Room]
  create: []
  refresh: []
  'toggle-chat': []
  hover: [room: Room, e: MouseEvent]
  'hover-move': [e: MouseEvent]
  'hover-end': []
}>()

const sortKey = ref<'name' | 'host' | 'map' | 'players' | 'gameMode'>('name')
const sortDir = ref<'asc' | 'desc'>('asc')

// 可拖拽列宽（房间名 flex-1 自适应，其余可调）——持久化到 localStorage
const COLWIDTHS_KEY = 'roomlist-colwidths'
const colWidths = ref({ host: 80, map: 120, players: 60, gameMode: 90 })
try {
  const saved = localStorage.getItem(COLWIDTHS_KEY)
  if (saved) colWidths.value = { ...colWidths.value, ...JSON.parse(saved) }
} catch { /* 损坏数据忽略 */ }
watch(colWidths, (v) => {
  localStorage.setItem(COLWIDTHS_KEY, JSON.stringify(v))
}, { deep: true })
type ColKey = keyof typeof colWidths.value
let resizingCol: ColKey | null = null
let resizeStartX = 0
let resizeStartWidth = 0

function startResize(col: ColKey, e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  resizingCol = col
  resizeStartX = e.clientX
  resizeStartWidth = colWidths.value[col]
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
}

function onResizeMove(e: MouseEvent): void {
  if (!resizingCol) return
  // 手柄在列左侧：向左拖（x 减小）→ 列往左（左边界左移，列变宽）
  const delta = resizeStartX - e.clientX
  colWidths.value[resizingCol] = Math.max(40, resizeStartWidth + delta)
}

function stopResize(): void {
  resizingCol = null
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
}

const sortedRooms = computed(() => {
  const list = [...props.rooms]
  list.sort((a, b) => {
    // 已开始的游戏默认在下方，未开始的在上方
    if (a.status !== b.status) {
      return a.status === 'in-game' ? 1 : -1
    }
    let cmp = 0
    switch (sortKey.value) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'host': cmp = a.host.localeCompare(b.host); break
      case 'map': cmp = a.map.localeCompare(b.map); break
      case 'players': cmp = a.currentPlayers - b.currentPlayers; break
      case 'gameMode': cmp = a.gameMode.localeCompare(b.gameMode); break
    }
    return sortDir.value === 'asc' ? cmp : -cmp
  })
  return list
})

function toggleSort(key: typeof sortKey.value) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

// 搜索 + 过滤：搜索按房间名/主机/地图/模式；过滤按状态/满员/密码
const searchQuery = ref('')
const hideInGame = ref(false)
const hideFull = ref(false)
const passwordFilter = ref<'all' | 'nopass' | 'pass'>('all')
const filteredRooms = computed(() => {
  let list = sortedRooms.value
  if (hideInGame.value) list = list.filter((r) => r.status !== 'in-game')
  if (hideFull.value) list = list.filter((r) => r.currentPlayers < r.maxPlayers)
  if (passwordFilter.value === 'nopass') list = list.filter((r) => !r.hasPassword)
  if (passwordFilter.value === 'pass') list = list.filter((r) => r.hasPassword)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      r.host.toLowerCase().includes(q) ||
      r.map.toLowerCase().includes(q) ||
      r.gameMode.toLowerCase().includes(q)
    )
  }
  return list
})

function statusIcon(room: Room): string {
  if (room.hasPassword) return '🔒'
  if (room.isLocked) return '🔒'
  return ''
}

function rowClass(room: Room): string {
  if (room.status === 'in-game') return 'opacity-50'
  return 'hover:bg-white/5 cursor-pointer'
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 顶部栏：搜索 + 刷新 -->
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="模糊搜索房间/主机/地图..."
        class="min-w-0 flex-1 border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-fg-dim focus:border-accent"
      />
      <span class="shrink-0 text-[12px] text-fg-dim">({{ filteredRooms.length }})</span>
      <button
        class="shrink-0 border border-line px-3 py-1 text-[12px] text-fg-dim hover:bg-white/5"
        @click="emit('refresh')"
      >
        刷新
      </button>
      <!-- 聊天栏折叠开关（→ 收起 / ← 展开） -->
      <button
        class="shrink-0 border border-line px-2 py-1 text-[12px] text-fg-dim hover:bg-white/5"
        :title="props.chatCollapsed ? '展开聊天栏' : '隐藏聊天栏'"
        @click="emit('toggle-chat')"
      >{{ props.chatCollapsed ? '←' : '→' }}</button>
    </div>

    <!-- 过滤选项 -->
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1 text-[10px] text-fg-dim">
      <label class="flex cursor-pointer items-center gap-1 select-none hover:text-fg">
        <input v-model="hideInGame" type="checkbox" class="accent-accent" />
        隐藏已开启
      </label>
      <label class="flex cursor-pointer items-center gap-1 select-none hover:text-fg">
        <input v-model="hideFull" type="checkbox" class="accent-accent" />
        隐藏满员
      </label>
      <span>密码:</span>
      <select
        v-model="passwordFilter"
        class="border border-line bg-bg px-1 py-0.5 text-[10px] text-fg outline-none focus:border-accent"
      >
        <option value="all">全部</option>
        <option value="nopass">仅无密码</option>
        <option value="pass">仅有密码</option>
      </select>
    </div>

    <!-- 列头（每列右侧有手柄，拖拽时线跟随鼠标，改变当前列） -->
    <div class="flex shrink-0 border-b border-line bg-panel/80 text-[11px] text-fg-dim">
      <button class="w-[24px] shrink-0 px-1 py-1 text-center" @click="toggleSort('name')">
        {{ sortKey === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}
      </button>
      <button class="min-w-0 flex-1 px-2 py-1 text-left" @click="toggleSort('name')">房间名</button>
      <button
        class="relative shrink-0 px-2 py-1 text-left"
        :style="{ width: colWidths.host + 'px' }"
        @click="toggleSort('host')"
      >主机<span class="col-resize" @mousedown.prevent.stop="startResize('host', $event)" /></button>
      <button
        class="relative shrink-0 px-2 py-1 text-left"
        :style="{ width: colWidths.map + 'px' }"
        @click="toggleSort('map')"
      >地图<span class="col-resize" @mousedown.prevent.stop="startResize('map', $event)" /></button>
      <button
        class="relative shrink-0 px-2 py-1 text-center"
        :style="{ width: colWidths.players + 'px' }"
        @click="toggleSort('players')"
      >人数<span class="col-resize" @mousedown.prevent.stop="startResize('players', $event)" /></button>
      <button
        class="relative shrink-0 px-2 py-1 text-left"
        :style="{ width: colWidths.gameMode + 'px' }"
        @click="toggleSort('gameMode')"
      >模式<span class="col-resize" @mousedown.prevent.stop="startResize('gameMode', $event)" /></button>
      <button class="w-[30px] shrink-0 px-1 py-1 text-center"></button>
    </div>

    <!-- 房间列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="isLoading" class="flex items-center justify-center py-8">
        <span class="text-[12px] text-fg-dim">加载中...</span>
      </div>
      <div v-else-if="!filteredRooms.length" class="flex items-center justify-center py-8">
        <span class="text-[12px] text-fg-dim">{{ rooms.length ? '没有匹配的房间' : '暂无房间' }}</span>
      </div>
      <div
        v-for="room in filteredRooms"
        :key="room.id"
        class="flex items-center border-b border-line/50 text-[12px] transition-colors"
        :class="rowClass(room)"
        @dblclick="emit('join', room)"
        @mouseenter="emit('hover', room, $event)"
        @mousemove="emit('hover-move', $event)"
        @mouseleave="emit('hover-end')"
      >
        <span class="w-[24px] shrink-0 px-1 text-center text-[10px]">{{ statusIcon(room) }}</span>
        <span class="min-w-0 flex-1 truncate px-2 text-fg">{{ room.name }}</span>
        <span class="shrink-0 truncate px-2 text-fg-dim" :style="{ width: colWidths.host + 'px' }">{{ room.host }}</span>
        <span class="shrink-0 truncate px-2 text-fg-dim" :style="{ width: colWidths.map + 'px' }">{{ room.map }}</span>
        <span class="shrink-0 px-2 text-center text-fg-dim" :style="{ width: colWidths.players + 'px' }">{{ room.currentPlayers }}/{{ room.maxPlayers }}</span>
        <span class="shrink-0 truncate px-2 text-fg-dim" :style="{ width: colWidths.gameMode + 'px' }">{{ room.gameMode }}</span>
        <span class="w-[30px] shrink-0 px-1 text-center text-[10px]">
          <span v-if="room.status === 'in-game'" class="text-yellow-500">●</span>
          <span v-else class="text-green-500">●</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.col-resize {
  position: absolute;
  top: 0;
  left: -1px;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  border-left: 1px solid var(--color-line);
  z-index: 1;
}
.col-resize:hover {
  background: var(--color-accent);
  opacity: 0.4;
  border-left-color: transparent;
}
</style>
