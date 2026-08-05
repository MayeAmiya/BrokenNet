<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { Friend } from '@renderer/types/lobby'

const props = defineProps<{ friends: Friend[] }>()
const emit = defineEmits<{ chat: [userId: string, userName: string] }>()

const show = ref(false)
const popupRef = ref<HTMLDivElement>()
const btnRef = ref<HTMLButtonElement>()
const onlineCount = computed(() => props.friends.filter(f => f.status !== 'offline').length)

function statusIcon(status: Friend['status']): string {
  if (status === 'online') return '●'
  if (status === 'in-game') return '◐'
  return '○'
}

function statusColor(status: Friend['status']): string {
  if (status === 'online') return 'text-green-500'
  if (status === 'in-game') return 'text-yellow-500'
  return 'text-fg-dim'
}

function statusLabel(status: Friend['status']): string {
  if (status === 'online') return '在线'
  if (status === 'in-game') return '游戏中'
  return '离线'
}

function toggle(): void {
  show.value = !show.value
}

function onClickOutside(e: MouseEvent): void {
  if (
    popupRef.value && !popupRef.value.contains(e.target as Node) &&
    btnRef.value && !btnRef.value.contains(e.target as Node)
  ) {
    show.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside)
})
</script>

<template>
  <!-- 触发按钮 -->
  <button
    ref="btnRef"
    class="fixed bottom-6 right-4 z-40 flex items-center gap-2 border border-line bg-panel px-3 py-1.5 text-[12px] shadow-lg hover:bg-panel-alt"
    @click.stop="toggle"
  >
    <span class="text-fg-dim">好友</span>
    <span class="text-fg">({{ onlineCount }}/{{ friends.length }})</span>
    <span class="text-fg-dim">{{ show ? '▲' : '▼' }}</span>
  </button>

  <!-- 弹出列表 -->
  <div
    v-if="show"
    ref="popupRef"
    class="fixed bottom-14 right-4 z-50 w-[220px] max-h-[300px] overflow-y-auto border border-line bg-panel shadow-xl"
  >
    <div
      v-for="friend in friends"
      :key="friend.id"
      class="group flex cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-panel-alt"
      @dblclick="friend.status !== 'offline' && emit('chat', friend.id, friend.name)"
    >
      <div class="flex items-center gap-2">
        <span class="text-[12px]" :class="statusColor(friend.status)">{{ statusIcon(friend.status) }}</span>
        <span class="text-[12px] text-fg">{{ friend.name }}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-[36px] text-right text-[10px] text-fg-dim">{{ statusLabel(friend.status) }}</span>
        <span
          v-if="friend.status !== 'offline'"
          class="text-[10px] text-accent opacity-0 transition-opacity group-hover:opacity-100"
        >
          私聊
        </span>
      </div>
    </div>
    <p v-if="!friends.length" class="px-3 py-2 text-center text-[11px] text-fg-dim">
      暂无好友
    </p>
  </div>
</template>
