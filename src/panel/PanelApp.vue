<script setup lang="ts">
/**
 * Panel 页 = 直达控制器 + 设置页。
 *
 * 直达链路（与取色插件同款）：托盘「插件动作」/ 面板入口点击 → 宿主隐藏 Panel
 * → 投递 `launch/direct` 关键词 → 本页收到后唤起 overlay 标注层，全程不显示 Panel。
 * 首次安装后的冷启动依赖宿主设置里绑定「插件关键词快捷键」或托盘入口；
 * 本页加载一次后（webview 常驻），运行时注册的 Cmd+Shift+D 即生效。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { onOtoolsKeyword } from 'otools-plugin-sdk'
import { Keyboard, MousePointerClick, Settings as SettingsIcon, Info } from '@lucide/vue'
import { loadSettings, saveSettings, type ScreendrawSettings } from '../settings'
import { sendOverlayCommand } from '../commandChannel'
import { WIDTH_PRESETS } from '../core/constants/tools'
import { useI18n } from '../i18n'

const { t } = useI18n()

const OVERLAY_WINDOW_ID = 'overlay'
const HOTKEY = 'CommandOrControl+Shift+D'

const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const settings = reactive<ScreendrawSettings>(loadSettings())
const hotkeyStatus = ref<'idle' | 'registered' | 'conflict' | 'unsupported'>('idle')
const hotkeyError = ref('')
const launching = ref(false)
let stopLaunch: (() => void) | undefined
let releaseHotkey: (() => Promise<void>) | undefined

const widthGroups = computed(() => {
  const groups = ['stroke', 'highlighter', 'eraser', 'text'] as const
  return groups.map(group => ({ group, value: settings.lineWidths[group] }))
})

function persistSettings() {
  saveSettings({ ...settings })
}

function patch<K extends keyof ScreendrawSettings>(key: K, value: ScreendrawSettings[K]) {
  settings[key] = value
  persistSettings()
}

function patchWidth(group: keyof ScreendrawSettings['lineWidths'], value: number) {
  settings.lineWidths = { ...settings.lineWidths, [group]: value }
  persistSettings()
}

async function overlayExists(): Promise<boolean> {
  try {
    const windows = await invoke<{ windowId: string }[]>('list_custom_plugin_windows', {})
    return windows.some(entry => entry.windowId === OVERLAY_WINDOW_ID)
  } catch {
    return false
  }
}

async function openOverlayWindow(): Promise<void> {
  await invoke('open_custom_plugin_window', {
    windowId: OVERLAY_WINDOW_ID,
    title: t('overlayTitle'),
    // 面板页无从得知显示器边界：overlay 挂载后自行撑满主显示器。
    url: 'index.html?overlay=1',
    options: {
      width: 960,
      height: 640,
      transparent: true,
      decorations: false,
      shadow: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      visibleOnAllWorkspaces: true,
    },
  })
}

async function activateOverlay(): Promise<void> {
  if (launching.value) return
  launching.value = true
  try {
    if (!(await overlayExists())) {
      // 新窗口挂载后自行进入绘制会话，无需后续事件。
      await openOverlayWindow()
      return
    }
    // 双通道投递（事件 + localStorage 邮箱），Overlay 侧按 seq 去重。
    await sendOverlayCommand('start')
  } catch (error) {
    console.error('[screendraw] activate overlay failed', error)
  } finally {
    launching.value = false
  }
}

async function toggleOverlay(): Promise<void> {
  if (launching.value) return
  launching.value = true
  try {
    if (!(await overlayExists())) {
      await openOverlayWindow()
      return
    }
    await sendOverlayCommand('toggle')
  } catch (error) {
    console.error('[screendraw] toggle overlay failed', error)
  } finally {
    launching.value = false
  }
}

async function registerHotkey(): Promise<void> {
  if (!native) {
    hotkeyStatus.value = 'unsupported'
    return
  }
  const shortcuts = (window as { otools?: { shortcuts?: { register(shortcut: string, handler: () => void): Promise<() => Promise<void>> } } }).otools?.shortcuts
  if (!shortcuts?.register) {
    hotkeyStatus.value = 'unsupported'
    return
  }
  try {
    // 先订阅再注册：注册失败时释放订阅，见宿主快捷键接入指南。
    const release = await shortcuts.register(HOTKEY, () => {
      void toggleOverlay()
    })
    releaseHotkey = release
    hotkeyStatus.value = 'registered'
    hotkeyError.value = ''
  } catch (error) {
    hotkeyStatus.value = 'conflict'
    hotkeyError.value = String(error)
  }
}

onMounted(async () => {
  try {
    stopLaunch = await onOtoolsKeyword(entries => {
      for (const entry of entries) {
        if (entry.keyword === 'launch' && entry.source === 'direct') {
          void activateOverlay()
        }
      }
    })
  } catch (error) {
    console.error('[screendraw] keyword subscribe failed', error)
  }
  await registerHotkey()
})

onUnmounted(() => {
  stopLaunch?.()
  void releaseHotkey?.()
})

const shortcutRows = computed(() => [
  { keys: isMac() ? '⌘⇧D' : 'Ctrl+Shift+D', label: t('hotkey.toggle') },
  { keys: '1-8 / V / T / N', label: t('hotkey.tools') },
  { keys: 'Q / E', label: t('hotkey.colors') },
  { keys: 'Space', label: t('hotkey.toolbar') },
  { keys: 'X', label: t('hotkey.penetration') },
  { keys: 'W', label: t('hotkey.whiteboard') },
  { keys: isMac() ? '⌘C' : 'Ctrl+C', label: t('hotkey.copy') },
  { keys: isMac() ? '⌘⇧C' : 'Ctrl+Shift+C', label: t('hotkey.clear') },
  { keys: 'Esc', label: t('hotkey.exit') },
])

function isMac(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? navigator.userAgent)
}
</script>

<template>
  <div class="min-h-screen bg-[var(--ui-bg)] text-[var(--ui-text-title)] p-5 space-y-5">
    <header class="flex items-center gap-3">
      <img src="../../logo.svg" alt="" class="w-10 h-10 rounded-lg" />
      <div>
        <h1 class="text-base font-semibold text-[var(--ui-text-heading)]">{{ t('panelTitle') }}</h1>
        <p class="text-xs text-[var(--ui-text-muted)]">{{ t('panelSubtitle') }}</p>
      </div>
    </header>

    <section class="rounded-xl border border-[var(--ui-border)] bg-[var(--ui-bg-elevated)] p-4 space-y-3">
      <div class="flex items-center gap-2 text-sm font-medium">
        <MousePointerClick class="w-4 h-4" />
        <span>{{ t('section.launch') }}</span>
      </div>
      <button
        class="w-full rounded-lg bg-[var(--ui-accent,#0a84ff)] hover:opacity-90 transition text-white text-sm py-2 font-medium"
        :disabled="launching"
        @click="activateOverlay()"
      >
        {{ launching ? t('launching') : t('startAnnotate') }}
      </button>
      <div class="text-xs text-[var(--ui-text-muted)] space-y-1">
        <p v-if="hotkeyStatus === 'registered'">✓ {{ t('hotkey.registered', { keys: isMac() ? '⌘⇧D' : 'Ctrl+Shift+D' }) }}</p>
        <p v-else-if="hotkeyStatus === 'conflict'" class="text-[var(--ui-text-capture)]">✗ {{ t('hotkey.conflict') }} {{ hotkeyError }}</p>
        <p v-else-if="hotkeyStatus === 'unsupported'">{{ t('hotkey.unsupported') }}</p>
        <p>{{ t('trayHint') }}</p>
        <p>{{ t('coldStartHint') }}</p>
      </div>
    </section>

    <section class="rounded-xl border border-[var(--ui-border)] bg-[var(--ui-bg-elevated)] p-4 space-y-4">
      <div class="flex items-center gap-2 text-sm font-medium">
        <SettingsIcon class="w-4 h-4" />
        <span>{{ t('section.behavior') }}</span>
      </div>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.entryMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.defaultEntryMode"
          @change="patch('defaultEntryMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['defaultEntryMode'])"
        >
          <option value="screen">{{ t('entryMode.screen') }}</option>
          <option value="whiteboard">{{ t('entryMode.whiteboard') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.toolbar') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.toolbarVisibility"
          @change="patch('toolbarVisibility', ($event.target as HTMLSelectElement).value as ScreendrawSettings['toolbarVisibility'])"
        >
          <option value="space">{{ t('toolbar.space') }}</option>
          <option value="always">{{ t('toolbar.always') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.whiteboardBg') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.whiteboardBackground"
          @change="patch('whiteboardBackground', ($event.target as HTMLSelectElement).value as ScreendrawSettings['whiteboardBackground'])"
        >
          <option value="white">{{ t('whiteboard.white') }}</option>
          <option value="black">{{ t('whiteboard.black') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.eraserMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.eraserMode"
          @change="patch('eraserMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['eraserMode'])"
        >
          <option value="stroke">{{ t('eraser.stroke') }}</option>
          <option value="object">{{ t('eraser.object') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.laserMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.laserMode"
          @change="patch('laserMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['laserMode'])"
        >
          <option value="trail">{{ t('laser.trail') }}</option>
          <option value="writing">{{ t('laser.writing') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.strokeSmoothing') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.strokeSmoothing"
          @change="patch('strokeSmoothing', ($event.target as HTMLSelectElement).value as ScreendrawSettings['strokeSmoothing'])"
        >
          <option value="off">{{ t('smoothing.off') }}</option>
          <option value="standard">{{ t('smoothing.standard') }}</option>
          <option value="strong">{{ t('smoothing.strong') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.dragMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.dragMode"
          @change="patch('dragMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['dragMode'])"
        >
          <option value="off">{{ t('drag.off') }}</option>
          <option value="hover">{{ t('drag.hover') }}</option>
          <option value="modifier">{{ t('drag.modifier') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.autoRevert') }}</span>
        <input
          type="checkbox"
          :checked="settings.autoRevertToPen"
          @change="patch('autoRevertToPen', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('setting.preserveDrawings') }}</span>
        <input
          type="checkbox"
          :checked="settings.preserveDrawings"
          @change="patch('preserveDrawings', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <div class="space-y-2">
        <div class="text-xs text-[var(--ui-text-muted)]">{{ t('setting.lineWidths') }}</div>
        <div v-for="row in widthGroups" :key="row.group" class="flex items-center justify-between text-sm">
          <span>{{ t(`widthGroup.${row.group}`) }}</span>
          <div class="flex gap-1">
            <button
              v-for="preset in WIDTH_PRESETS"
              :key="preset"
              class="w-7 h-7 rounded-md text-xs"
              :class="row.value === preset
                ? 'bg-[var(--ui-text-capture)] text-white'
                : 'bg-[var(--ui-bg-subtle)] hover:bg-[var(--ui-bg-subtle-hover)]'"
              @click="patchWidth(row.group, preset)"
            >
              {{ preset }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-[var(--ui-border)] bg-[var(--ui-bg-elevated)] p-4 space-y-3">
      <div class="flex items-center gap-2 text-sm font-medium">
        <Keyboard class="w-4 h-4" />
        <span>{{ t('section.shortcuts') }}</span>
      </div>
      <div class="grid grid-cols-1 gap-1.5">
        <div v-for="row in shortcutRows" :key="row.label" class="flex items-center justify-between text-xs">
          <span class="text-[var(--ui-text-muted)]">{{ row.label }}</span>
          <kbd class="px-1.5 py-0.5 rounded bg-[var(--ui-bg-subtle)] border border-[var(--ui-border)] font-mono">{{ row.keys }}</kbd>
        </div>
      </div>
    </section>

    <footer class="flex items-center gap-2 text-xs text-[var(--ui-text-faint)] pb-4">
      <Info class="w-3.5 h-3.5" />
      <span>OTools 屏幕标注 · 绘制引擎移植自 MarkerOn (MIT)</span>
    </footer>
  </div>
</template>
