<script setup lang="ts">
const win = window.api.window
</script>

<template>
  <div class="drag flex h-8 shrink-0 items-center border-b border-line bg-panel">
    <div class="px-3 text-[12px] tracking-wide text-fg-dim">启动器</div>

    <div class="flex-1"></div>

    <!-- Win10 标题栏按钮：46x32，关闭键 hover 变红 -->
    <div class="no-drag flex h-full">
      <button
        class="grid h-full w-[46px] place-items-center text-fg-dim hover:bg-panel-alt hover:text-fg"
        title="最小化"
        @click="win.minimize()"
      >
        &#9472;
      </button>
      <button
        class="grid h-full w-[46px] place-items-center text-fg-dim hover:bg-panel-alt hover:text-fg"
        title="最大化"
        @click="win.toggleMaximize()"
      >
        &#9633;
      </button>
      <button
        class="grid h-full w-[46px] place-items-center text-fg-dim hover:bg-danger hover:text-white"
        title="关闭"
        @click="win.close()"
      >
        &#10005;
      </button>
    </div>
  </div>
</template>
