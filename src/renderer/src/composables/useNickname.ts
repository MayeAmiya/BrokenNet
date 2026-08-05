import { ref } from 'vue'

/**
 * 在线昵称 —— 全局单例，持久化到启动器配置。
 * 联机（LobbyView / cncnet）、账户页、游戏设置页三处共用，
 * 任一处修改都会生效并写入磁盘，重启不丢。
 */
const DEFAULT = 'Player'
const STORAGE_KEY = 'nickname'

const nickname = ref(DEFAULT)
let loaded = false

export function useNickname() {
  /** 启动时从磁盘恢复昵称（只加载一次） */
  async function loadNickname(): Promise<void> {
    if (loaded) return
    try {
      const saved = await window.api.fs.getConfig(STORAGE_KEY)
      if (saved) nickname.value = saved
    } catch {
      // 读取失败用默认值
    }
    loaded = true
  }

  /**
   * 登录时设置默认昵称。
   * 已有自定义昵称则保留（避免用户手动改的昵称被登录覆盖），
   * 否则用邮箱前缀。
   */
  async function initFromEmail(email: string): Promise<void> {
    await loadNickname()
    if (nickname.value && nickname.value !== DEFAULT) return
    const prefix = email.split('@')[0]
    nickname.value = prefix || DEFAULT
    await window.api.fs.setConfig(STORAGE_KEY, nickname.value)
  }

  async function setNickname(value: string): Promise<void> {
    nickname.value = value.trim() || DEFAULT
    await window.api.fs.setConfig(STORAGE_KEY, nickname.value)
  }

  function getNickname(): string {
    return nickname.value
  }

  async function resetNickname(): Promise<void> {
    nickname.value = DEFAULT
    await window.api.fs.setConfig(STORAGE_KEY, DEFAULT)
  }

  return { nickname, loadNickname, initFromEmail, setNickname, getNickname, resetNickname }
}
