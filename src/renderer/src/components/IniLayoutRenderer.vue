<script setup lang="ts">
import { computed } from 'vue'
import type { IniControlDef } from '../types/ini-layout'

const props = defineProps<{
  controls: IniControlDef[]
  parentWidth?: number
  parentHeight?: number
}>()

const emit = defineEmits<{
  (e: 'control-click', name: string, url?: string): void
}>()

function controlStyle(ctrl: IniControlDef): Record<string, string> {
  const style: Record<string, string> = {}

  if (ctrl.location) {
    style.position = 'absolute'
    style.left = `${ctrl.location.x}px`
    style.top = `${ctrl.location.y}px`
  }

  if (ctrl.size) {
    if (ctrl.size.width > 0) style.width = `${ctrl.size.width}px`
    if (ctrl.size.height > 0) style.height = `${ctrl.size.height}px`
  }

  if (ctrl.distanceFromRightBorder !== undefined && props.parentWidth) {
    style.position = 'absolute'
    style.left = `${props.parentWidth - ctrl.distanceFromRightBorder - (ctrl.size?.width ?? 0)}px`
  }

  if (ctrl.distanceFromBottomBorder !== undefined && props.parentHeight) {
    style.position = 'absolute'
    style.top = `${props.parentHeight - ctrl.distanceFromBottomBorder - (ctrl.size?.height ?? 0)}px`
  }

  if (ctrl.fillWidth !== undefined && props.parentWidth) {
    const margin = ctrl.fillWidth
    style.position = 'absolute'
    style.left = `${margin}px`
    style.width = `${props.parentWidth - margin * 2}px`
  }

  if (ctrl.fillHeight !== undefined && props.parentHeight) {
    const margin = ctrl.fillHeight
    style.position = 'absolute'
    style.top = `${margin}px`
    style.height = `${props.parentHeight - margin * 2}px`
  }

  if (ctrl.visible === false) style.display = 'none'
  if (ctrl.enabled === false) style.opacity = '0.5'

  if (ctrl.backgroundTexture) {
    style.backgroundImage = `url('/resources/${ctrl.backgroundTexture}')`
    style.backgroundSize = ctrl.drawMode === 'stretched' ? '100% 100%' : 'auto'
  }

  if (ctrl.font) {
    style.font = ctrl.font
  }

  if (ctrl.remapColor) {
    const parts = ctrl.remapColor.split(',').map(Number)
    if (parts.length >= 3) {
      style.color = `rgb(${parts[0]},${parts[1]},${parts[2]})`
      if (parts[3] !== undefined) style.opacity = String(parts[3] / 255)
    }
  }

  return style
}

function handleClick(ctrl: IniControlDef) {
  if (ctrl.url) {
    emit('control-click', ctrl.name, ctrl.url)
  }
}
</script>

<template>
  <div class="ini-layout-root" style="position: relative;">
    <template v-for="ctrl in controls" :key="ctrl.name">
      <div
        v-if="ctrl.type === 'extrapanel' || ctrl.type === 'panel'"
        :style="controlStyle(ctrl)"
        class="ini-panel"
      >
        <template v-if="ctrl.children?.length">
          <IniLayoutRenderer
            :controls="ctrl.children"
            :parent-width="ctrl.size?.width"
            :parent-height="ctrl.size?.height"
            @control-click="(n, u) => emit('control-click', n, u)"
          />
        </template>
      </div>

      <button
        v-else-if="ctrl.type === 'button' || ctrl.type === 'linkbutton'"
        :style="controlStyle(ctrl)"
        class="ini-button"
        :title="ctrl.toolTip"
        @click="handleClick(ctrl)"
      >
        {{ ctrl.text }}
      </button>

      <span
        v-else-if="ctrl.type === 'label'"
        :style="controlStyle(ctrl)"
        class="ini-label"
        :title="ctrl.toolTip"
      >
        {{ ctrl.text }}
      </span>

      <label
        v-else-if="ctrl.type === 'checkbox'"
        :style="controlStyle(ctrl)"
        class="ini-checkbox"
        :title="ctrl.toolTip"
      >
        <input type="checkbox" :checked="ctrl.extra?.Checked === 'True' || ctrl.extra?.Checked === 'yes'" />
        <span>{{ ctrl.text }}</span>
      </label>

      <select
        v-else-if="ctrl.type === 'dropdown'"
        :style="controlStyle(ctrl)"
        class="ini-dropdown"
        :title="ctrl.toolTip"
      >
        <option v-for="(item, i) in (ctrl.extra?.Items?.split(',') ?? [])" :key="i" :value="i">
          {{ (ctrl.extra?.ItemLabels?.split(',') ?? [])[i]?.trim() ?? item.trim() }}
        </option>
      </select>

      <input
        v-else-if="ctrl.type === 'textbox'"
        :style="controlStyle(ctrl)"
        class="ini-textbox"
        type="text"
        :placeholder="ctrl.text"
        :title="ctrl.toolTip"
      />

      <div
        v-else-if="ctrl.type === 'trackbar'"
        :style="controlStyle(ctrl)"
        class="ini-trackbar"
        :title="ctrl.toolTip"
      >
        <input type="range" min="0" max="100" value="50" style="width: 100%;" />
      </div>
    </template>
  </div>
</template>
