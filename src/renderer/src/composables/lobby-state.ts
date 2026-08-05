/**
 * 大厅/房间联机的模块级状态（ref 集合）。
 *
 * 和 useLobby.ts 拆开：状态集中在这里，useLobby 只负责逻辑。这样改 useLobby 时
 * 这个文件不变，为 HMR 保活留出空间（Vite 只重执行变更的模块，状态 ref 保持同一实例）。
 * 注意：这里不要放会 mutate 状态之外的副作用（订阅注册等），订阅放在 useLobby 里。
 */
import { ref } from 'vue'
import type { Room, RoomDetail, ChatMessage, Friend } from '@renderer/types/lobby'
import type { GameOptionCheckBox, GameOptionDropDown } from './gameOptions'

export type ChatMode = 'lobby' | 'room' | 'private'

export interface PrivateChatTarget {
  userId: string
  userName: string
}

/** 完整连接日志条目（供详情弹窗展示） */
export interface ConnLogEntry {
  id: number
  time: string
  text: string
  kind: 'info' | 'error' | 'success'
}

/** 服务器尝试状态列表（供详情弹窗展示重试进度） */
export interface ConnAttemptEntry {
  server: string
  status: 'trying' | 'failed' | 'ok'
}

// ─── 房间列表 / 当前房间 ──────────────────────────────
export const rooms = ref<Room[]>([])
export const currentRoom = ref<RoomDetail | null>(null)
/** 游戏模式 uiName -> 内部名（GO 广播必须用内部名，真实客户端按 GameMode.Name 匹配） */
export const realModeNameMap = ref<Record<string, string>>({})
/** 完整模式数据（含 mapCodeIniName，spawnmap.ini 生成用） */
export const realModesData = ref<any[]>([])
export const friends = ref<Friend[]>([])
export const isLoading = ref(false)
export const cncnetConnected = ref(false)
export const onlineCount = ref(0)

// ─── 当前游戏 / 连接 ──────────────────────────────────
/** 当前游戏 id（连接成功后 join 对应频道用） */
export const currentGameId = ref('')
/** 当前游戏路径（联机启动游戏用） */
export const currentGamePath = ref('')
export const currentModSetId = ref('')
/** CnCNet 总在线玩家数（api.cncnet.org/status，对照原版 CnCNetPlayerCountTask） */
export const playerCount = ref<number | null>(null)

/**
 * CnCNet 连接状态机：
 * 0 = 未连接  1 = 连接中  2 = 已连接  3 = 连接失败
 */
export const connState = ref<0 | 1 | 2 | 3>(0)
export const connMessage = ref('')
export const connServer = ref('')
export const connAttempt = ref(0)
export const connTotal = ref(0)
/** 最近一次连接错误（重试耗尽时作为失败原因展示） */
export const lastConnError = ref('')
export const connLogs = ref<ConnLogEntry[]>([])
export const connAttempts = ref<ConnAttemptEntry[]>([])

// ─── 聊天 ─────────────────────────────────────────────
export const chatMode = ref<ChatMode>('lobby')
export const privateTarget = ref<PrivateChatTarget | null>(null)
/** 大厅聊天 */
export const lobbyMessages = ref<ChatMessage[]>([])
/** 房间聊天 */
export const roomMessages = ref<ChatMessage[]>([])
/** 私聊: key = userId, value = messages */
export const privateMessages = ref<Map<string, ChatMessage[]>>(new Map())

// ─── 房间内协同状态 ───────────────────────────────────
/** 当前聊天颜色（hex，发送消息时转成 \x03NN 前缀对齐原版客户端） */
export const chatColorHex = ref('#FFFFFF')
/** 非房主玩家的"自动准备"：收到主机 GETREADY 时自动回 R 1 */
export const autoReady = ref(false)

export const realDropdowns = ref<Array<GameOptionDropDown & { label: string; optionName: string; itemLabels: string[]; toolTip: string }>>([])
/** 可见复选框（供 UI 渲染 + GO 广播） */
export const realCheckboxes = ref<Array<GameOptionCheckBox & { text: string; optionName: string; toolTip: string; visible: boolean }>>([])
/** 全部复选框（含 Visible=0 的隐藏项，如 chkDEVNerfEights——XNA 对隐藏项同样写 spawn.ini/应用 MapCode） */
export const allRealCheckboxes = ref<Array<GameOptionCheckBox & { text: string; optionName: string; toolTip: string; visible: boolean }>>([])
export const dropdownValues = ref<Record<string, number>>({})
export const checkboxValues = ref<Record<string, boolean>>({})
/** GameOptions.ini [ForcedSpawnIniOptions]：始终写入 spawn.ini [Settings] */
export const forcedSpawnIniOptions = ref<Record<string, string>>({})

/** 已确认为 launcher 的玩家昵称集合 */
export const launcherPlayers = new Set<string>()
/** 默认帧发送率（对齐 xna ClientConfiguration.DefaultFrameSendRate=7；连接时从 ClientDefinitions.ini 加载） */
export const defaultFrameSendRate = ref(7)
/**
 * 当前播放集构建出的 playground 路径（固定 resourceDir/<gameId>/playground）。
 * 启用播放集时重建后写入；大厅/房间/战役数据源用它（包里带的地图/模式/战役才可见）。
 */
export const currentPlaygroundPath = ref('')
/** 频道加入失败（如被拉黑 +b）——连接状态要显示警告而不是绿色 */
export const channelError = ref('')
/** 子阵营随机选择器 → 覆盖的具体阵营索引（如 任一苏联=[3,4,5]） */
export const realRandomSelectors = ref<Record<string, number[]>>({})
/** Random + 选择器数量（下拉里具体阵营的起始偏移，当前 5） */
export const realRandomSelectorCount = ref(1)
/** 具体阵营数量（[General] Sides 长度，当前 12） */
export const realFactionCount = ref(0)

export const realSides = ref<Array<{ name: string; icon: string }>>([])
/** 颜色：gameColorIndex 是游戏内颜色索引（spawn.ini 写它，对齐参考 MultiplayerColor.GameColorIndex） */
export const realMpColors = ref<Array<{ name: string; r: number; g: number; b: number; hex: string; gameColorIndex: number }>>([])

// ─── HMR 保活用的持久标记（放这里：本文件不改，热更新 useLobby 时保持，防止重复订阅）───
/** 房间/消息订阅是否已注册（对象形式，跨 HMR 保持） */
export const roomSubsRegistered = { value: false }
/** CnCNet 连接事件监听清理函数（connectCncnet 每次调用前先清旧的，避免热更新后新老监听叠加） */
export const cleanupFns: Array<() => void> = []
