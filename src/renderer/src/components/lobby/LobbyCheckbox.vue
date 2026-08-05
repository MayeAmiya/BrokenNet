<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean
  disabled?: boolean
  label: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function toggle(): void {
  if (!props.disabled) {
    emit('update:modelValue', !props.modelValue)
  }
}
</script>

<template>
  <label
    class="flex items-center gap-2 text-[12px]"
    :class="disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'"
    @click.prevent="toggle"
  >
    <span
      class="inline-flex h-4 w-4 shrink-0 items-center justify-center border transition-colors"
      :class="modelValue ? 'border-accent bg-accent' : 'border-line bg-bg'"
    >
      <svg v-if="modelValue" class="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
      </svg>
    </span>
    <span class="text-fg">{{ label }}</span>
  </label>
</template>
