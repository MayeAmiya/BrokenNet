<script setup lang="ts">
import type { Room } from '@renderer/types/lobby'

defineProps<{ room: Room }>()
defineEmits<{ click: []; dblclick: [] }>()

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  return `${Math.floor(diff / 3600000)}小时前`
}

function statusColor(status: Room['status']): string {
  if (status === 'in-game') return 'text-yellow-500'
  if (status === 'waiting') return 'text-green-500'
  return 'text-fg-dim'
}

function statusLabel(status: Room['status']): string {
  if (status === 'in-game') return '游戏中'
  if (status === 'waiting') return '等待中'
  return '准备中'
}
</script>

<template>
  <div
    class="cursor-pointer border-b border-line px-4 py-3 transition-colors hover:bg-panel-alt"
    @click="$emit('click')"
    @dblclick="$emit('dblclick')"
  >
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-[13px] text-fg truncate">{{ room.name }}</span>
        <svg v-if="room.hasPassword" class="h-3 w-3 shrink-0 text-fg-dim" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
        </svg>
      </div>
      <span class="text-[11px] shrink-0" :class="statusColor(room.status)">
        {{ statusLabel(room.status) }}
      </span>
    </div>
    <div class="mt-1 flex items-center gap-3 text-[11px] text-fg-dim">
      <span>{{ room.gameMode }}</span>
      <span>{{ room.map }}</span>
      <span>{{ room.currentPlayers }}/{{ room.maxPlayers }}</span>
    </div>
    <div class="mt-1 flex items-center justify-between text-[11px] text-fg-dim">
      <span>{{ room.host }}</span>
      <span>{{ formatTime(room.createdAt) }}</span>
    </div>
  </div>
</template>
