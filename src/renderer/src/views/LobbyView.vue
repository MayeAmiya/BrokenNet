<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { Room } from '@renderer/types/lobby'
import { useLobby } from '@renderer/composables/useLobby'
import RoomList from '@renderer/components/lobby/RoomList.vue'
import ChatPanel from '@renderer/components/lobby/ChatPanel.vue'
import RoomDetail from '@renderer/components/lobby/RoomDetail.vue'
import CreateRoomModal from '@renderer/components/lobby/CreateRoomModal.vue'
import PasswordModal from '@renderer/components/lobby/PasswordModal.vue'

const props = defineProps<{ gameId: string; currentModSetId?: string; gamePath?: string }>()
const emit = defineEmits<{ back: [] }>()

const {
  rooms, currentRoom, roomMessages, friends, isLoading,
  chatMode, privateTarget, currentMessages,
  cncnetConnected, onlineCount, playerCount,
  connState, connMessage, connServer, connAttempt, connTotal, connLogs, connAttempts,
  connectCncnet, disconnectCncnet, hostLaunch,
  fetchRooms, createRoom, joinRoom, leaveRoom, sendMessage, fetchFriends, toggleReady,
  addAiPlayer, kickPlayer, banPlayer,
  updatePlayerAttr, updateMap, updateGameMode, toggleLock, updateOption, switchToLobby, switchToRoom, startPrivateChat, stopPrivateChat,
  realDropdowns, realCheckboxes, dropdownValues, checkboxValues,
  isAllLauncher, coveredFactionsForSide, setMyBannedFactions, requestMap, selectTunnel, selectedTunnel, channelError, realRandomSelectorCount,
  getModSets, getMaps, getGameModes, getMapFilePath, getRandomMapForCount, getMapsForMode,
  getDisallowedSides, getDisallowedColors, setChatColor, autoReady, setAutoReady,
  loadRealData, cleanup
} = useLobby()

// 左（房间列表）/右（聊天）比例可拖拽——持久化
const LEFT_WIDTH_KEY = 'lobby-leftwidth'
const leftWidth = ref(Number(localStorage.getItem(LEFT_WIDTH_KEY)) || 480)
watch(leftWidth, (v) => localStorage.setItem(LEFT_WIDTH_KEY, String(v)))
const leftPanelRef = ref<HTMLDivElement>()
let panelResizing = false
let panelStartX = 0
let panelStartWidth = 0
function startPanelResize(e: MouseEvent): void {
  e.preventDefault()
  panelResizing = true
  panelStartX = e.clientX
  panelStartWidth = leftWidth.value
  document.addEventListener('mousemove', onPanelResizeMove)
  document.addEventListener('mouseup', stopPanelResize)
}
function onPanelResizeMove(e: MouseEvent): void {
  if (!panelResizing) return
  // 基于拖拽起始点 + 增量（相对，不受左侧侧边栏偏移影响）
  const delta = e.clientX - panelStartX
  leftWidth.value = Math.max(200, Math.min(700, panelStartWidth + delta))
}
function stopPanelResize(): void {
  panelResizing = false
  document.removeEventListener('mousemove', onPanelResizeMove)
  document.removeEventListener('mouseup', stopPanelResize)
}

// 连接状态显示
const connStatusLabel = computed(() => {
  switch (connState.value) {
    case 1: return '连接中'
    case 2: return `已连接`
    case 3: return '连接失败'
    default: return '未连接'
  }
})
/** 连接日志倒序（最新在最上面，不用滚到底） */
const reversedConnLogs = computed(() => [...connLogs.value].reverse())
const connStatusColor = computed(() => {
  switch (connState.value) {
    case 1: return 'text-yellow-500'
    case 2: return 'text-green-500'
    case 3: return 'text-red-500'
    default: return 'text-fg-dim'
  }
})

const currentView = ref<'lobby' | 'room'>('lobby')
const showCreateModal = ref(false)
const showPasswordModal = ref(false)
const pendingJoinRoom = ref<Room | null>(null)
const passwordError = ref('')
const selectedChatColor = ref('#FFFFFF')

// 从 GameOptions.ini 加载的真实数据
const realSides = ref<Array<{ name: string; icon: string }>>([])
const realMpColors = ref<Array<{ name: string; r: number; g: number; b: number; hex: string }>>([])

const hasRoom = computed(() => !!currentRoom.value)
const inRoom = computed(() => currentView.value === 'room' && !!currentRoom.value)

// ban 随机阵营：我的阵营是 Random/任一X 时给出覆盖的具体阵营 + 当前禁用（自己可编辑）
const allLauncher = computed(() => isAllLauncher())
const myBanInfo = computed(() => {
  const me = currentRoom.value?.players.find(p => p.id === 'current')
  if (!me) return null
  const covered = coveredFactionsForSide(me.faction)
  if (covered.length === 0) return null
  return { indices: covered, banned: me.bannedFactions ?? [] }
})

// 连接详情弹窗
const showConnModal = ref(false)
function connLogColor(kind: string): string {
  if (kind === 'error') return 'text-red-400'
  if (kind === 'success') return 'text-green-500'
  return 'text-fg-dim'
}

// ─── 聊天栏折叠 ──────────────────────────────────────
const chatCollapsed = ref(false)

// ─── 房间悬停预览（独立置顶窗口，跟随鼠标，可在应用窗口外显示）────────────────
const hoverRoom = ref<Room | null>(null)
const hoverPreview = ref<{
  previewPath: string | null
  previewDataUrl: string | null
  mapWidth: number
  mapHeight: number
  startingLocations: Array<{ x: number; y: number; waypoint: number }>
} | null>(null)
/** 悬停预览限高：地图按这个高度等比缩放（宽随地图宽高比） */
const HOVER_IMG_H = 264
/** 图片最大宽度：超宽地图按比例算超过 500 就限制到 500 */
const HOVER_IMG_MAX_W = 500
/** 悬停预览图片区显示宽度（决定外部窗口总宽 = imgW + 200） */
const hoverImgW = computed(() => {
  const mw = hoverPreview.value?.mapWidth ?? 512
  const mh = hoverPreview.value?.mapHeight ?? 384
  const ratio = mw > 0 && mh > 0 ? mw / mh : 4 / 3
  return Math.max(120, Math.min(HOVER_IMG_MAX_W, Math.round(HOVER_IMG_H * ratio)))
})
/** 房间成员归一化（列表里 players 可能是 string[]（纯昵称）或 RoomPlayer[]） */
const hoverRoomPlayers = computed<Array<{ name: string; isHost: boolean }>>(() => {
  const room = hoverRoom.value
  if (!room?.players) return []
  return room.players.map((p) => {
    if (typeof p === 'string') return { name: p, isHost: false }
    return { name: p.name, isHost: p.isHost }
  })
})
let hoverClearTimer: ReturnType<typeof setTimeout> | null = null

/** 用已加载的预览数据 + 当前悬停房间，把内容推给外部预览窗口 */
function showExternalPreview(): void {
  const room = hoverRoom.value
  if (!room) return
  window.api.mapPreview.show({
    mode: 'room',
    imageUrl: hoverPreview.value?.previewDataUrl ?? '',
    roomName: room.name,
    mapName: room.map,
    playerCount: room.players?.length ?? 0,
    maxPlayers: room.maxPlayers,
    members: hoverRoomPlayers.value,
    imgW: hoverImgW.value
  })
}

async function onRoomHover(room: Room): Promise<void> {
  if (hoverClearTimer) clearTimeout(hoverClearTimer)
  hoverRoom.value = room
  const latest = rooms.value.find((r) => r.id === room.id) ?? room
  if (!props.gamePath) { showExternalPreview(); return }
  try {
    const data = await window.api.mapPreview.load(props.gamePath, getMapFilePath(latest.map), latest.mapHash)
    hoverPreview.value = data
  } catch {
    hoverPreview.value = null
  }
  showExternalPreview()
}

/** 主动隐藏外部预览（清状态 + 隐藏窗口）：用于 mouseleave 不触发的场景（进房间/房间消失） */
function hideExternalPreview(): void {
  hoverRoom.value = null
  hoverPreview.value = null
  window.api.mapPreview.hide()
}

// 跟随鼠标：节流触发主进程按当前光标点重定位（主进程读屏幕光标，无需传坐标）
let lastHoverMoveTime = 0
function onRoomHoverMove(): void {
  if (!hoverRoom.value) return
  // 悬停的房间已从列表消失（关闭/刷新/过期）→ 隐藏（行被移除不会触发 mouseleave）
  if (!rooms.value.some(r => r.id === hoverRoom.value!.id)) {
    hideExternalPreview()
    return
  }
  const now = performance.now()
  if (now - lastHoverMoveTime < 30) return
  lastHoverMoveTime = now
  window.api.mapPreview.move()
}

function onRoomHoverEnd(): void {
  // 延迟隐藏，避免行间快速移动时预览闪烁
  if (hoverClearTimer) clearTimeout(hoverClearTimer)
  hoverClearTimer = setTimeout(hideExternalPreview, 100)
}

// 进入房间视图（点击加入）→ 隐藏外部预览：此时鼠标没移出列表，mouseleave 不触发
watch(inRoom, (v) => {
  if (v) hideExternalPreview()
})
// 兜底：悬停的房间从列表被移除（关闭/过期扫描，filter 重建数组）→ 隐藏
watch(rooms, () => {
  if (hoverRoom.value && !rooms.value.some(r => r.id === hoverRoom.value!.id)) hideExternalPreview()
})

// 切游戏（MO ↔ 绝命时刻）时 LobbyView 复用，gameId 变化要重新 join 对应频道
watch(() => props.gameId, (newId, oldId) => {
  if (newId && newId !== oldId) {
    // 清掉上一个游戏的房间（否则切游戏后还停留在旧房间视图）
    if (currentRoom.value) {
      leaveRoom()
      currentView.value = 'lobby'
    }
    // 只在确实变化时切换频道；连接本身保持不断
    connectCncnet(props.gamePath, newId, props.currentModSetId)
    fetchRooms(newId)
    fetchFriends()
  }
})

onMounted(async () => {
  connectCncnet(props.gamePath, props.gameId, props.currentModSetId)
  // 切回 tab 时若仍在房间内（cleanup 保留 currentRoom），直接回到房间视图
  if (currentRoom.value) currentView.value = 'room'
  // 切回 tab 时房间数据已在（cleanup 保留 rooms，监听持续），不重复刷新；
  // 仅当房间为空（首次进入）才加载
  if (rooms.value.length === 0) {
    try { await fetchRooms(props.gameId) } catch (e) { console.error('fetchRooms failed:', e) }
  }
  try { await fetchFriends() } catch (e) { console.error('fetchFriends failed:', e) }
  if (props.gamePath) {
    await loadRealData(props.gamePath)
    // 加载真实阵营/颜色
    if ((window as any).api?.mpLobbyOptions?.load) {
      try {
        const opts = await (window as any).api.mpLobbyOptions.load(props.gamePath)
        console.log('[mpLobbyOptions] sides:', opts.sides.length, 'colors:', opts.mpColors.length, 'dropdowns:', opts.dropdowns.length, 'checkboxes:', opts.checkboxes.length)
        realSides.value = opts.sides
        realMpColors.value = opts.mpColors
      } catch (e) { console.error('mpLobbyOptions load failed:', e) }
    }
  }
})

onUnmounted(() => {
  stopPanelResize()
  cleanup()
  // 离开大厅视图时隐藏外部预览窗（可能在悬停中）
  window.api.mapPreview.hide()
})

async function onRoomJoin(room: Room): Promise<void> {
  // 点加入（可能带密码弹窗/直接进房间）时立即隐藏外部预览，不等 mouseleave
  hideExternalPreview()
  if (currentRoom.value) return
  if (room.hasPassword) {
    pendingJoinRoom.value = room
    passwordError.value = ''
    showPasswordModal.value = true
  } else {
    const r = await joinRoom(room)
    if (r.ok) currentView.value = 'room'
  }
}

async function onPasswordSubmit(password: string): Promise<void> {
  if (!pendingJoinRoom.value) return
  const r = await joinRoom(pendingJoinRoom.value, password)
  if (r.ok) {
    showPasswordModal.value = false
    currentView.value = 'room'
  } else {
    passwordError.value = r.error ?? '密码错误'
  }
}

async function onLeaveRoom(): Promise<void> {
  await leaveRoom()
  currentView.value = 'lobby'
}

function onBack(): void {
  if (currentRoom.value) { onLeaveRoom() } else { emit('back') }
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <!-- 顶栏：面包屑 -->
    <div class="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
      <div class="flex items-center gap-2">
        <button class="text-[12px] text-fg-dim hover:text-fg" @click="onBack">← 返回</button>
        <span class="text-fg-dim">/</span>
        <template v-if="currentRoom">
          <button class="text-[13px] font-medium" :class="!inRoom ? 'text-accent' : 'text-fg-dim hover:text-fg'" @click="currentView = 'lobby'">多人游戏大厅</button>
          <span class="text-fg-dim">/</span>
          <button class="text-[13px]" :class="inRoom ? 'font-medium text-fg' : 'text-fg-dim hover:text-fg'" @click="currentView = 'room'">{{ currentRoom.name }}</button>
          <span class="text-[11px] ml-2" :class="currentRoom.status === 'in-game' ? 'text-yellow-500' : 'text-green-500'">
            {{ currentRoom.status === 'in-game' ? '游戏中' : '等待中' }}
          </span>
        </template>
        <span v-else class="text-[13px] font-medium text-fg">多人游戏大厅</span>
      </div>
      <!-- 顶栏：简单连接状态 + 在线数（详细状态在聊天区横幅） -->
      <span class="flex items-center gap-1.5 text-[11px]" :class="connStatusColor">
        <span
          class="inline-block h-2 w-2 rounded-full"
          :class="{
            'bg-yellow-500 animate-pulse': connState === 1,
            'bg-green-500': connState === 2,
            'bg-red-500': connState === 3,
            'bg-gray-500': connState === 0
          }"
        />
        {{ connStatusLabel }}
        <span v-if="connState === 2" class="text-fg-dim">CnCNet 在线: {{ playerCount ?? 'N/A' }}</span>
      </span>
    </div>

    <!-- 主内容区 -->
    <div v-if="inRoom && currentRoom" class="flex min-h-0 flex-1">
      <RoomDetail :room="currentRoom" :players="currentRoom.players" :my-mod-set-id="currentModSetId" :maps="getMaps()" :get-maps-for-mode="getMapsForMode" :game-modes="getGameModes()" :sides="realSides" :mp-colors="realMpColors" :room-messages="roomMessages" :game-path="gamePath" :get-map-file-path="getMapFilePath" :ini-dropdowns="realDropdowns" :ini-checkboxes="realCheckboxes" :dropdown-values="dropdownValues" :checkbox-values="checkboxValues" :ban-info="myBanInfo" :ban-enabled="allLauncher" :covered-factions="coveredFactionsForSide" :random-selector-count="realRandomSelectorCount" :get-random-map-for-count="getRandomMapForCount" :selected-tunnel="selectedTunnel" :auto-ready="autoReady" :disallowed-sides="getDisallowedSides()" :disallowed-colors="getDisallowedColors()" @leave="onLeaveRoom" @ready="toggleReady" @update-attr="updatePlayerAttr" @update-map="updateMap" @update-game-mode="updateGameMode" @update-option="updateOption" @ban-update="setMyBannedFactions" @map-request="requestMap" @map-switch="updateMap" @select-tunnel="selectTunnel" @update:auto-ready="setAutoReady" @lock="toggleLock" @send-message="sendMessage" @add-ai="addAiPlayer" @kick="kickPlayer" @ban="banPlayer" @launch="hostLaunch(gamePath ?? '', props.gameId, currentModSetId ?? 'vanilla')" />
    </div>
    <div v-else class="flex min-h-0 flex-1">
      <div ref="leftPanelRef" class="flex min-h-0 shrink-0 flex-col" :style="chatCollapsed ? { width: '100%' } : { width: leftWidth + 'px' }">
        <RoomList
          :rooms="rooms"
          :is-loading="isLoading"
          :chat-collapsed="chatCollapsed"
          @join="onRoomJoin"
          @create="showCreateModal = true"
          @refresh="fetchRooms(props.gameId)"
          @toggle-chat="chatCollapsed = !chatCollapsed"
          @hover="onRoomHover"
          @hover-move="onRoomHoverMove"
          @hover-end="onRoomHoverEnd"
        />
      </div>
      <!-- 可拖拽分隔线（房间列表 / 聊天比例）；聊天收起时不显示 -->
      <div v-if="!chatCollapsed" class="w-1 shrink-0 cursor-col-resize bg-line/40 hover:bg-accent/50 transition-colors" title="拖动调整比例" @mousedown="startPanelResize" />
      <div v-if="!chatCollapsed" class="flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- 连接状态横幅：常驻聊天区顶部，实时刷新，点击查看详细日志 -->
        <div
          class="flex shrink-0 cursor-pointer items-center gap-2 border-b border-line px-3 py-1.5 transition-colors hover:bg-panel-alt"
          :class="{
            'bg-yellow-500/10': connState === 1,
            'bg-red-500/10': connState === 3 || !!channelError,
            'bg-green-500/10': connState === 2 && !channelError,
            'bg-transparent': connState === 0
          }"
          @click="showConnModal = true"
        >
          <span
            class="inline-block h-2 w-2 shrink-0 rounded-full"
            :class="{
              'bg-yellow-500 animate-pulse': connState === 1,
              'bg-green-500': connState === 2 && !channelError,
              'bg-red-500': connState === 3 || !!channelError,
              'bg-gray-500': connState === 0
            }"
          />
          <span class="shrink-0 text-[12px] font-medium" :class="channelError ? 'text-red-500' : connStatusColor">{{ channelError ? '频道异常' : connStatusLabel }}</span>

          <!-- 连接中：显示正在尝试的服务器 + 进度 + 取消 -->
          <template v-if="connState === 1">
            <span class="min-w-0 flex-1 truncate text-[11px] text-fg-dim">
              正在连接 {{ connServer }} ({{ connAttempt }}/{{ connTotal }})...
            </span>
            <button class="shrink-0 border border-line px-2 py-0.5 text-[11px] text-fg-dim hover:text-fg" @click.stop="disconnectCncnet">
              取消
            </button>
          </template>
          <!-- 已连接：可手动断开 -->
          <template v-else-if="connState === 2">
            <template v-if="channelError">
              <!-- 频道加入失败（如被拉黑）：红字提示，不显示误导性的绿色状态 -->
              <span class="min-w-0 flex-1 truncate text-[11px] text-red-400" :title="channelError">{{ channelError }}</span>
            </template>
            <template v-else>
              <span class="min-w-0 flex-1 truncate text-[11px] text-fg-dim">
                CnCNet 在线 {{ playerCount ?? 'N/A' }} · 房间 {{ onlineCount }} · 可创建或加入
              </span>
            </template>
            <button class="shrink-0 border border-red-500/50 px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10" @click.stop="disconnectCncnet">
              断开
            </button>
          </template>
          <!-- 失败：显示原因 + 重连按钮 -->
          <template v-else-if="connState === 3">
            <span class="min-w-0 flex-1 truncate text-[11px] text-red-400" :title="connMessage">
              连接失败: {{ connMessage }}
            </span>
            <button class="shrink-0 bg-accent px-2 py-0.5 text-[11px] text-white hover:bg-accent-hi" @click.stop="connectCncnet(props.gamePath, props.gameId, props.currentModSetId)">
              重连
            </button>
          </template>
          <!-- 未连接：手动连接按钮 -->
          <template v-else>
            <span class="flex-1 truncate text-[11px] text-fg-dim">尚未连接服务器</span>
            <button class="shrink-0 bg-accent px-2 py-0.5 text-[11px] text-white hover:bg-accent-hi" @click.stop="connectCncnet(props.gamePath, props.gameId, props.currentModSetId)">
              连接
            </button>
          </template>
        </div>

        <ChatPanel :messages="currentMessages" :has-room="hasRoom" :chat-color="selectedChatColor" @send="sendMessage" @update-color="(c) => { selectedChatColor = c; setChatColor(c) }" />
      </div>
    </div>

    <!-- 底栏 -->
    <div v-if="!inRoom && !currentRoom" class="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2">
      <button class="bg-accent px-4 py-1.5 text-[12px] text-white hover:bg-accent-hi" @click="showCreateModal = true">创建房间</button>
      <div class="flex-1"></div>
      <button class="border border-line px-4 py-1.5 text-[12px] text-fg-dim hover:bg-white/5" @click="emit('back')">返回</button>
    </div>
    <div v-if="!inRoom && currentRoom" class="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2">
      <button class="bg-accent px-4 py-1.5 text-[12px] text-white hover:bg-accent-hi" @click="currentView = 'room'">返回房间</button>
      <div class="flex-1"></div>
      <button class="border border-line px-4 py-1.5 text-[12px] text-fg-dim hover:bg-white/5" @click="emit('back')">返回</button>
    </div>

    <CreateRoomModal v-if="showCreateModal" :game-id="gameId" :mod-set-id="currentModSetId" :maps="getMaps()" :game-modes="getGameModes()" @close="showCreateModal = false" @create="async (p) => { await createRoom({ ...p, gameId: props.gameId }); showCreateModal = false; currentView = 'room' }" />
    <PasswordModal v-if="showPasswordModal" :room-name="pendingJoinRoom?.name ?? ''" :error="passwordError" @submit="onPasswordSubmit" @close="showPasswordModal = false" />

    <!-- 连接详情弹窗 -->
    <div v-if="showConnModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="showConnModal = false">
      <div class="flex h-[420px] w-[520px] flex-col border border-line bg-panel shadow-xl">
        <!-- 标题栏 -->
        <div class="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
          <div class="flex items-center gap-2">
            <span
              class="inline-block h-2 w-2 rounded-full"
              :class="{
                'bg-yellow-500 animate-pulse': connState === 1,
                'bg-green-500': connState === 2,
                'bg-red-500': connState === 3,
                'bg-gray-500': connState === 0
              }"
            />
            <h3 class="text-[13px] font-medium text-fg">连接状态</h3>
            <span class="text-[12px]" :class="connStatusColor">{{ connStatusLabel }}</span>
            <span v-if="connState === 1" class="text-[11px] text-fg-dim">{{ connServer }} ({{ connAttempt }}/{{ connTotal }})</span>
          </div>
          <button class="text-[14px] text-fg-dim hover:text-fg" @click="showConnModal = false">✕</button>
        </div>

        <!-- 服务器尝试列表（重试进度） -->
        <div v-if="connAttempts.length" class="max-h-[140px] shrink-0 overflow-y-auto border-b border-line px-4 py-2">
          <div v-for="a in connAttempts" :key="a.server" class="flex items-center gap-2 py-0.5 text-[11px]">
            <span
              class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              :class="{
                'bg-yellow-500 animate-pulse': a.status === 'trying',
                'bg-green-500': a.status === 'ok',
                'bg-red-500': a.status === 'failed'
              }"
            />
            <span class="min-w-0 flex-1 truncate text-fg">{{ a.server }}</span>
            <span class="shrink-0 text-fg-dim">
              {{ a.status === 'trying' ? '尝试中...' : a.status === 'ok' ? '成功' : '失败' }}
            </span>
          </div>
        </div>

        <!-- 日志列表（倒序：最新在最上面） -->
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono">
          <div v-for="log in reversedConnLogs" :key="log.id" class="flex gap-2 py-0.5 text-[11px] leading-[15px]">
            <span class="shrink-0 text-fg-dim/60">{{ log.time }}</span>
            <span :class="connLogColor(log.kind)">{{ log.text }}</span>
          </div>
          <p v-if="!connLogs.length" class="mt-6 text-center text-[12px] text-fg-dim">暂无连接日志</p>
        </div>

        <!-- 底部操作 -->
        <div class="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2">
          <!-- 已连接：断开 -->
          <button
            v-if="connState === 2"
            class="border border-red-500/50 px-4 py-1 text-[12px] text-red-400 hover:bg-red-500/10"
            @click="disconnectCncnet; showConnModal = false"
          >
            断开连接
          </button>
          <!-- 连接中：取消 -->
          <button
            v-else-if="connState === 1"
            class="border border-line px-4 py-1 text-[12px] text-fg-dim hover:text-fg"
            @click="disconnectCncnet; showConnModal = false"
          >
            取消连接
          </button>
          <!-- 失败/未连接：重连/连接 -->
          <button
            v-else
            class="bg-accent px-4 py-1 text-[12px] text-white hover:bg-accent-hi"
            @click="connectCncnet(props.gamePath, props.gameId, props.currentModSetId); showConnModal = false"
          >
            {{ connState === 3 ? '重新连接' : '连接' }}
          </button>
          <button class="border border-line px-4 py-1 text-[12px] text-fg-dim hover:text-fg" @click="showConnModal = false">
            关闭
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
