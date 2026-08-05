<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import type { ChatMessage } from '@renderer/types/lobby'
import { CHAT_COLORS, IRC_COLOR_HEX } from '@renderer/types/lobby'

const props = defineProps<{
  messages: ChatMessage[]
  hasRoom: boolean
  chatColor?: string
}>()

const emit = defineEmits<{
  send: [content: string]
  'update-color': [color: string]
}>()

const chatInput = ref('')
const chatScrollRef = ref<HTMLDivElement>()
const selectedColor = ref(props.chatColor ?? CHAT_COLORS[0].value)

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function sendChat(): void {
  if (!chatInput.value.trim()) return
  emit('send', chatInput.value.trim())
  chatInput.value = ''
}

watch(() => props.messages.length, async () => {
  await nextTick()
  if (chatScrollRef.value) {
    chatScrollRef.value.scrollTop = chatScrollRef.value.scrollHeight
  }
})

watch(selectedColor, (c) => emit('update-color', c))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 颜色选择 -->
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
      <span class="text-[11px] text-fg-dim">聊天颜色:</span>
      <select
        v-model="selectedColor"
        class="border border-line bg-bg px-1 py-0.5 text-[11px] text-fg outline-none"
      >
        <option v-for="c in CHAT_COLORS" :key="c.value" :value="c.value">{{ c.name }}</option>
      </select>
    </div>

    <!-- 消息列表 -->
    <div ref="chatScrollRef" class="min-h-0 flex-1 overflow-y-auto px-2 py-1">
      <div v-for="msg in messages" :key="msg.id" class="mb-0.5">
        <div v-if="msg.type !== 'message'" class="py-0.5 text-center text-[11px] text-fg-dim italic">
          {{ msg.content }}
        </div>
        <div v-else class="text-[12px] leading-[16px]">
          <span class="text-fg-dim">{{ formatTime(msg.timestamp) }}</span>
          <span class="ml-1 font-medium text-accent">&lt;{{ msg.userName }}&gt;</span>
          <span :style="msg.colorId !== undefined ? { color: IRC_COLOR_HEX[msg.colorId] ?? '#fff' } : {}" class="text-fg">{{ msg.content }}</span>
        </div>
      </div>
      <p v-if="!messages.length" class="mt-4 text-center text-[12px] text-fg-dim">
        暂无消息
      </p>
    </div>

    <!-- 输入框 -->
    <div class="flex shrink-0 gap-1 border-t border-line px-2 py-1.5">
      <input
        v-model="chatInput"
        placeholder="在这里聊天..."
        maxlength="200"
        class="flex-1 border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-fg-dim focus:border-accent"
        @keyup.enter="sendChat"
      />
      <button
        class="bg-accent px-3 py-1 text-[12px] text-white hover:bg-accent-hi disabled:opacity-40"
        :disabled="!chatInput.trim()"
        @click="sendChat"
      >
        发送
      </button>
    </div>
  </div>
</template>
