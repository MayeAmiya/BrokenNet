<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface StartingLocation {
  x: number
  y: number
  waypoint: number
}

const props = withDefaults(defineProps<{
  previewPath: string | null
  previewDataUrl?: string | null
  startingLocations: StartingLocation[]
  briefing?: string
  isCoop?: boolean
  playerColors?: Array<{ r: number; g: number; b: number }>
  assignedLocations?: Record<number, number>
  /** 预览 PNG 的实际像素尺寸（出生点坐标就基于这个坐标系） */
  mapWidth?: number
  mapHeight?: number
  initialWidth?: number
  initialHeight?: number
  /** 去掉黑底（bg-black/80），用于浅色面板/悬停预览，避免黑边 */
  noBackground?: boolean
}>(), {
  initialWidth: 400,
  initialHeight: 200,
  mapWidth: 512,
  mapHeight: 384,
  noBackground: false
})

const emit = defineEmits<{
  (e: 'location-click', waypoint: number): void
}>()

const imgLoaded = ref(false)
const imgError = ref(false)
const showBriefing = ref(true)
const containerRef = ref<HTMLDivElement>()
// 容器实际尺寸（ResizeObserver 跟踪），出生点标记据此定位，保证与 object-contain 的地图对齐
const containerSize = ref({ w: 400, h: 200 })
let resizeObserver: ResizeObserver | null = null

// Transform state
const scale = ref(1)
const panX = ref(0)
const panY = ref(0)

// Drag state
let isDragging = false
let dragStartX = 0
let dragStartY = 0
let panStartX = 0
let panStartY = 0

const previewUrl = computed(() => {
  if (props.previewDataUrl) return props.previewDataUrl
  if (!props.previewPath) return ''
  return `file:///${props.previewPath.replace(/\\/g, '/')}`
})

const formattedBriefing = computed(() => {
  if (!props.briefing) return ''
  return props.briefing
    .replace(/\\@/g, '\x00')   // 1. 转义 \@ → 临时占位符
    .replace(/\\semicolon/g, ';') // 2. 转义分号
    .replace(/@/g, '\n')       // 3. @ → 换行
    .replace(/\x00/g, '@')     // 4. 恢复字面 @
})

const transformStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
  transformOrigin: 'center center'
}))

function onImgLoad() {
  imgLoaded.value = true
}

function onImgError() {
  imgError.value = true
}

// ─── Panning (document-level for reliability) ──────
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  isDragging = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  panStartX = panX.value
  panStartY = panY.value
  document.addEventListener('mousemove', onDocMouseMove)
  document.addEventListener('mouseup', onDocMouseUp)
  e.preventDefault()
}

function onDocMouseMove(e: MouseEvent) {
  if (!isDragging) return
  panX.value = panStartX + (e.clientX - dragStartX)
  panY.value = panStartY + (e.clientY - dragStartY)
}

function onDocMouseUp() {
  isDragging = false
  document.removeEventListener('mousemove', onDocMouseMove)
  document.removeEventListener('mouseup', onDocMouseUp)
}

// ─── Zoom ──────────────────────────────────────────
function onWheel(e: WheelEvent) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  scale.value = Math.max(0.2, Math.min(5, scale.value + delta))
}

// ─── Double click to reset ─────────────────────────
function onDblClick() {
  scale.value = 1
  panX.value = 0
  panY.value = 0
}

onMounted(() => {
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 0 && r.height > 0) {
        containerSize.value = { w: r.width, h: r.height }
      }
    })
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  document.removeEventListener('mousemove', onDocMouseMove)
  document.removeEventListener('mouseup', onDocMouseUp)
  resizeObserver?.disconnect()
  resizeObserver = null
})

function getLocationStyle(loc: StartingLocation) {
  // 出生点坐标基于预览 PNG 的实际像素尺寸（mapWidth/mapHeight）。
  // 按容器实际尺寸 + object-contain 等比缩放居中换算，标记与底图始终对齐。
  const PW = props.mapWidth
  const PH = props.mapHeight
  const cw = containerSize.value.w
  const ch = containerSize.value.h
  const imgW = Math.min(cw, ch * (PW / PH))
  const imgH = Math.min(ch, cw * (PH / PW))
  const offX = (cw - imgW) / 2
  const offY = (ch - imgH) / 2
  return {
    left: `${offX + (loc.x / PW) * imgW}px`,
    top: `${offY + (loc.y / PH) * imgH}px`
  }
}

function getPlayerColor(playerIndex: number): string {
  const colors = props.playerColors ?? [
    { r: 0, g: 168, b: 168 },
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 255 },
    { r: 1, g: 255, b: 0 },
    { r: 180, g: 91, b: 229 },
    { r: 255, g: 216, b: 0 },
    { r: 0, g: 150, b: 255 },
    { r: 255, g: 132, b: 0 }
  ]
  const c = colors[playerIndex % colors.length]
  return `rgb(${c.r}, ${c.g}, ${c.b})`
}
</script>

<template>
  <div
    ref="containerRef"
    class="relative overflow-hidden select-none"
    :class="[isDragging ? 'cursor-grabbing' : 'cursor-grab', props.noBackground ? '' : 'bg-black/80']"
    style="width: 100%; height: 100%"
    @mousedown="onMouseDown"
    @wheel.prevent="onWheel"
    @dblclick="onDblClick"
    @mouseenter="showBriefing = false"
    @mouseleave="showBriefing = true"
  >
    <!-- Inner transform layer -->
    <div class="absolute inset-0" :style="transformStyle">
      <img
        v-if="previewUrl && !imgError"
        :src="previewUrl"
        class="absolute inset-0 h-full w-full object-contain"
        :style="{ imageRendering: 'pixelated' }"
        draggable="false"
        @load="onImgLoad"
        @error="onImgError"
      />
    </div>

    <!-- Starting Location Indicators -->
    <div
      v-for="loc in startingLocations"
      :key="loc.waypoint"
      class="absolute flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center z-10"
      :style="getLocationStyle(loc)"
      @click.stop="emit('location-click', loc.waypoint)"
    >
      <div
        class="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white/80"
        :style="{
          backgroundColor: assignedLocations?.[loc.waypoint] !== undefined
            ? getPlayerColor(assignedLocations[loc.waypoint])
            : 'rgba(255,255,255,0.2)',
          boxShadow: assignedLocations?.[loc.waypoint] !== undefined
            ? '0 0 6px rgba(255,255,255,0.5)'
            : 'none'
        }"
      >
        <span class="text-[9px] font-bold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
          {{ loc.waypoint }}
        </span>
      </div>
    </div>

    <!-- No Preview Fallback -->
    <div
      v-if="!previewUrl || imgError"
      class="absolute inset-0 flex items-center justify-center text-[12px] text-white/40 pointer-events-none"
    >
      无地图预览
    </div>

    <!-- Briefing: 浮在预览区底部 -->
    <Transition name="fade">
      <div
        v-if="formattedBriefing && showBriefing"
        class="pointer-events-none absolute inset-x-0 bottom-0 bg-black/85 px-4 py-3"
      >
        <p class="whitespace-pre-line text-[12px] leading-[18px] text-white/90">{{ formattedBriefing }}</p>
      </div>
    </Transition>

  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
