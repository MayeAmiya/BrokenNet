<script setup lang="ts">
import { useGames } from '@renderer/composables/useGames'
import { useAuth } from '@renderer/composables/useAuth'

const props = defineProps<{ current: string }>()
const emit = defineEmits<{ select: [string] }>()

const { games, isEmpty } = useGames()
const { user, isLoggedIn } = useAuth()

function isActive(key: string): boolean {
  return props.current === key
}
</script>

<template>
  <div class="flex w-14 shrink-0 flex-col border-r border-line bg-panel">
    <!-- 游戏快捷栏 -->
    <div class="flex-1 overflow-y-auto py-2">
      <div
        v-for="g in games"
        :key="g.id"
        class="relative mx-auto mb-1 h-10 w-10 cursor-default"
        :title="g.name"
        @click="emit('select', g.id)"
      >
        <span
          v-if="isActive(g.id)"
          class="absolute top-0 -left-2 h-full w-[2px] bg-accent"
        ></span>
        <img v-if="g.icon" :src="g.icon" class="h-full w-full object-cover" :alt="g.name" />
        <div
          v-else
          class="grid h-full w-full place-items-center bg-panel-alt text-fg-dim ring-1 ring-line"
          :class="isActive(g.id) ? 'text-fg ring-accent' : 'hover:text-fg'"
        >
          {{ g.name.slice(0, 1) }}
        </div>
      </div>

      <!-- 没有游戏时的添加入口 -->
      <div
        class="mx-auto grid h-10 w-10 cursor-default place-items-center border border-dashed border-line text-lg leading-none text-fg-dim hover:border-accent hover:text-fg"
        :title="isEmpty ? '添加游戏' : '添加'"
        @click="emit('select', 'add')"
      >
        +
      </div>
    </div>

    <!-- 底部：设置 + 用户 -->
    <div class="py-2">
      <div
        class="relative mx-auto mb-1 grid h-10 w-10 cursor-default place-items-center text-fg-dim"
        :class="isActive('settings') ? 'bg-panel-alt text-fg' : 'hover:bg-panel-alt hover:text-fg'"
        title="设置"
        @click="emit('select', 'settings')"
      >
        <span
          v-if="isActive('settings')"
          class="absolute top-0 left-0 h-full w-[2px] bg-accent"
        ></span>
        <!-- 齿轮图标 -->
        <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>

      <div
        class="relative mx-auto grid h-10 w-10 cursor-default place-items-center"
        :class="isActive('account') ? 'bg-panel-alt' : 'hover:bg-panel-alt'"
        :title="isLoggedIn ? `已登录：${user?.name}` : '未登录'"
        @click="emit('select', 'account')"
      >
        <span
          v-if="isActive('account')"
          class="absolute top-0 left-0 h-full w-[2px] bg-accent"
        ></span>
        <!-- 头像位 -->
        <div
          class="grid h-7 w-7 place-items-center ring-1"
          :class="isLoggedIn ? 'bg-accent text-white ring-accent' : 'bg-panel-alt text-fg-dim ring-line'"
        >
          {{ isLoggedIn ? user?.name.slice(0, 1).toUpperCase() : '—' }}
        </div>
      </div>
    </div>
  </div>
</template>
