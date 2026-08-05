/**
 * 大厅房间悬停地图预览的独立置顶窗口
 *
 * 普通 HTML 的 position:fixed 元素会被 BrowserWindow 边界裁剪，永远出不了应用窗口。
 * 这里用一个独立的无边框置顶小窗（点击穿透）显示预览，跟随鼠标，
 * 窗口可以越过应用窗口边界显示在桌面其它区域。参考 xna-cncnet-client 的 map preview 悬浮。
 */

import previewHtmlPath from './map-preview.html?asset'
import { BrowserWindow, screen } from 'electron'

/** 预览图区固定显示高度（与旧的大厅悬停框一致） */
const PREVIEW_H = 264
/** 右侧房间信息列宽 */
const INFO_W = 200
/** 相对光标的偏移 */
const CURSOR_OFFSET = 16

export interface MapPreviewWindowContent {
  /** 'room' = 大厅房间悬停（左图 + 右信息列）；'map' = 房间内地图悬停（纯图 + 底部图名） */
  mode: 'room' | 'map'
  /** 预览图 data URL（无预览时传 ''） */
  imageUrl: string
  roomName?: string
  mapName?: string
  playerCount?: number
  maxPlayers?: number
  members?: Array<{ name: string; isHost: boolean }>
  /** 预览图区显示宽度（room: 窗口总宽 = imgW + INFO_W；map: 窗口宽度 = imgW） */
  imgW: number
  /** map 模式：图片显示高度（窗口总高 = imageHeight + 图名条） */
  imageHeight?: number
}

export class MapPreviewWindow {
  private win: BrowserWindow | null = null
  /** 最近一次显示的内容（move 重定位需要知道 mode 决定光标偏移方向） */
  private lastContent: MapPreviewWindowContent | null = null

  /** 懒创建（不放在模块顶层——否则 app.getPath 未就绪会崩） */
  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    this.win = new BrowserWindow({
      width: 352 + INFO_W,
      height: PREVIEW_H,
      frame: false,
      show: false,
      // 不能 resizable:false——Windows 上非可缩放窗口 setSize 只能变大不能缩小，
      // 会导致预览窗在 room/map 模式切换后宽度卡在之前的值
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: '#1f1f1f',
      webPreferences: {
        // 页面内联脚本要用 require('electron').ipcRenderer 收内容，必须关沙箱
        sandbox: false,
        nodeIntegration: true,
        contextIsolation: false
      }
    })
    // 点击穿透：悬停时用户仍能正常点房间行/聊天/按钮
    this.win.setIgnoreMouseEvents(true)
    void this.win.loadFile(previewHtmlPath)
    return this.win
  }

  show(content: MapPreviewWindowContent): void {
    this.lastContent = content
    const win = this.ensureWindow()
    const isMap = content.mode === 'map'
    const imgH = content.imageHeight ?? PREVIEW_H
    const labelH = isMap ? 20 : 0 // map 模式底部图名条
    win.setSize(
      isMap ? Math.max(120, content.imgW) : Math.max(120, content.imgW + INFO_W),
      isMap ? imgH + labelH : PREVIEW_H
    )
    this.sendContent(win, content)
    const pos = this.cursorPos(content)
    win.setPosition(pos[0], pos[1])
    win.showInactive()
  }

  /** 跟随光标移动（主进程读当前光标点，免 DPI 换算；不做钳制） */
  move(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return
    if (!this.lastContent) return
    this.win.setPosition(...this.cursorPos(this.lastContent))
  }

  hide(): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.hide()
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy()
    }
    this.win = null
  }

  /** 首次加载未完成时先等 did-finish-load，否则 send 会丢 */
  private sendContent(win: BrowserWindow, content: MapPreviewWindowContent): void {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('map-preview:content', content)
      })
    } else {
      win.webContents.send('map-preview:content', content)
    }
  }

  private cursorPos(content: MapPreviewWindowContent): [number, number] {
    const p = screen.getCursorScreenPoint()
    if (content.mode === 'map') {
      // 地图悬停：框在指针左边，框体右上角距指针约 100（x）× 50（y）
      return [p.x - 100 - content.imgW, p.y - 50]
    }
    return [p.x + CURSOR_OFFSET, p.y + CURSOR_OFFSET]
  }
}

export const mapPreviewWindow = new MapPreviewWindow()
