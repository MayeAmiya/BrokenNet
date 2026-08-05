/**
 * 战役系统数据模型
 *
 * 排布忠实还原 BattleClient.ini 的 [Battles] 段键序：
 *   acts（按幕）→ groups（幕内国家/势力分组）→ missions（关卡）
 *   standalone（幕外独立分组，如挑战关卡/废弃战役）
 *
 * 重要：所有进度和用户设置都绑定到播放集（modSetId），
 * 切换播放集时需要保存/恢复。
 */

/** 难度等级 */
export type Difficulty = 'easy' | 'medium' | 'hard'

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '简单',
  medium: '普通',
  hard: '困难'
}

export const DIFFICULTY_INI_PATHS: Record<Difficulty, string> = {
  easy: 'INI/Map Code/Difficulty Easy.ini',
  medium: 'INI/Map Code/Difficulty Medium.ini',
  hard: 'INI/Map Code/Difficulty Hard.ini'
}

/** 单个关卡 */
export interface Mission {
  /** 内部代号，如 O.B-MKALL1 */
  codeName: string
  name: string
  description: string
  /** 地图文件路径（相对于游戏目录） */
  scenario: string
  sideId: string
  /** BattleClient.ini 里的原始 Side 值（游戏侧阵营字节） */
  side?: number
  previewImage?: string
  finalMovie?: string
  requiredAddon?: boolean
  buildOffAlly?: boolean
  tags?: string[]
  isCustom?: boolean
  /** BattleClient.ini 的 Enabled，false = 未开放，不可游玩 */
  enabled?: boolean
}

/** 幕内分组（如：欧洲联盟 / 美国 / 太平洋阵线 / 苏维埃俄罗斯 / 中国 / 拉丁同盟 / 厄普西隆列传） */
export interface CampaignGroup {
  id: string
  label: string
  missions: Mission[]
}

/** 一幕（如：蝴蝶效应 - Part1 / 同盟国联军 - 第一幕） */
export interface CampaignAct {
  id: string
  label: string
  /** 幕内子分组（国家/势力），可为空 */
  groups: CampaignGroup[]
  /** 直接挂在幕下的关卡（没有子分组时），可为空 */
  missions: Mission[]
}

/** 某个播放集的战役配置 */
export interface CampaignConfig {
  /** 播放集 ID */
  modSetId: string
  gameId: string
  /** 按幕分组 */
  acts: CampaignAct[]
  /** 幕外独立分组（挑战关卡、废弃战役等） */
  standalone: CampaignGroup[]
  difficultyIniPaths?: Record<Difficulty, string>
  spawnIniTemplate?: string
}

/** 单个关卡的进度 */
export interface MissionProgress {
  codeName: string
  completed: boolean
  bestDifficulty?: Difficulty
  playCount: number
  lastPlayedAt?: number
}

/** 某个播放集的用户战役设置 */
export interface CampaignUserSettings {
  /** 播放集 ID */
  modSetId: string
  /** 默认难度 */
  defaultDifficulty: Difficulty
  /** 各关卡进度 */
  progress: Record<string, MissionProgress>
}

/** 战役存档 */
export interface CampaignSave {
  codeName: string
  fileName: string
  createdAt: number
  gameTime: number
}

/** 战役启动参数 */
export interface CampaignLaunchParams {
  codeName: string
  scenario: string
  difficulty: Difficulty
  sideId: string
  requiredAddon?: boolean
  extraOptions?: Record<string, string>
}
