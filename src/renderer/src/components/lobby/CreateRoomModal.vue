<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useNickname } from '@renderer/composables/useNickname'

const props = defineProps<{
  gameId: string
  modSetId?: string
  maps: string[]
  gameModes: string[]
}>()

const emit = defineEmits<{
  close: []
  create: [data: {
    name: string
    gameMode: string
    map: string
    maxPlayers: number
    password: string
    skillLevel: number
    modSetId: string
  }]
}>()

// 房间默认名用在线昵称（昵称持久化在 config.json，需异步加载）
const { nickname: onlineNickname, loadNickname } = useNickname()
const name = ref('')
const password = ref('')

onMounted(async () => {
  await loadNickname()
  name.value = `${onlineNickname.value || '玩家'}'s Game`
})

const canSubmit = computed(() => name.value.trim().length > 0)

function onConfirm(): void {
  emit('create', {
    name: name.value.trim(),
    gameMode: props.gameModes[0] || '',
    map: props.maps[0] ?? '',
    maxPlayers: 8,
    password: password.value,
    skillLevel: 0,
    modSetId: props.modSetId ?? 'vanilla'
  })
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="$emit('close')">
    <div class="w-[460px] border border-line bg-panel p-5 shadow-xl">
      <h3 class="mb-4 text-[14px] font-medium text-fg">创建游戏房间</h3>

      <!-- 房间名 -->
      <label class="mb-1 block text-[12px] text-fg-dim">游戏房间名称:</label>
      <input
        v-model="name"
        placeholder="房间名"
        maxlength="23"
        class="mb-3 w-full border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
      />

      <!-- 密码 -->
      <label class="mb-1 block text-[12px] text-fg-dim">密码 (留空则无密码):</label>
      <input
        v-model="password"
        placeholder="可选"
        maxlength="20"
        type="password"
        class="mb-4 w-full border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
      />

      <!-- 按钮 -->
      <div class="flex justify-end gap-2">
        <button
          class="border border-line px-4 py-2 text-[12px] text-fg-dim hover:bg-white/5"
          @click="$emit('close')"
        >
          取消
        </button>
        <button
          class="bg-accent px-4 py-2 text-[12px] text-white hover:bg-accent-hi disabled:opacity-40"
          :disabled="!canSubmit"
          @click="onConfirm"
        >
          创建游戏
        </button>
      </div>
    </div>
  </div>
</template>
