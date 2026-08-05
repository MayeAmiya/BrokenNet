<script setup lang="ts">
/**
 * 键盘示意图 —— SVG 渲染的标准键盘。
 * - 高亮已绑定的按键（accent 色 + 发光）
 * - 悬停显示该键绑定的命令
 * - 点击任意键触发 key-click（父组件据此定位到对应快捷键）
 */
import { computed, ref } from 'vue'

export interface VisualBinding {
  /** 游戏侧的按键名，如 "Q" / "Shift" / "Space" */
  key: string
  /** 命令显示名（用于 tooltip） */
  label: string
  /** 命令标识 */
  command: string
}

const props = withDefaults(defineProps<{
  bindings?: VisualBinding[]
  selectedKey?: string
}>(), {
  bindings: () => [],
  selectedKey: ''
})

const emit = defineEmits<{
  (e: 'key-click', key: string): void
}>()

// ─── 布局 ────────────────────────────────────────────
interface KeyDef {
  code: string
  label: string
  x: number
  y: number
  w: number
  h?: number
  mod?: boolean
}

// 单位 = 1 个标准键宽。viewBox 宽 20、高 8.4。
const KEYS: KeyDef[] = [
  // 功能键行 y=0
  { code: 'esc', label: 'Esc', x: 0, y: 0, w: 1.2 },
  { code: 'f1', label: 'F1', x: 1.5, y: 0, w: 1.1 },
  { code: 'f2', label: 'F2', x: 2.6, y: 0, w: 1.1 },
  { code: 'f3', label: 'F3', x: 3.7, y: 0, w: 1.1 },
  { code: 'f4', label: 'F4', x: 4.8, y: 0, w: 1.1 },
  { code: 'f5', label: 'F5', x: 6.0, y: 0, w: 1.1 },
  { code: 'f6', label: 'F6', x: 7.1, y: 0, w: 1.1 },
  { code: 'f7', label: 'F7', x: 8.2, y: 0, w: 1.1 },
  { code: 'f8', label: 'F8', x: 9.3, y: 0, w: 1.1 },
  { code: 'f9', label: 'F9', x: 10.5, y: 0, w: 1.1 },
  { code: 'f10', label: 'F10', x: 11.6, y: 0, w: 1.1 },
  { code: 'f11', label: 'F11', x: 12.7, y: 0, w: 1.1 },
  { code: 'f12', label: 'F12', x: 13.8, y: 0, w: 1.1 },

  // 数字行 y=1.3
  { code: '`', label: '`', x: 0, y: 1.3, w: 1 },
  { code: '1', label: '1', x: 1, y: 1.3, w: 1 },
  { code: '2', label: '2', x: 2, y: 1.3, w: 1 },
  { code: '3', label: '3', x: 3, y: 1.3, w: 1 },
  { code: '4', label: '4', x: 4, y: 1.3, w: 1 },
  { code: '5', label: '5', x: 5, y: 1.3, w: 1 },
  { code: '6', label: '6', x: 6, y: 1.3, w: 1 },
  { code: '7', label: '7', x: 7, y: 1.3, w: 1 },
  { code: '8', label: '8', x: 8, y: 1.3, w: 1 },
  { code: '9', label: '9', x: 9, y: 1.3, w: 1 },
  { code: '0', label: '0', x: 10, y: 1.3, w: 1 },
  { code: '-', label: '-', x: 11, y: 1.3, w: 1 },
  { code: '=', label: '=', x: 12, y: 1.3, w: 1 },
  { code: 'backspace', label: 'Backspace', x: 13, y: 1.3, w: 2 },

  // 上排字母行 y=2.4
  { code: 'tab', label: 'Tab', x: 0, y: 2.4, w: 1.5 },
  { code: 'q', label: 'Q', x: 1.5, y: 2.4, w: 1 },
  { code: 'w', label: 'W', x: 2.5, y: 2.4, w: 1 },
  { code: 'e', label: 'E', x: 3.5, y: 2.4, w: 1 },
  { code: 'r', label: 'R', x: 4.5, y: 2.4, w: 1 },
  { code: 't', label: 'T', x: 5.5, y: 2.4, w: 1 },
  { code: 'y', label: 'Y', x: 6.5, y: 2.4, w: 1 },
  { code: 'u', label: 'U', x: 7.5, y: 2.4, w: 1 },
  { code: 'i', label: 'I', x: 8.5, y: 2.4, w: 1 },
  { code: 'o', label: 'O', x: 9.5, y: 2.4, w: 1 },
  { code: 'p', label: 'P', x: 10.5, y: 2.4, w: 1 },
  { code: '[', label: '[', x: 11.5, y: 2.4, w: 1 },
  { code: ']', label: ']', x: 12.5, y: 2.4, w: 1 },
  { code: '\\', label: '\\', x: 13.5, y: 2.4, w: 1.5 },

  // 主行 y=3.5
  { code: 'caps', label: 'Caps', x: 0, y: 3.5, w: 1.75, mod: true },
  { code: 'a', label: 'A', x: 1.75, y: 3.5, w: 1 },
  { code: 's', label: 'S', x: 2.75, y: 3.5, w: 1 },
  { code: 'd', label: 'D', x: 3.75, y: 3.5, w: 1 },
  { code: 'f', label: 'F', x: 4.75, y: 3.5, w: 1 },
  { code: 'g', label: 'G', x: 5.75, y: 3.5, w: 1 },
  { code: 'h', label: 'H', x: 6.75, y: 3.5, w: 1 },
  { code: 'j', label: 'J', x: 7.75, y: 3.5, w: 1 },
  { code: 'k', label: 'K', x: 8.75, y: 3.5, w: 1 },
  { code: 'l', label: 'L', x: 9.75, y: 3.5, w: 1 },
  { code: ';', label: ';', x: 10.75, y: 3.5, w: 1 },
  { code: "'", label: "'", x: 11.75, y: 3.5, w: 1 },
  { code: 'enter', label: 'Enter', x: 12.75, y: 3.5, w: 2.25 },

  // 下排字母行 y=4.6
  { code: 'lshift', label: 'Shift', x: 0, y: 4.6, w: 2.25, mod: true },
  { code: 'z', label: 'Z', x: 2.25, y: 4.6, w: 1 },
  { code: 'x', label: 'X', x: 3.25, y: 4.6, w: 1 },
  { code: 'c', label: 'C', x: 4.25, y: 4.6, w: 1 },
  { code: 'v', label: 'V', x: 5.25, y: 4.6, w: 1 },
  { code: 'b', label: 'B', x: 6.25, y: 4.6, w: 1 },
  { code: 'n', label: 'N', x: 7.25, y: 4.6, w: 1 },
  { code: 'm', label: 'M', x: 8.25, y: 4.6, w: 1 },
  { code: ',', label: ',', x: 9.25, y: 4.6, w: 1 },
  { code: '.', label: '.', x: 10.25, y: 4.6, w: 1 },
  { code: '/', label: '/', x: 11.25, y: 4.6, w: 1 },
  { code: 'rshift', label: 'Shift', x: 12.25, y: 4.6, w: 2.75, mod: true },

  // 底部行 y=5.7
  { code: 'lctrl', label: 'Ctrl', x: 0, y: 5.7, w: 1.25, mod: true },
  { code: 'lwin', label: 'Win', x: 1.25, y: 5.7, w: 1.25, mod: true },
  { code: 'lalt', label: 'Alt', x: 2.5, y: 5.7, w: 1.25, mod: true },
  { code: 'space', label: 'Space', x: 3.75, y: 5.7, w: 6.25 },
  { code: 'ralt', label: 'Alt', x: 10, y: 5.7, w: 1.25, mod: true },
  { code: 'rwin', label: 'Win', x: 11.25, y: 5.7, w: 1.25, mod: true },
  { code: 'menu', label: 'Menu', x: 12.5, y: 5.7, w: 1.25, mod: true },
  { code: 'rctrl', label: 'Ctrl', x: 13.75, y: 5.7, w: 1.25, mod: true },

  // 导航区
  { code: 'insert', label: 'Ins', x: 16, y: 3.5, w: 1 },
  { code: 'home', label: 'Home', x: 17, y: 3.5, w: 1 },
  { code: 'pgup', label: 'PgUp', x: 18, y: 3.5, w: 1 },
  { code: 'delete', label: 'Del', x: 16, y: 4.6, w: 1 },
  { code: 'end', label: 'End', x: 17, y: 4.6, w: 1 },
  { code: 'pgdn', label: 'PgDn', x: 18, y: 4.6, w: 1 },
  { code: 'up', label: '↑', x: 17, y: 5.7, w: 1 },
  { code: 'left', label: '←', x: 16, y: 6.8, w: 1 },
  { code: 'down', label: '↓', x: 17, y: 6.8, w: 1 },
  { code: 'right', label: '→', x: 18, y: 6.8, w: 1 }
]

// 按键实际占用范围：x 0..19，y 0..7.8
const VB_W = 19
const VB_H = 7.8
// 对称内边距（四边一致，键盘在 viewBox 里居中，不再偏移）
const PAD = 0.4
// 键与键之间的空隙（每个键向内缩 GAP/2，避免键贴在一起太挤）
const GAP = 0.07
// viewBox 含边距后的实际尺寸（容器 aspect 须与此一致，tooltip 才能对齐）
const VB_W2 = VB_W + PAD * 2
const VB_H2 = VB_H + PAD * 2

// ─── 按键名规范化 ────────────────────────────────────
const MOD_GROUPS: Record<string, string[]> = {
  shift: ['lshift', 'rshift'],
  ctrl: ['lctrl', 'rctrl'],
  alt: ['lalt', 'ralt'],
  win: ['lwin', 'rwin']
}

function codeGroup(norm: string): string[] {
  return MOD_GROUPS[norm] ?? [norm]
}

function normalizeKey(raw: string): string {
  const k = raw.trim()
  const lower = k.toLowerCase()
  const map: Record<string, string> = {
    shift: 'shift', lshift: 'shift', rshift: 'shift', leftshift: 'shift', rightshift: 'shift',
    ctrl: 'ctrl', control: 'ctrl', lctrl: 'ctrl', rctrl: 'ctrl', leftctrl: 'ctrl', rightctrl: 'ctrl',
    lcontrol: 'ctrl', rcontrol: 'ctrl',
    alt: 'alt', lalt: 'alt', ralt: 'alt', leftalt: 'alt', rightalt: 'alt', menu: 'alt',
    win: 'win', lwin: 'win', rwin: 'win', meta: 'win', lmeta: 'win', rmeta: 'win',
    space: 'space', spacebar: 'space',
    enter: 'enter', return: 'enter',
    tab: 'tab',
    esc: 'esc', escape: 'esc',
    backspace: 'backspace',
    up: 'up', arrowup: 'up',
    down: 'down', arrowdown: 'down',
    left: 'left', arrowleft: 'left',
    right: 'right', arrowright: 'right',
    insert: 'insert', ins: 'insert',
    delete: 'delete', del: 'delete',
    home: 'home', end: 'end',
    pageup: 'pgup', pgup: 'pgup',
    pagedown: 'pgdn', pgdn: 'pgdn',
    caps: 'caps', capslock: 'caps'
  }
  if (map[lower]) return map[lower]
  if (/^f\d{1,2}$/.test(lower)) return lower
  if (k.length === 1) {
    if (/[a-z]/i.test(k)) return k.toLowerCase()
    if (/[0-9]/.test(k)) return k
    const punc: Record<string, string> = {
      ',': ',', '.': '.', '/': '/', ';': ';', "'": "'",
      '[': '[', ']': ']', '\\': '\\', '-': '-', '=': '=', '`': '`'
    }
    if (punc[k]) return punc[k]
  }
  const num = lower.replace(/^(num|numpad)/, '')
  if (/^\d$/.test(num)) return num
  return lower
}

// ─── 计算高亮 ────────────────────────────────────────
const boundLabels = computed<Map<string, string[]>>(() => {
  const map = new Map<string, string[]>()
  for (const b of props.bindings) {
    if (!b.key) continue
    for (const code of codeGroup(normalizeKey(b.key))) {
      if (!map.has(code)) map.set(code, [])
      map.get(code)!.push(b.label)
    }
  }
  return map
})

const selectedCodes = computed<Set<string>>(() => {
  if (!props.selectedKey) return new Set()
  return new Set(codeGroup(normalizeKey(props.selectedKey)))
})

// ─── 渲染状态 ────────────────────────────────────────
const hoverCode = ref<string | null>(null)

function isBound(code: string): boolean {
  return boundLabels.value.has(code)
}

function isSelected(code: string): boolean {
  return selectedCodes.value.has(code)
}

function fillFor(key: KeyDef): string {
  if (isSelected(key.code)) return 'var(--color-accent)'
  if (isBound(key.code)) return 'rgba(0, 120, 212, 0.4)'
  if (key.mod) return '#2d2d30'
  return '#252526'
}

function strokeFor(key: KeyDef): string {
  if (isSelected(key.code)) return 'var(--color-accent-hi)'
  if (isBound(key.code)) return 'var(--color-accent)'
  return '#3f3f46'
}

function textColor(key: KeyDef): string {
  if (isSelected(key.code)) return '#ffffff'
  if (isBound(key.code)) return '#e8f4ff'
  return '#9d9d9d'
}

const hoveredTooltip = computed(() => {
  if (!hoverCode.value) return null
  const key = KEYS.find((k) => k.code === hoverCode.value)
  if (!key) return null
  const labels = boundLabels.value.get(key.code)
  return {
    key,
    labels: labels ?? []
  }
})

const tooltipStyle = computed(() => {
  const t = hoveredTooltip.value
  if (!t) return {}
  // 换算到含边距的 viewBox 坐标系，百分比与 SVG 内实际位置一一对应
  const cx = (t.key.x + t.key.w / 2 + PAD) / VB_W2 * 100
  const top = (t.key.y + PAD) / VB_H2 * 100
  return {
    left: `${cx}%`,
    top: `${top}%`
  }
})

function onKeyClick(key: KeyDef): void {
  emit('key-click', key.code)
}
</script>

<template>
  <div class="relative select-none" :style="{ aspectRatio: `${VB_W2} / ${VB_H2}`, width: '100%' }">
    <svg
      :viewBox="`-0.4 -0.5 ${VB_W2} ${VB_H2}`"
      class="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <g
        v-for="key in KEYS"
        :key="key.code"
        class="cursor-pointer"
        @mouseenter="hoverCode = key.code"
        @mouseleave="hoverCode = null"
        @click="onKeyClick(key)"
      >
        <!-- 发光效果（选中的键）：向内缩 GAP/2 留出键间距 -->
        <rect
          v-if="isSelected(key.code)"
          :x="key.x + GAP / 2"
          :y="key.y + GAP / 2"
          :width="key.w - GAP"
          :height="(key.h ?? 1) - GAP"
          rx="0.1"
          class="key-glow"
        />
        <rect
          :x="key.x + GAP / 2"
          :y="key.y + GAP / 2"
          :width="key.w - GAP"
          :height="(key.h ?? 1) - GAP"
          rx="0.1"
          :fill="fillFor(key)"
          :stroke="strokeFor(key)"
          stroke-width="0.04"
          class="key-rect"
        />
        <text
          :x="key.x + key.w / 2"
          :y="key.y + (key.h ?? 1) / 2"
          :fill="textColor(key)"
          font-size="0.34"
          font-weight="600"
          text-anchor="middle"
          dominant-baseline="central"
          font-family="'Segoe UI', sans-serif"
        >
          {{ key.label }}
        </text>
      </g>
    </svg>

    <!-- 悬停提示 -->
    <Transition name="tooltip">
      <div
        v-if="hoveredTooltip"
        class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] whitespace-nowrap rounded border border-line bg-panel px-2.5 py-1.5 shadow-lg"
        :style="tooltipStyle"
      >
        <p class="text-[11px] text-fg-dim">
          <span class="text-fg">{{ hoveredTooltip.key.label }}</span>
        </p>
        <p v-if="hoveredTooltip.labels.length" class="mt-0.5 max-w-[220px] truncate text-[11px] text-accent-hi">
          {{ hoveredTooltip.labels.join(' · ') }}
        </p>
        <p v-else class="text-[10px] text-fg-dim/50">未绑定</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.key-rect {
  transition: fill 0.12s ease, stroke 0.12s ease;
}
.key-glow {
  fill: var(--color-accent);
  opacity: 0.25;
  filter: drop-shadow(0 0 6px var(--color-accent));
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.18; }
  50% { opacity: 0.38; }
}
.tooltip-enter-active,
.tooltip-leave-active {
  transition: opacity 0.12s ease;
}
.tooltip-enter-from,
.tooltip-leave-to {
  opacity: 0;
}
</style>
