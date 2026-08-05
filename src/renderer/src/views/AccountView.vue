<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAuth } from '@renderer/composables/useAuth'
import { useNickname } from '@renderer/composables/useNickname'

const { user, pending, isLoggedIn, login, logout } = useAuth()
const { nickname: lobbyNickname, setNickname } = useNickname()
const email = ref('')
const password = ref('')
const editingNickname = ref(false)
const nicknameInput = ref('')

// 登录后自动设置昵称为邮箱前缀
watch(isLoggedIn, (loggedIn) => {
  if (loggedIn && user.value) {
    nicknameInput.value = user.value.name
  }
})

async function submit(): Promise<void> {
  if (!email.value.trim() || !password.value) return
  await login(email.value.trim(), password.value)
  // 登录成功后，昵称已自动设为邮箱前缀
  nicknameInput.value = user.value?.name || ''
}

async function saveNickname(): Promise<void> {
  if (!nicknameInput.value.trim()) return
  await setNickname(nicknameInput.value.trim())
  editingNickname.value = false
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="border-b border-line px-6 py-4">
      <h1 class="text-[19px] font-light">账户</h1>
      <p class="mt-1 text-fg-dim">本地内容无需登录；联机、云存档这类功能需要账号。</p>
    </header>

    <div v-if="!isLoggedIn" class="flex flex-1 items-center justify-center">
      <div class="w-[320px]">
        <label class="mb-1 block text-[12px] text-fg-dim">邮箱</label>
        <input
          v-model="email"
          type="email"
          placeholder="请输入邮箱"
          class="mb-3 w-full border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent"
          @keyup.enter="submit"
        />
        <label class="mb-1 block text-[12px] text-fg-dim">密码</label>
        <input
          v-model="password"
          type="password"
          placeholder="请输入密码"
          class="mb-4 w-full border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent"
          @keyup.enter="submit"
        />
        <button
          class="w-full bg-accent py-2 text-[13px] text-white hover:bg-accent-hi disabled:opacity-40"
          :disabled="pending || !email.trim() || !password"
          @click="submit"
        >
          {{ pending ? '登录中...' : '登录' }}
        </button>
      </div>
    </div>

    <div v-else class="flex-1 overflow-y-auto px-6 py-5">
      <div class="mb-5 flex items-center gap-3">
        <div class="grid h-12 w-12 place-items-center bg-accent text-lg text-white">
          {{ user?.name.slice(0, 1).toUpperCase() }}
        </div>
        <div>
          <div>{{ user?.name }}</div>
          <div class="text-[12px] text-fg-dim">{{ user?.email }}</div>
        </div>
      </div>

      <!-- 大厅昵称设置 -->
      <div class="mb-5 rounded border border-line p-4">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[13px] font-medium">大厅昵称</span>
          <button
            v-if="!editingNickname"
            class="text-[12px] text-accent hover:underline"
            @click="editingNickname = true; nicknameInput = lobbyNickname"
          >
            编辑
          </button>
        </div>
        <p class="mb-3 text-[12px] text-fg-dim">多人游戏大厅中其他玩家看到的名称</p>
        <div v-if="editingNickname" class="flex gap-2">
          <input
            v-model="nicknameInput"
            type="text"
            placeholder="请输入昵称"
            class="flex-1 border border-line bg-panel px-3 py-1.5 text-[13px] outline-none focus:border-accent"
            @keyup.enter="saveNickname"
          />
          <button
            class="bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent-hi disabled:opacity-40"
            :disabled="!nicknameInput.trim()"
            @click="saveNickname"
          >
            保存
          </button>
          <button
            class="border border-line px-3 py-1.5 text-[12px] text-fg-dim hover:text-fg"
            @click="editingNickname = false"
          >
            取消
          </button>
        </div>
        <div v-else class="text-[13px]">
          {{ lobbyNickname }}
        </div>
      </div>

      <button class="border border-line px-4 py-1.5 text-[13px] hover:bg-panel-alt" @click="logout">
        退出登录
      </button>
    </div>
  </div>
</template>
