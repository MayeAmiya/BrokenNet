<script setup lang="ts">
import { ref, onMounted } from 'vue'

const resourceDir = ref('')
const status = ref('')
const uiScale = ref(125)
const useProxy = ref(false)

/** 启动器分辨率（窗口大小），默认 1440×900 */
const RESOLUTION_PRESETS = [
  { label: '1280×720', w: 1280, h: 720 },
  { label: '1440×900', w: 1440, h: 900 },
  { label: '1600×1000', w: 1600, h: 1000 },
  { label: '1920×1080', w: 1920, h: 1080 },
  { label: '2560×1440', w: 2560, h: 1440 }
]
const winW = ref(1440)
const winH = ref(900)

onMounted(async () => {
  const saved = await window.api.fs.getConfig('resourceDir')
  if (saved) resourceDir.value = saved
  const savedProxy = await window.api.fs.getConfig('useProxy')
  if (savedProxy === '1') useProxy.value = true
  const savedSize = await window.api.fs.getConfig('windowSize')
  if (savedSize) {
    const m = savedSize.match(/^(\d+)x(\d+)$/i)
    if (m) {
      winW.value = parseInt(m[1], 10)
      winH.value = parseInt(m[2], 10)
    }
  }
  const savedScale = localStorage.getItem('ui-scale')
  if (savedScale) {
    uiScale.value = parseInt(savedScale, 10)
    applyScale(uiScale.value)
  } else {
    applyScale(uiScale.value) // 默认 125%
  }
})

async function applyResolution(w: number, h: number): Promise<void> {
  if (w < 900 || h < 560) return
  winW.value = w
  winH.value = h
  await window.api.fs.setConfig('windowSize', `${w}x${h}`)
  await window.api.window.setSize(w, h)
  status.value = '已应用分辨率，窗口将调整'
}

async function selectResourceDir(): Promise<void> {
  const r = await window.api.fs.selectDirectory()
  if (r.path) {
    resourceDir.value = r.path
    await window.api.fs.setConfig('resourceDir', r.path)
    status.value = '已保存'
  }
}

async function clearResourceDir(): Promise<void> {
  resourceDir.value = ''
  await window.api.fs.setConfig('resourceDir', '')
  status.value = '已清空'
}

async function onProxyChange(): Promise<void> {
  await window.api.fs.setConfig('useProxy', useProxy.value ? '1' : '0')
  status.value = useProxy.value ? '已保存，重连 CnCNet 后生效' : '已保存'
}

function applyScale(percent: number): void {
  document.documentElement.style.zoom = `${percent / 100}`
}

function onScaleChange(): void {
  localStorage.setItem('ui-scale', String(uiScale.value))
  applyScale(uiScale.value)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="border-b border-line px-6 py-4">
      <h1 class="text-[19px] font-light">设置</h1>
    </header>

    <div class="flex-1 overflow-y-auto px-6 py-5">
      <!-- 启动器分辨率 -->
      <h2 class="mb-1">启动器分辨率</h2>
      <p class="mb-3 text-fg-dim">
        设置启动器窗口大小（默认 1440×900）。修改后窗口立即调整并保存，下次启动生效。
      </p>
      <div class="flex max-w-[520px] flex-wrap items-center gap-2">
        <button
          v-for="p in RESOLUTION_PRESETS"
          :key="p.label"
          class="border px-3 py-1 text-[12px]"
          :class="winW === p.w && winH === p.h ? 'border-accent text-fg' : 'border-line text-fg-dim hover:text-fg'"
          @click="applyResolution(p.w, p.h)"
        >{{ p.label }}</button>
      </div>
      <div class="mt-2 flex max-w-[520px] items-center gap-2">
        <input
          v-model.number="winW"
          type="text"
          inputmode="numeric"
          class="w-[100px] border border-line bg-panel px-2 py-1 text-[12px] outline-none"
        />
        <span class="text-fg-dim">×</span>
        <input
          v-model.number="winH"
          type="text"
          inputmode="numeric"
          class="w-[100px] border border-line bg-panel px-2 py-1 text-[12px] outline-none"
        />
        <button
          class="shrink-0 border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-fg"
          @click="applyResolution(winW, winH)"
        >
          应用
        </button>
      </div>

      <hr class="my-5 border-line" />

      <!-- UI 缩放 -->
      <h2 class="mb-1">界面缩放</h2>
      <p class="mb-3 text-fg-dim">
        调整整个界面的缩放比例（默认 125%），适合不同分辨率的屏幕。
      </p>
      <div class="flex max-w-[520px] items-center gap-3">
        <input
          v-model.number="uiScale"
          type="range"
          min="50"
          max="200"
          step="5"
          class="flex-1 accent-accent"
          @input="onScaleChange"
        />
        <span class="w-[48px] text-center text-[13px] text-fg">{{ uiScale }}%</span>
        <button
          class="shrink-0 border border-line px-3 py-1 text-[12px] text-fg-dim hover:text-fg"
          @click="uiScale = 125; onScaleChange()"
        >
          重置
        </button>
      </div>

      <hr class="my-5 border-line" />

      <!-- 网络代理 -->
      <h2 class="mb-1">网络代理</h2>
      <p class="mb-3 text-fg-dim">
        挂梯子时开启，让 CnCNet 连接走系统代理（IRC 是裸 TCP，默认不自动走代理，
        直连真实 IP 可能被频道封禁）。修改后需重新连接 CnCNet 生效。
      </p>
      <label class="flex max-w-[520px] cursor-pointer items-center gap-3">
        <input v-model="useProxy" type="checkbox" class="h-4 w-4 accent-accent" @change="onProxyChange" />
        <span class="text-[13px] text-fg">使用系统代理连接 CnCNet</span>
      </label>

      <hr class="my-5 border-line" />

      <!-- 资源目录 -->
      <h2 class="mb-1">资源目录</h2>
      <p class="mb-3 text-fg-dim">
        选择一个目录来存放游戏资源文件（MOD、补丁等）。
      </p>

      <div class="flex max-w-[520px] gap-2">
        <input
          v-model="resourceDir"
          readonly
          placeholder="未选择目录"
          class="flex-1 border border-line bg-panel px-3 py-2 text-[13px] outline-none"
        />
        <button
          class="shrink-0 border border-line px-4 py-2 text-[13px] text-fg-dim hover:border-accent hover:text-fg"
          @click="selectResourceDir"
        >
          选择目录
        </button>
        <button
          v-if="resourceDir"
          class="shrink-0 border border-line px-4 py-2 text-[13px] text-fg-dim hover:text-red-400"
          @click="clearResourceDir"
        >
          清空
        </button>
      </div>

      <p v-if="status" class="mt-3 text-[13px] text-fg-dim">{{ status }}</p>

      <hr class="my-6 border-line" />

      <!-- 项目信息：作者头像 + 作者/项目链接 + 欢迎提 issue/PR + 参考项目 -->
      <div class="flex items-center gap-3 text-[12px] text-fg-dim">
        <a href="https://github.com/MayeAmiya" target="_blank" title="MayeAmiya">
          <img src="https://github.com/MayeAmiya.png" class="h-20 w-20 rounded-full border border-line" alt="MayeAmiya" />
        </a>
        <div>
          <a href="https://github.com/MayeAmiya" target="_blank" class="text-fg hover:text-accent">MayeAmiya</a>
          <p class="mt-0.5">
            项目地址：<a href="https://github.com/MayeAmiya/BrokenNet" target="_blank" class="text-fg hover:text-accent">BrokenNet</a>　下载器：aria2c　解压器：7-Zip　欢迎提 issue 和 PR
          </p>
          <p class="mt-1 text-[11px]">
            RA2 系联机基于
            <a href="https://github.com/CnCNet/xna-cncnet-client" target="_blank" class="text-accent hover:text-accent-hi">XNA 项目</a>，
            ZH 系模组管理基于
            <a href="https://github.com/p0ls3r/GenLauncher" target="_blank" class="text-accent hover:text-accent-hi">GenLauncher 项目</a>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
