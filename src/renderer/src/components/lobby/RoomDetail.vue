<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import type { Room, RoomPlayer, ChatMessage } from '@renderer/types/lobby'
import { MP_COLORS, SIDES, TEAMS } from '@renderer/types/lobby'
import MapPreview from '@renderer/components/MapPreview.vue'
import { useMapPreview } from '@renderer/composables/useMapPreview'

const props = defineProps<{
  room: Room
  players?: RoomPlayer[]
  preview?: boolean
  myModSetId?: string
  maps?: string[]
  getMapsForMode?: (mode: string) => string[]
  gameModes?: string[]
  sides?: Array<{ name: string; icon: string }>
  mpColors?: Array<{ name: string; r: number; g: number; b: number; hex: string }>
  roomMessages?: ChatMessage[]
  gamePath?: string
  getMapFilePath?: (displayName: string) => string
  getRandomMapForCount?: (count: number) => string
  selectedTunnel?: string
  /** 自动准备：非房主开启后收到主机 GETREADY 时自动回 R 1 */
  autoReady?: boolean
  iniDropdowns?: Array<{ name: string; label: string; itemLabels: string[]; defaultIndex: number; toolTip: string }>
  iniCheckboxes?: Array<{ name: string; text: string; checked: boolean; toolTip: string }>
  dropdownValues?: Record<string, number>
  checkboxValues?: Record<string, boolean>
  /** ban 随机阵营：banInfo=我的可编辑 chips（indices=覆盖阵营索引，banned=禁用的）；banEnabled=全员launcher */
  banInfo?: { indices: number[]; banned: number[] } | null
  banEnabled?: boolean
  coveredFactions?: (faction: string) => number[]
  randomSelectorCount?: number
  /** 当前地图禁止玩家选的阵营/颜色（下拉索引，来自地图 disallowedPlayerSides/Colors，合作/挑战图 AI 占用） */
  disallowedSides?: number[]
  disallowedColors?: number[]
}>()

const emit = defineEmits<{
  join: []
  back: []
  leave: []
  ready: []
  launch: []
  lock: []
  'update:auto-ready': [value: boolean]
  'update-attr': [playerId: string, attr: Partial<Pick<RoomPlayer, 'color' | 'faction' | 'team' | 'startIndex' | 'aiLevel'>>]
  'update-map': [map: string]
  'update-game-mode': [mode: string]
  'update-option': [name: string, value: number | boolean]
  'ban-update': [indices: number[]]
  'map-request': [mapName: string]
  'map-switch': [mapName: string, mapHash?: string]
  'select-tunnel': [address: string]
  'send-message': [content: string]
  'add-ai': []
  'kick': [playerId: string]
  'ban': [playerId: string]
}>()

const chatInput = ref('')
const chatScrollRef = ref<HTMLDivElement>()
// 掷骰子控件：[骰子数] d [面数]
const diceCount = ref(1)
const diceSides = ref(6)
// 帧发送率下拉（0-10），默认 3（RA2 常见默认值）
const FRAME_SEND_RATE_OPTIONS = Array.from({ length: 11 }, (_, i) => i)
const frameSendRate = ref(props.room.frameSendRate ?? 3)
watch(() => props.room.frameSendRate, (v) => {
  if (v !== undefined) frameSendRate.value = v
})

function rollDice(): void {
  const c = Math.max(1, Math.min(100, Math.floor(diceCount.value) || 1))
  const s = Math.max(1, Math.floor(diceSides.value) || 6)
  emit('send-message', `/roll ${c}d${s}`)
}

function onFrameSendRateChange(): void {
  emit('send-message', `/framesendrate ${frameSendRate.value}`)
}

// ban 随机阵营：具体阵营索引（game 0..N）→ 下拉名 / 旗子图标
function factionNameAt(gameIdx: number): string {
  const i = (props.randomSelectorCount ?? 0) + gameIdx
  return props.sides?.[i]?.name ?? String(gameIdx + 1)
}
function factionIconAt(gameIdx: number): string {
  const i = (props.randomSelectorCount ?? 0) + gameIdx
  return props.sides?.[i]?.icon ?? ''
}
function toggleBan(idx: number): void {
  if (!props.banInfo) return
  const banned = [...props.banInfo.banned]
  const at = banned.indexOf(idx)
  if (at >= 0) {
    banned.splice(at, 1)
  } else {
    if (banned.length >= props.banInfo.indices.length - 1) return // 至少保留 1 个可随机
    banned.push(idx)
  }
  emit('ban-update', banned)
}
/** 某玩家的阵营是不是 Random/选择器（需要显示 ban 状态） */
function isRandomSide(p: RoomPlayer): boolean {
  const covered = props.coveredFactions?.(p.faction) ?? []
  return covered.length > 0
}

const mapSearch = ref('')
const selectedMap = ref(props.room.map || '')
const rightTab = ref<'maps' | 'options'>('maps')
const roomLocked = computed(() => !!props.room.isLocked)
const currentGameMode = ref(props.room.gameMode || props.gameModes?.[0] || '')

// ─── 左侧下方当前地图预览高度（初始 500px，分隔线可拖调整）───
const previewHeight = ref(500)
const previewDragging = ref(false)
let splitDragStartY = 0
let splitDragStartPos = 0

function onSplitMouseDown(e: MouseEvent) {
  previewDragging.value = true
  splitDragStartY = e.clientY
  splitDragStartPos = previewHeight.value
  document.addEventListener('mousemove', onSplitMouseMove)
  document.addEventListener('mouseup', onSplitMouseUp)
  e.preventDefault()
}
function onSplitMouseMove(e: MouseEvent) {
  if (!previewDragging.value) return
  const delta = e.clientY - splitDragStartY
  previewHeight.value = Math.max(200, Math.min(700, splitDragStartPos - delta))
}
function onSplitMouseUp() {
  previewDragging.value = false
  document.removeEventListener('mousemove', onSplitMouseMove)
  document.removeEventListener('mouseup', onSplitMouseUp)
}

// 当 gameModes 数据加载完成后，如果当前模式为空就自动选第一个
watch(() => props.gameModes, (modes) => {
  if (modes?.length && !currentGameMode.value) {
    currentGameMode.value = modes[0]
  }
}, { immediate: true })

const isHost = computed(() => props.players?.some(p => p.id === 'current' && p.isHost) ?? false)
const me = computed(() => props.players?.find(p => p.id === 'current') ?? null)
/** 房主启动按钮可用性：需已锁定 + 全员就绪 + （≥2 人类时）已选隧道，对齐 hostLaunch 校验 */
const canLaunch = computed(() => {
  if (!isHost.value) return true
  if (!props.room.isLocked) return false
  const notReady = props.players?.filter(p => p.id !== 'current' && !p.isReady) ?? []
  if (notReady.length > 0) return false
  const humans = props.players?.filter(p => !p.isAI) ?? []
  if (humans.length >= 2 && !props.selectedTunnel) return false
  return true
})
/** 禁用原因（按钮 tooltip） */
const launchDisabledReason = computed(() => {
  if (!isHost.value) return ''
  if (!props.room.isLocked) return '请先锁定房间'
  const notReady = props.players?.filter(p => p.id !== 'current' && !p.isReady) ?? []
  if (notReady.length > 0) return `${notReady.length} 名玩家未准备`
  const humans = props.players?.filter(p => !p.isAI) ?? []
  if (humans.length >= 2 && !props.selectedTunnel) return '请先选择隧道服务器'
  return ''
})

const { previewData, loading: previewLoading, loadPreview, clearPreview } = useMapPreview()
// 地图悬停预览：独立置顶窗口（跟随鼠标，可显示到应用窗口外，对齐大厅房间悬停）
const hoverMap = ref('')
const HOVER_W = 400
const HOVER_H = 300
let hoverClearTimer: ReturnType<typeof setTimeout> | null = null

function showMapHover(m: string, imageUrl: string): void {
  window.api.mapPreview.show({
    mode: 'map',
    imageUrl,
    mapName: m,
    imgW: HOVER_W,
    imageHeight: HOVER_H
  })
}

function onMapHover(m: string): void {
  if (hoverClearTimer) clearTimeout(hoverClearTimer)
  hoverMap.value = m
  if (!props.gamePath || !props.getMapFilePath) {
    showMapHover(m, '')
    return
  }
  window.api.mapPreview.load(props.gamePath, props.getMapFilePath(m))
    .then((data) => {
      if (hoverMap.value !== m) return // 已移开，忽略过期加载
      showMapHover(m, data?.previewDataUrl ?? '')
    })
    .catch(() => {
      if (hoverMap.value === m) showMapHover(m, '')
    })
}
// 跟随鼠标：节流触发主进程按当前光标点重定位（主进程读屏幕光标，无需传坐标）
let lastHoverMoveTime = 0
function onMapHoverMove(): void {
  if (!hoverMap.value) return
  const now = performance.now()
  if (now - lastHoverMoveTime < 30) return
  lastHoverMoveTime = now
  window.api.mapPreview.move()
}
function onMapHoverLeave(): void {
  if (hoverClearTimer) clearTimeout(hoverClearTimer)
  hoverClearTimer = setTimeout(() => {
    hoverMap.value = ''
    window.api.mapPreview.hide()
  }, 100)
}
/** 玩家点地图"想玩"请求：限流 1000ms 一次，避免连点刷屏 */
let lastMapRequestTime = 0
function onMapClick(m: string): void {
  if (isHost.value) return // 房主用双击选图
  const now = Date.now()
  if (now - lastMapRequestTime < 1000) return
  lastMapRequestTime = now
  emit('map-request', m)
}
/** 房主双击选图 */
function onMapDblClick(m: string): void {
  if (!isHost.value) return
  selectMap(m)
}

// ─── 点地图选出生点 ──────────────────────────────
/** waypoint → 玩家索引（用于在地图上给出生点着色） */
const assignedLocations = computed(() => {
  const map: Record<number, number> = {}
  ;(props.players ?? []).forEach((p, i) => {
    if (p.startIndex != null && p.startIndex >= 0) map[p.startIndex + 1] = i
  })
  return map
})

/** 点击地图上的出生点标记 → 设置我的出生位置（waypoint 是 1 基，startIndex 0 基） */
function pickStartLocation(waypoint: number): void {
  if (!me.value) return
  emit('update-attr', 'current', { startIndex: waypoint - 1 })
}

watch(selectedMap, async (mapName) => {
  if (!mapName || !props.gamePath) { clearPreview(); return }
  const filePath = props.getMapFilePath ? props.getMapFilePath(mapName) : mapName
  await loadPreview(props.gamePath, filePath)
}, { immediate: true })

// 房主换图（GO 广播更新 room.map）→ selectedMap 跟随，重新加载预览/显示新图
watch(() => props.room.map, (m) => {
  if (m && m !== selectedMap.value) {
    selectedMap.value = m
  }
})

// ─── 选项配置 ──────────────────────────────────────
// 地图禁止项（合作/挑战图 AI 占用）→ 禁用对应下拉项（disallowed 是下拉索引）
const disallowedSideSet = computed(() => new Set(props.disallowedSides ?? []))
const disallowedColorSet = computed(() => new Set(props.disallowedColors ?? []))
const colorOptions = computed(() => {
  const list = (props.mpColors ?? []).map((c, i) => ({ value: c.hex, label: c.name, disabled: disallowedColorSet.value.has(i) }))
  return list.length ? list : [{ value: '', label: 'Random', disabled: false }]
})
const sideOptions = computed(() => (props.sides ?? []).map((s, i) => ({ value: s.name, label: s.name, icon: s.icon, disabled: disallowedSideSet.value.has(i) })))
const teamOptions = TEAMS

function getSideIcon(faction: string): string {
  const found = (props.sides ?? []).find(s => s.name === faction)
  return found?.icon ?? ''
}
// 出生点选项数 = 当前地图可选的起始位置数（挑战/合作图只有人类可选的位置，如 2 个就只给 1/2）
const startOptions = computed(() => {
  const n = Math.max(1, Math.min(8, previewData.value?.startingLocations?.length ?? 8))
  return [{ value: 0, label: '-' }, ...Array.from({ length: n }, (_, i) => ({ value: i + 1, label: `${i + 1}` }))]
})
const mapOptions = computed(() => {
  let list: string[]
  if (props.getMapsForMode && currentGameMode.value) {
    const filtered = props.getMapsForMode(currentGameMode.value)
    console.log('[mapOptions] mode:', currentGameMode.value, 'filtered:', filtered.length, 'of', (props.maps ?? []).length)
    list = filtered
  } else {
    list = props.maps ?? []
  }
  if (!mapSearch.value) return list
  const q = mapSearch.value.toLowerCase()
  return list.filter(m => m.toLowerCase().includes(q))
})

// 游戏选项（复选框/下拉）由 useLobby 加载并通过 props 传入，改动 emit 到上层广播 GO

// 上一张图（房主随机换图后可快速切回）
const prevMap = ref('')
// 随机地图人数下拉：0 = 当前房间人数，2-8 = 指定人数
const randomMapCount = ref(0)
function selectMap(m: string) {
  if (selectedMap.value === m) return // 地图没变：不重复广播/刷新
  if (selectedMap.value) prevMap.value = selectedMap.value
  selectedMap.value = m
  emit('update-map', m)
}
/** 随机选图按钮：按下拉框选的人数匹配地图（0 表示用当前房间人数） */
function randomMap(): void {
  const currentCount = props.players?.length ?? 0
  const count = randomMapCount.value > 0
    ? randomMapCount.value
    : Math.max(2, Math.min(8, currentCount))
  const picked = props.getRandomMapForCount ? props.getRandomMapForCount(count) : ''
  if (picked) {
    selectMap(picked)
  }
}

// 选择隧道服务器（房主）：名字/负载/测速
interface TunnelItem {
  address: string; port: number; name: string; country: string; countryCode: string
  clients: number; maxClients: number; latency: number; official: boolean
}
const showTunnelModal = ref(false)
const tunnelList = ref<TunnelItem[]>([])
const tunnelLoading = ref(false)
async function loadTunnels(): Promise<void> {
  tunnelLoading.value = true
  try {
    tunnelList.value = (await (window as any).api.tunnel.servers()) ?? []
  } catch {
    tunnelList.value = []
  }
  tunnelLoading.value = false
}
function openTunnelModal(): void {
  showTunnelModal.value = true
  loadTunnels()
}
function pickTunnel(t: TunnelItem): void {
  showTunnelModal.value = false
  emit('select-tunnel', `${t.address}:${t.port}`)
}
function tunnelPing(t: TunnelItem): string {
  return t.latency < Number.MAX_SAFE_INTEGER ? `${t.latency}ms` : '—'
}

function onGameModeChange(mode: string) {
  currentGameMode.value = mode
  emit('update-game-mode', mode)
  // 切换模式后自动选该模式第一张地图
  const maps = mapOptions.value
  if (maps.length > 0) {
    selectMap(maps[0])
  }
}

// 当 mapOptions 更新且 selectedMap 为空时，自动选第一张
watch(mapOptions, (opts) => {
  if (opts.length && !selectedMap.value) {
    selectMap(opts[0])
  }
}, { immediate: true })

function toggleReady() { emit('ready') }
function sendChat() {
  if (!chatInput.value.trim()) return
  emit('send-message', chatInput.value.trim())
  chatInput.value = ''
}

watch(() => props.roomMessages?.length, async () => {
  await nextTick()
  if (chatScrollRef.value) chatScrollRef.value.scrollTop = chatScrollRef.value.scrollHeight
})

// 离开房间视图时隐藏外部预览窗（可能在悬停中）
onUnmounted(() => {
  window.api.mapPreview.hide()
})
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    <!-- 主体 -->
    <div class="flex min-h-0 flex-1">
      <!-- 左侧：玩家表 + 分隔线 + 地图预览 -->
      <div id="left-panel" class="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-line">
        <!-- 玩家表（预览固定高后，玩家表占剩余空间） -->
        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <div class="mb-2 flex items-center justify-between">
            <p class="text-[12px] text-fg-dim">房间成员 ({{ players?.length ?? 0 }}/{{ room.maxPlayers }})</p>
            <button
              v-if="isHost"
              class="shrink-0 border border-line px-2 py-0.5 text-[10px] text-fg-dim transition-colors hover:bg-white/5 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
              :disabled="(players?.length ?? 0) >= 8"
              :title="(players?.length ?? 0) >= 8 ? '玩家总数已达上限 8 人' : '添加一个 AI 玩家（最多 8 人）'"
              @click="emit('add-ai')"
            >＋ 添加 AI</button>
          </div>
          <div class="mb-1 flex items-center border-b border-line text-[10px] text-fg-dim">
            <div class="w-[120px] px-1 py-1">玩家</div>
            <div class="w-[120px] px-1 py-1">阵营</div>
            <div class="w-[100px] px-1 py-1">颜色</div>
            <div class="w-[50px] px-1 py-1 text-center">队伍</div>
            <div class="w-[50px] px-1 py-1 text-center">位置</div>
            <div class="w-[40px] px-1 py-1 text-center">状态</div>
            <div class="w-[42px] shrink-0 px-1 py-1 text-right">延迟</div>
          </div>
          <div v-for="player in players" :key="player.id" class="flex items-center border-b border-line/30 py-1.5 text-[12px]" :class="player.id === 'current' ? 'bg-accent/10' : ''">
            <div class="w-[120px] truncate px-1">
              <span v-if="player.isAI" class="text-fg-dim italic">[AI] {{ player.name }}</span>
              <span v-else-if="player.id === 'current'" class="font-medium text-accent">{{ player.name }}</span>
              <span v-else class="text-fg">{{ player.name }}</span>
            </div>
            <div class="w-[120px] px-1">
              <div class="flex items-center gap-1">
                <img v-if="getSideIcon(player.faction)" :src="getSideIcon(player.faction)" class="h-4 w-4 shrink-0 object-contain" />
                <select
                  :value="player.faction"
                  :disabled="player.id !== 'current' && !isHost"
                  class="min-w-0 flex-1 border border-line bg-bg px-1 py-0.5 text-[11px] disabled:opacity-50"
                  @change="emit('update-attr', player.id, { faction: ($event.target as HTMLSelectElement).value })"
                >
                  <option v-for="s in sideOptions" :key="s.value" :value="s.value" :disabled="s.disabled">{{ s.label }}</option>
                </select>
              </div>
              <!-- 其他 launcher 也能看到该玩家的禁用阵营（灰色旗子，只读，仅本人可改） -->
              <div
                v-if="banEnabled && isRandomSide(player) && player.bannedFactions?.length"
                class="mt-0.5 flex items-center gap-0.5"
                title="禁用的随机阵营（仅本人可修改）"
              >
                <span class="text-[9px] text-fg-dim">禁:</span>
                <img
                  v-for="idx in player.bannedFactions"
                  :key="idx"
                  :src="factionIconAt(idx)"
                  class="h-3.5 w-3.5 object-contain opacity-40 grayscale"
                  :alt="factionNameAt(idx)"
                />
              </div>
            </div>
            <div class="w-[100px] px-1">
              <div class="flex items-center gap-1">
                <div class="h-3 w-3 shrink-0 border border-line" :style="{ backgroundColor: player.color || '#808080' }"></div>
                <select
                  :value="player.color"
                  :disabled="player.id !== 'current' && !isHost"
                  class="min-w-0 flex-1 border border-line bg-bg px-1 py-0.5 text-[11px] disabled:opacity-50"
                  @change="emit('update-attr', player.id, { color: ($event.target as HTMLSelectElement).value })"
                >
                  <option v-for="c in colorOptions" :key="c.value" :value="c.value" :disabled="c.disabled">{{ c.label }}</option>
                </select>
              </div>
            </div>
            <div class="w-[50px] px-1">
              <select
                :value="player.team"
                :disabled="player.id !== 'current' && !isHost"
                class="w-full border border-line bg-bg px-1 py-0.5 text-[11px] disabled:opacity-50"
                @change="emit('update-attr', player.id, { team: ($event.target as HTMLSelectElement).value })"
              >
                <option v-for="t in teamOptions" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>
            <div class="w-[50px] px-1">
              <select
                :value="player.startIndex + 1"
                :disabled="player.id !== 'current' && !isHost"
                class="w-full border border-line bg-bg px-1 py-0.5 text-[11px] disabled:opacity-50"
                @change="emit('update-attr', player.id, { startIndex: +($event.target as HTMLSelectElement).value - 1 })"
              >
                <option v-for="s in startOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </div>
            <div class="w-[40px] px-1 text-center">
              <span v-if="player.isReady" class="text-[11px] text-green-500">&#10003;</span>
              <span v-else class="text-[11px] text-fg-dim">&mdash;</span>
            </div>
            <!-- AI 难度（房主可改，1=简单 2=普通 3=困难） -->
            <div v-if="player.isAI" class="w-[52px] shrink-0 px-1 text-center">
              <select
                :value="player.aiLevel ?? 2"
                :disabled="!isHost"
                class="w-full border border-line bg-bg px-0.5 py-0.5 text-[10px] disabled:opacity-50"
                title="AI 难度（房主设置）"
                @change="emit('update-attr', player.id, { aiLevel: +($event.target as HTMLSelectElement).value })"
              >
                <option :value="1">简单</option>
                <option :value="2">普通</option>
                <option :value="3">困难</option>
              </select>
            </div>
            <!-- 延迟（launcher 专属 L-PING 上报） -->
            <div class="w-[42px] shrink-0 px-1 text-right">
              <span
                v-if="player.ping !== undefined"
                class="text-[10px]"
                :class="player.ping > 100 ? 'text-yellow-500' : 'text-green-500'"
                :title="`到隧道服务器的延迟 ${player.ping}ms`"
              >{{ player.ping }}ms</span>
              <span v-else class="text-[10px] text-fg-dim">&mdash;</span>
            </div>
            <!-- 房主踢出/封禁（不能踢房主自己或 AI），放最右边 -->
            <div v-if="isHost && !player.isHost && !player.isAI" class="w-[44px] shrink-0 px-1 text-center">
              <button class="text-[11px] text-fg-dim transition-colors hover:text-red-400" title="踢出该玩家" @click="emit('kick', player.id)">✕</button>
              <button class="ml-1 text-[10px] text-fg-dim transition-colors hover:text-red-400" title="封禁该玩家" @click="emit('ban', player.id)">⛔</button>
            </div>
          </div>
        </div>

        <!-- ban 随机阵营 chips（选中 Random/任一X 且全员 launcher 时显示，自己可编辑；旗子显示） -->
        <div v-if="banInfo && banEnabled && banInfo.indices.length" class="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1.5">
          <span class="text-[10px] text-fg-dim">随机禁用:</span>
          <button
            v-for="idx in banInfo.indices"
            :key="idx"
            class="border p-0.5 transition-colors"
            :class="banInfo.banned.includes(idx) ? 'border-line opacity-30 hover:opacity-60' : 'border-accent/60 hover:bg-accent/10'"
            :title="banInfo.banned.includes(idx) ? `恢复 ${factionNameAt(idx)}` : `禁用 ${factionNameAt(idx)}`"
            @click="toggleBan(idx)"
          >
            <img v-if="factionIconAt(idx)" :src="factionIconAt(idx)" class="h-5 w-5 object-contain" :class="banInfo.banned.includes(idx) ? 'grayscale' : ''" />
            <span v-else class="px-1 text-[10px] text-fg">{{ factionNameAt(idx) }}</span>
          </button>
        </div>

        <!-- 拖拽分隔线（调当前地图预览高度） -->
        <div
          class="flex h-1.5 shrink-0 cursor-row-resize items-center justify-center transition-colors hover:bg-accent/30"
          :class="previewDragging ? 'bg-accent/40' : 'bg-line/50'"
          @mousedown="onSplitMouseDown"
        >
          <div class="h-0.5 w-8 rounded-full bg-fg-dim/30"></div>
        </div>

        <!-- 当前地图预览（固定高 previewHeight，初始 500px） -->
        <div class="flex shrink-0 flex-col border-t border-line px-3 py-2" :style="{ height: previewHeight + 'px' }">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] text-fg-dim">{{ room.map }}</span>
            <span class="text-[10px] text-fg-dim">{{ room.gameMode }}</span>
          </div>
          <div class="flex min-h-0 flex-1 items-center justify-center border border-line bg-bg">
            <MapPreview
              v-if="previewData?.previewAvailable"
              :preview-path="previewData.previewPath"
              :preview-data-url="previewData.previewDataUrl"
              :starting-locations="previewData.startingLocations"
              :assigned-locations="assignedLocations"
              :map-width="previewData.mapWidth"
              :map-height="previewData.mapHeight"
              :briefing="previewData.briefing"
              :is-coop="previewData.isCoop"
              @location-click="pickStartLocation"
            />
            <span v-else-if="previewLoading" class="text-[12px] text-fg-dim">加载中...</span>
            <span v-else class="text-[12px] text-fg-dim">{{ room.map }}</span>
          </div>
        </div>
      </div>

      <!-- 右侧：Tab + 聊天 -->
      <div class="flex w-[320px] min-w-0 shrink-0 flex-col overflow-hidden">
        <!-- Tab 栏 -->
        <div class="flex shrink-0 border-b border-line">
          <button
            class="flex-1 px-3 py-1.5 text-[11px] transition-colors"
            :class="rightTab === 'maps' ? 'border-b-2 border-accent text-accent' : 'text-fg-dim hover:text-fg'"
            @click="rightTab = 'maps'"
          >
            地图选择
          </button>
          <button
            class="flex-1 px-3 py-1.5 text-[11px] transition-colors"
            :class="rightTab === 'options' ? 'border-b-2 border-accent text-accent' : 'text-fg-dim hover:text-fg'"
            @click="rightTab = 'options'"
          >
            游戏选项
          </button>
        </div>

        <!-- Tab 内容 -->
        <div class="min-h-0 flex-1 overflow-hidden">
          <!-- 地图选择 tab：全员可见（房主点击选图；非房主点击发"想要玩"请求，悬停看预览） -->
          <div v-if="rightTab === 'maps'" class="flex h-full flex-col overflow-hidden">
            <template v-if="!preview">
              <div class="flex shrink-0 items-center gap-1 px-2 py-1">
                <input
                  v-model="mapSearch"
                  placeholder="搜索地图..."
                  class="flex-1 border border-line bg-bg px-2 py-0.5 text-[11px] outline-none"
                />
                <select
                  v-model="currentGameMode"
                  :disabled="!isHost"
                  class="w-[100px] border border-line bg-bg px-1 py-0.5 text-[10px] disabled:opacity-50"
                  @change="isHost && onGameModeChange(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="m in gameModes" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
              <div class="min-h-0 flex-1 overflow-y-auto">
                <div
                  v-for="m in mapOptions"
                  :key="m"
                  class="cursor-pointer border-b border-line/30 px-2 py-1 text-[11px] transition-colors hover:bg-white/5"
                  :class="m === selectedMap ? 'bg-accent/20 text-accent' : 'text-fg-dim'"
                  @mouseenter="onMapHover(m)"
                  @mousemove="onMapHoverMove"
                  @mouseleave="onMapHoverLeave"
                  @click="onMapClick(m)"
                  @dblclick="onMapDblClick(m)"
                >
                  {{ m }}
                </div>
              </div>
            </template>
            <div v-else class="flex h-full items-center justify-center text-[11px] text-fg-dim">
              观战模式
            </div>
          </div>

          <!-- 游戏选项 tab：非房主只看不能改 -->
          <div v-if="rightTab === 'options'" class="h-full overflow-y-auto px-2 py-2">
            <!-- 下拉选项 -->
            <div class="mb-3 grid grid-cols-2 gap-1">
              <div v-for="dd in (iniDropdowns ?? [])" :key="dd.name">
                <label class="text-[10px] text-fg-dim">{{ dd.label }}</label>
                <select
                  :value="(dropdownValues ?? {})[dd.name] ?? dd.defaultIndex"
                  :disabled="!isHost"
                  class="w-full border border-line bg-bg px-1 py-0.5 text-[11px] disabled:opacity-50"
                  :title="dd.toolTip"
                  @change="emit('update-option', dd.name, +($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="(lbl, idx) in dd.itemLabels" :key="idx" :value="idx">{{ lbl }}</option>
                </select>
              </div>
            </div>
            <!-- 复选框选项 -->
            <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
              <label v-for="cb in (iniCheckboxes ?? [])" :key="cb.name" class="flex items-center gap-1" :title="cb.toolTip">
                <input type="checkbox" :checked="(checkboxValues ?? {})[cb.name]" :disabled="!isHost" @change="emit('update-option', cb.name, ($event.target as HTMLInputElement).checked)" />
                <span class="text-fg-dim">{{ cb.text }}</span>
              </label>
            </div>
          </div>
        </div>

        <!-- 房间聊天（底部固定） -->
        <div v-if="!preview" class="flex shrink-0 flex-col border-t border-line" style="height: 200px">
          <div class="px-2 py-1 text-[11px] text-fg-dim">房间聊天</div>
          <!-- 掷骰子 + 帧发送率（放在聊天布局上方） -->
          <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
            <input v-model.number="diceCount" type="number" min="1" max="100" class="w-9 border border-line bg-bg px-1 py-0.5 text-center text-[10px] text-fg outline-none focus:border-accent" title="骰子数量" />
            <span class="text-[10px] text-fg-dim">d</span>
            <input v-model.number="diceSides" type="number" min="1" max="1000" class="w-11 border border-line bg-bg px-1 py-0.5 text-center text-[10px] text-fg outline-none focus:border-accent" title="骰子面数" />
            <button class="border border-line px-2 py-0.5 text-[10px] text-fg-dim hover:bg-white/5" @click="rollDice" title="掷骰子并广播结果">🎲 掷</button>
            <template v-if="isHost">
              <span class="ml-1 text-[10px] text-fg-dim">帧发送率:</span>
              <select
                v-model="frameSendRate"
                class="border border-line bg-bg px-1 py-0.5 text-[10px] text-fg outline-none focus:border-accent"
                title="改变 FrameSendRate（order lag），广播给所有玩家"
                @change="onFrameSendRateChange"
              >
                <option v-for="n in FRAME_SEND_RATE_OPTIONS" :key="n" :value="n">{{ n }}</option>
              </select>
            </template>
          </div>
          <div ref="chatScrollRef" class="min-h-0 flex-1 overflow-y-auto px-2 py-1">
            <div v-for="msg in (roomMessages ?? [])" :key="msg.id" class="mb-0.5">
              <!-- 想玩的图请求：房主可点击快速切换 -->
              <div v-if="msg.type === 'map-request'" class="py-0.5 text-center">
                <span class="text-[10px] italic text-fg-dim">{{ msg.userName }} 想玩 </span>
                <button
                  v-if="isHost"
                  class="text-[10px] text-accent underline transition-colors hover:text-accent-hi"
                  :title="`点击切换到 ${msg.content}`"
                  @click="emit('map-switch', msg.content, msg.data)"
                >{{ msg.content }}</button>
                <span v-else class="text-[10px] italic text-fg-dim">{{ msg.content }}</span>
              </div>
              <div v-else-if="msg.type !== 'message'" class="py-0.5 text-center text-[10px] text-fg-dim italic">{{ msg.content }}</div>
              <div v-else class="text-[11px] leading-[15px]">
                <span class="text-fg-dim">{{ new Date(msg.timestamp).getHours().toString().padStart(2,'0') }}:{{ new Date(msg.timestamp).getMinutes().toString().padStart(2,'0') }}</span>
                <span class="ml-1 font-medium text-accent">&lt;{{ msg.userName }}&gt;</span>
                <span class="text-fg">{{ msg.content }}</span>
              </div>
            </div>
          </div>
          <div class="flex shrink-0 gap-1 border-t border-line px-2 py-1.5">
            <input v-model="chatInput" placeholder="在这里聊天...（/roll 3d6）" maxlength="150" class="flex-1 border border-line bg-bg px-2 py-0.5 text-[11px] outline-none placeholder:text-fg-dim focus:border-accent" @keyup.enter="sendChat" />
            <button class="bg-accent px-2 py-0.5 text-[11px] text-white hover:bg-accent-hi disabled:opacity-40" :disabled="!chatInput.trim()" @click="sendChat">发送</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部按钮 -->
    <div class="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
      <template v-if="preview">
        <button class="bg-accent px-4 py-1.5 text-[12px] text-white hover:bg-accent-hi" @click="$emit('join')">加入房间</button>
        <button class="border border-line px-4 py-1.5 text-[12px] text-fg-dim hover:bg-white/5" @click="$emit('back')">返回</button>
      </template>
      <template v-else>
        <button
          class="bg-accent px-4 py-1.5 text-[12px] text-white hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="isHost && !canLaunch"
          :title="isHost ? launchDisabledReason : ''"
          @click="isHost ? $emit('launch') : toggleReady()"
        >
          {{ isHost ? '启动游戏' : (me?.isReady ? '取消准备' : '准备') }}
        </button>
        <!-- 自动准备（非房主）：收到主机 GETREADY 时自动回 R 1 -->
        <label v-if="!isHost" class="flex items-center gap-1 text-[11px] text-fg-dim" title="主机要求准备时自动准备">
          <input type="checkbox" :checked="autoReady" @change="$emit('update:auto-ready', ($event.target as HTMLInputElement).checked)" />
          自动准备
        </label>
        <button v-if="isHost" class="border border-line px-3 py-1.5 text-[12px] text-fg-dim hover:bg-white/5" @click="$emit('lock')">
          {{ roomLocked ? '解锁房间' : '锁定房间' }}
        </button>
        <!-- 房主：随机地图按钮 + 人数下拉 + 上一张图 -->
        <template v-if="isHost">
          <button
            class="border border-line px-3 py-1.5 text-[12px] text-fg-dim hover:bg-white/5"
            title="随机选一张当前模式的地图"
            @click="randomMap"
          >🎲 随机地图</button>
          <select
            v-model.number="randomMapCount"
            class="border border-line bg-bg px-1.5 py-1.5 text-[12px]"
            title="随机地图按几人匹配（当前人数=用房间现有玩家数）"
          >
            <option :value="0">当前人数</option>
            <option v-for="n in 7" :key="n" :value="n + 1">{{ n + 1 }} 人</option>
          </select>
          <button
            v-if="prevMap"
            class="border border-line px-3 py-1.5 text-[12px] text-fg-dim hover:bg-white/5"
            title="切回上一张图"
            @click="selectMap(prevMap)"
          >上一张图</button>
        </template>
        <button v-if="isHost" class="border border-line px-3 py-1.5 text-[12px] hover:bg-white/5" :class="selectedTunnel ? 'text-accent' : 'text-fg-dim'" @click="openTunnelModal">
          {{ selectedTunnel ? '服务器 ✓' : '选择服务器' }}
        </button>
        <div class="flex-1"></div>
        <button class="border border-line px-4 py-1.5 text-[12px] text-fg-dim hover:bg-white/5" @click="$emit('leave')">离开房间</button>
      </template>
    </div>

    <!-- 隧道服务器选择（房主） -->
    <div v-if="showTunnelModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="showTunnelModal = false">
      <div class="flex h-[420px] w-[580px] flex-col border border-line bg-panel shadow-xl">
        <div class="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
          <h3 class="text-[13px] font-medium text-fg">选择隧道服务器</h3>
          <button class="text-[14px] text-fg-dim hover:text-fg" @click="showTunnelModal = false">✕</button>
        </div>
        <div class="grid shrink-0 grid-cols-[1fr_70px_90px_40px] items-center gap-1 border-b border-line px-3 py-1 text-[10px] text-fg-dim">
          <span>服务器</span><span class="text-right">负载</span><span class="text-right">测速</span><span></span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <p v-if="tunnelLoading" class="p-4 text-center text-[12px] text-fg-dim">加载中...</p>
          <div
            v-for="t in tunnelList"
            :key="`${t.address}:${t.port}`"
            class="grid cursor-pointer grid-cols-[1fr_70px_90px_40px] items-center gap-1 border-b border-line/30 px-3 py-1.5 text-[11px] hover:bg-white/5"
            :class="selectedTunnel === `${t.address}:${t.port}` ? 'bg-accent/10' : ''"
            @click="pickTunnel(t)"
          >
            <span class="truncate text-fg" :title="`${t.name} (${t.country})`">
              {{ t.name }} <span class="text-fg-dim">[{{ t.countryCode }}]</span>
            </span>
            <span class="text-right text-fg-dim">{{ t.clients }}/{{ t.maxClients }}</span>
            <span class="text-right" :class="t.latency < Number.MAX_SAFE_INTEGER ? 'text-green-500' : 'text-fg-dim'">{{ tunnelPing(t) }}</span>
            <span class="text-center text-[10px] text-accent">{{ selectedTunnel === `${t.address}:${t.port}` ? '✓' : '' }}</span>
          </div>
          <p v-if="!tunnelLoading && !tunnelList.length" class="p-4 text-center text-[12px] text-fg-dim">暂无可用服务器</p>
        </div>
      </div>
    </div>
  </div>
</template>
