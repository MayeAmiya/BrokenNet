/**
 * 战役系统数据模型
 *
 * 参考 CnCNet 客户端的 Battle.ini + Mission.cs 设计。
 * 一个游戏可以有多条战役线（盟军、苏联、尤里等），
 * 每条战役线包含多个关卡。
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

/** 阵营/势力 */
export interface CampaignSide {
  id: string
  name: string
  icon?: string
}

/** 单个关卡 */
export interface Mission {
  /** 内部代号，如 GDI1, NODFS */
  codeName: string
  name: string
  description: string
  /** 地图文件路径（相对于游戏目录） */
  scenario: string
  sideId: string
  previewImage?: string
  finalMovie?: string
  requiredAddon?: boolean
  buildOffAlly?: boolean
  tags?: string[]
  isCustom?: boolean
}

/** 战役线（如盟军战役、苏联战役） */
export interface CampaignBranch {
  id: string
  name: string
  description: string
  sideId: string
  missions: Mission[]
}

/** 某个播放集的战役配置 */
export interface CampaignConfig {
  /** 播放集 ID */
  modSetId: string
  gameId: string
  sides: CampaignSide[]
  branches: CampaignBranch[]
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
