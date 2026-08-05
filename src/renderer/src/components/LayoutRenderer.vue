<script setup lang="ts">
import type { LayoutNode } from '@renderer/types/profile'

defineProps<{ nodes: LayoutNode[] }>()
const emit = defineEmits<{ action: [string] }>()
</script>

<template>
  <template v-for="(n, i) in nodes" :key="i">
    <h2 v-if="n.type === 'heading'" class="mb-2 text-[15px]">{{ n.value }}</h2>

    <p v-else-if="n.type === 'text'" :class="n.dim ? 'text-fg-dim' : ''">{{ n.value }}</p>

    <img
      v-else-if="n.type === 'image'"
      :src="n.src"
      class="mb-3 w-full object-cover"
      :style="n.height ? { height: `${n.height}px` } : undefined"
      alt=""
    />

    <button
      v-else-if="n.type === 'button'"
      class="px-6 py-1.5"
      :class="
        n.primary
          ? 'bg-accent text-white hover:bg-accent-hi'
          : 'border border-line hover:bg-panel-alt'
      "
      @click="emit('action', n.action)"
    >
      {{ n.label }}
    </button>

    <div v-else-if="n.type === 'row'" class="flex items-center gap-2">
      <LayoutRenderer :nodes="n.children" @action="emit('action', $event)" />
    </div>

    <div v-else-if="n.type === 'column'" class="flex flex-col gap-2">
      <LayoutRenderer :nodes="n.children" @action="emit('action', $event)" />
    </div>

    <div v-else-if="n.type === 'spacer'" class="h-4"></div>
  </template>
</template>
