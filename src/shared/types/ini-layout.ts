export type DrawMode = 'centered' | 'stretched' | 'tiled'

export type IniControlType =
  | 'panel'
  | 'button'
  | 'linkbutton'
  | 'label'
  | 'checkbox'
  | 'dropdown'
  | 'textbox'
  | 'listbox'
  | 'trackbar'
  | 'extrapanel'

export interface IniPosition {
  x: number
  y: number
}

export interface IniSize {
  width: number
  height: number
}

export interface IniControlDef {
  name: string
  type: IniControlType
  location?: IniPosition
  size?: IniSize
  visible?: boolean
  enabled?: boolean
  text?: string
  toolTip?: string
  url?: string
  backgroundTexture?: string
  drawMode?: DrawMode
  distanceFromRightBorder?: number
  distanceFromBottomBorder?: number
  fillWidth?: number
  fillHeight?: number
  remapColor?: string
  idleColor?: string
  hoverColor?: string
  font?: string
  children?: IniControlDef[]
  extra?: Record<string, string>
}

export interface IniGameCheckBoxOption {
  controlName: string
  optionName: string
  text: string
  spawnIniOption: string
  checked: boolean
  location: IniPosition
  toolTip: string
  customIniPath?: string
  reversed?: boolean
  visible?: boolean
}

export interface IniGameDropDownOption {
  controlName: string
  optionName: string
  items: string[]
  itemLabels?: string[]
  defaultIndex: number
  spawnIniOption: string
  dataWriteMode: string
  location: IniPosition
  size: IniSize
  toolTip: string
}

export interface IniGameLabelOption {
  controlName: string
  text: string
  location: IniPosition
}

export interface IniSidesConfig {
  sides: string[]
  randomSelectors: Record<string, number[]>
}

export interface IniMPColor {
  name: string
  r: number
  g: number
  b: number
  uiColorId: number
}

export interface IniRendererDef {
  key: string
  uiName: string
  dllName?: string
  configFileName?: string
  resConfigFileName?: string
  additionalFiles?: string[]
  useQres?: boolean
  windowedModeSection?: string
  windowedModeKey?: string
  borderlessWindowedModeKey?: string
  isBorderlessReversed?: boolean
  isDxWnd?: boolean
  widthKey?: string
  heightKey?: string
  disallowedOperatingSystems?: string[]
}

export interface IniClientConfig {
  gameType: string
  launcherExe: string
  gameExecutableNames: string[]
  gameLauncherExecutableName: string
  settingsFile: string
  extraCommandLineParams: string
  localGame: string
  longGameName: string
  discordAppId: string
  registryInstallPath: string
  cncNetLiveStatusIdentifier: string
  mpMapsPath: string
  battleFSFileName: string
  minimumRenderWidth: number
  minimumRenderHeight: number
  minimumIngameWidth: number
  minimumIngameHeight: number
  maxNameLength: number
  /** 默认帧发送率（对齐 xna ClientConfiguration.DefaultFrameSendRate，默认 7） */
  defaultFrameSendRate: number
  forbiddenFiles: string[]
  requiredFiles: string[]
  allowedCustomGameModes: string[]
  links: Record<string, string>
}

export interface IniLobbyLayout {
  windowSize?: IniSize
  controls: IniControlDef[]
}

export interface IniGameLobbyConfig {
  sides: string[]
  mpColors: IniMPColor[]
  forcedSpawnIniOptions: Record<string, string>
  multiplayerLobby: {
    checkBoxes: IniGameCheckBoxOption[]
    dropDowns: IniGameDropDownOption[]
    labels: IniGameLabelOption[]
    sharpenImages: boolean
    defaultWindowSize: string
    playerOptionLocationX: number
    playerOptionLocationY: number
    playerOptionVerticalMargin: number
    playerOptionHorizontalMargin: number
    playerNameWidth: number
    sideWidth: number
    colorWidth: number
    teamWidth: number
    startWidth: number
  }
  skirmishLobby: {
    checkBoxes: IniGameCheckBoxOption[]
    dropDowns: IniGameDropDownOption[]
    labels: IniGameLabelOption[]
    sharpenImages: boolean
    defaultWindowSize: string
  }
}

export interface SpawnIniOverride {
  key: string
  value: string
}

export interface GameModeConfig {
  name: string
  uiName: string
  mapCodeIniName: string
  randomizedMapCodeININames: string[]
  randomizedMapCodesCount: number
  forcedOptionsSection: string
  minPlayersOverride?: number
  maxPlayersOverride?: number
  disallowedPlayerSides: number[]
  disallowedHumanPlayerSides: number[]
  disallowedComputerPlayerSides: number[]
  forcedCheckBoxValues: Record<string, boolean>
  forcedDropDownValues: Record<string, number>
  forcedSpawnIniOptions: Record<string, string>
}

export interface MapConfig {
  filePath: string
  baseFilePath: string
  description: string
  gameModes: string[]
  minPlayers: number
  maxPlayers: number
  enforceMaxPlayers: boolean
  size: string
  localSize: string
  previewSize: string
  waypoints: Record<number, { x: number; y: number }>
  isCoopMission: boolean
  briefing: string
  unitCount?: number
  disallowedPlayerSides: number[]
  disallowedPlayerColors: number[]
  enemyHouses: string[]
  forcedOptions: Record<string, string>
  forcedSpawnIniOptions: Record<string, string>
  extraIniName?: string
  baseSection?: string
}

export interface KeyboardBinding {
  command: string
  uiName: string
  category: string
  description: string
  defaultKey: string
  currentKey: string
}

export interface FileIntegrityCheck {
  file: string
  exists: boolean
  required: boolean
}

export interface CampaignAct {
  id: string
  label: string
}

export interface CampaignMission {
  id: string
  actLabelId: string
  missionIndex: number
  description: string
  summary: string
  scenario: string
  side: number
  sideName: string
  act: number
  longDescription: string
  buildOffAlly: boolean
  cd: number
  finalMovie: string
}

export interface CampaignBranch {
  name: string
  label: string
  acts: CampaignAct[]
  missions: CampaignMission[]
}

export interface TranslationFile {
  name: string
  culture: string
  entries: Record<string, string>
}

export interface RendererApplyResult {
  ok: boolean
  error?: string
  rendererKey: string
  filesCopied: string[]
}
