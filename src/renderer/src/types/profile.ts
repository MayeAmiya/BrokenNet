/**
 * 游戏 Profile —— 一个游戏对应一套，可以从服务器下发。
 *
 * 关键约束：profile 是【数据】不是【代码】。服务器只能从 Action 这个
 * 白名单里挑动作，不能让客户端执行任意逻辑。所有动作的实现都在启动器
 * 本地，远程改不动。
 *
 * 将来如果声明式确实表达不了，再引入沙箱化脚本 + 签名校验，
 * 那时 Action 里加一个 { type: 'script', ... } 分支即可，结构不用改。
 */

/** 布局节点：渲染器认得的组件类型，都是启动器内置的 */
export type LayoutNode =
  | { type: 'text'; value: string; dim?: boolean }
  | { type: 'heading'; value: string }
  | { type: 'image'; src: string; height?: number }
  | { type: 'button'; label: string; action: string; primary?: boolean }
  | { type: 'row'; children: LayoutNode[] }
  | { type: 'column'; children: LayoutNode[] }
  | { type: 'spacer' }

/** 动作白名单。每一项在 main 进程里有对应实现，参数会做校验。 */
export type Action =
  | { type: 'launch'; exe: string; args?: string[]; cwd?: string }
  | { type: 'openUrl'; url: string }
  | { type: 'hardlink'; src: string; dest: string; overwrite?: boolean }
  | { type: 'writeConfig'; path: string; format: 'ini' | 'json'; patch: Record<string, unknown> }
  | { type: 'verify'; manifest: string }

export interface GameProfile {
  id: string
  name: string
  /** profile 自身的版本，用于判断要不要重新拉 */
  version: string
  /** 本地安装目录 */
  installPath: string
  /** Generals.exe 所在目录 */
  generalsPath?: string
  /** 是否启用 GeneralsTD 引擎 */
  useGtd?: boolean
  /** GeneralsTD 目录（可选） */
  gtdPath?: string
  /** 是否启用 GenTool */
  useGenTool?: boolean
  /** 视角高度 (310-850) */
  cameraHeight?: number
  /** 窗口化模式 */
  windowed?: boolean
  /** 快捷栏上显示的图片，留空就用名字首字回退 */
  icon?: string
  /** 需要登录才能用的功能，在这里声明 */
  requiresAuth?: string[]
  layout: LayoutNode[]
  actions: Record<string, Action>
}

/** 远程下发的 profile 包，signature 位先留着，等做签名校验时启用 */
export interface ProfileBundle {
  profile: GameProfile
  signature?: string
}
