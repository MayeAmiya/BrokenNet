<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ roomName: string; error?: string }>()
const emit = defineEmits<{ close: []; submit: [password: string] }>()

const password = ref('')
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="$emit('close')">
    <div class="w-[340px] border border-line bg-panel p-5 shadow-xl">
      <h3 class="mb-2 text-[14px] font-medium text-fg">输入密码</h3>
      <p class="mb-4 text-[12px] text-fg-dim">「{{ roomName }}」需要密码才能加入</p>

      <input
        v-model="password"
        type="password"
        placeholder="请输入房间密码"
        class="mb-1 w-full border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
        @keyup.enter="password && $emit('submit', password)"
      />
      <p v-if="error" class="mb-3 text-[12px] text-red-400">{{ error }}</p>
      <div v-else class="mb-3 h-[18px]"></div>

      <div class="flex justify-end gap-2">
        <button
          class="border border-line px-4 py-1.5 text-[13px] text-fg-dim hover:text-fg"
          @click="$emit('close')"
        >
          取消
        </button>
        <button
          class="bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-hi disabled:opacity-40"
          :disabled="!password"
          @click="$emit('submit', password)"
        >
          确认
        </button>
      </div>
    </div>
  </div>
</template>
