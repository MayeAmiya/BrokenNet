/**
 * 会话共享状态：游戏是否已启动（多人联机进入游戏后锁定启动器相关操作）。
 * 用模块级 ref 跨 LobbyView / GameView / RoomDetail 共享。
 */
import { ref } from 'vue'

/** 游戏已启动（进入游戏后锁定：房主不能再次开始、不能切单人战役、不能改播放集） */
export const gameStarted = ref(false)

export function setGameStarted(v: boolean): void {
  gameStarted.value = v
}
