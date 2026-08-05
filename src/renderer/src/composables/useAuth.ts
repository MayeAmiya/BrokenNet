import { ref, computed, readonly } from 'vue'
import { useNickname } from './useNickname'

export interface User {
  email: string
  name: string
}

// 模块级状态 = 全局单例。规模还小，先不上 Pinia。
const user = ref<User | null>(null)
const pending = ref(false)

export function useAuth() {
  const isLoggedIn = computed(() => user.value !== null)

  /** 占位实现，等后端接口定了再换成真的 */
  async function login(email: string, _password: string): Promise<void> {
    pending.value = true
    try {
      await new Promise((r) => setTimeout(r, 400))
      // 占位：用邮箱前缀作为用户名
      const name = email.split('@')[0]
      user.value = { email, name }

      // 根据邮箱设置昵称（已有自定义昵称则保留）
      const { initFromEmail } = useNickname()
      await initFromEmail(email)
    } finally {
      pending.value = false
    }
  }

  function logout(): void {
    user.value = null
    // 不重置昵称 —— 用户手动设置过的昵称在登出后应保留
  }

  return { user: readonly(user), pending: readonly(pending), isLoggedIn, login, logout }
}
