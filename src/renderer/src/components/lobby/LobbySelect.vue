<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  modelValue: string | number
  options: Array<{ value: string | number; label: string }>
  disabled?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()

const displayLabel = computed(() => {
  const opt = props.options.find(o => o.value === props.modelValue)
  return opt?.label ?? props.placeholder ?? String(props.modelValue)
})
</script>

<template>
  <div class="relative">
    <!-- 只读显示 -->
    <div
      v-if="disabled"
      class="flex items-center border border-line bg-panel px-2 py-1 text-[12px] text-fg"
    >
      {{ displayLabel }}
    </div>
    <!-- 可编辑下拉 -->
    <select
      v-else
      :value="modelValue"
      class="w-full border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="opt in options" :key="opt.value" :value="opt.value">
        {{ opt.label }}
      </option>
    </select>
  </div>
</template>
