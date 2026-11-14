<script setup lang="ts">
/**
 * Panel 页 = 直达控制器 + 设置页。
 *
 * 直达链路（与取色插件同款）：托盘「插件动作」/ 面板入口点击 → 宿主隐藏 Panel
 * → 投递 `launch/direct` 关键词 → 本页收到后唤起 overlay 标注层，全程不显示 Panel。
 *
 * 冷启动：本页可自服务注册**持久**全局快捷键（宿主 `keywordShortcuts`，宿主重启
 * 后仍生效）：`otools_upsert_keyword_shortcut_binding` → 按键经宿主直达链路
 * （`launch_direct_keyword_shortcut`）携带关键词打开本插件。持久绑定启用期间
 * 运行时注册（`otools.shortcuts`）让位；未绑定时运行时注册兜底（webview 常驻期间有效）。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { onOtoolsKeyword } from 'otools-plugin-sdk'
import { Keyboard, MousePointerClick, Settings as SettingsIcon, Info } from '@lucide/vue'
import { loadSettings, saveSettings, type ScreendrawSettings } from '../settings'
import { WIDTH_PRESETS } from '../core/constants/tools'
import { useI18n } from '../i18n'
import { sendOverlayCommand } from '../commandChannel'
import {
  SCREENDRAW_KEYWORD,
  SCREENDRAW_KEYWORD_BINDING_ID,
  displayShortcut,
  findOwnKeywordBinding,
  persistentBindingActive,
  resolvePluginUuid,
  shortcutFromKeyboardEvent,
  type KeywordBinding,
} from './shortcutBinding'

const { t } = useI18n()

const OVERLAY_WINDOW_ID = 'overlay'

const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const settings = reactive<ScreendrawSettings>(loadSettings())
type HotkeyMode = 'idle' | 'persistent' | 'registered' | 'conflict' | 'unsupported'
const hotkeyStatus = ref<HotkeyMode>('idle')
const hotkeyError = ref('')
const launching = ref(false)
let stopLaunch: (() => void) | undefined
let releaseHotkey: (() => Promise<void>) | undefined

// ---------- 持久快捷键绑定（冷启动） ----------
const pluginUuid = resolvePluginUuid(
  (window as { __OToolsEnv?: { pluginUuid?: unknown } }).__OToolsEnv?.pluginUuid,
)
const ownBinding = ref<KeywordBinding | null>(null)
const recording = ref(false)
const recordHintCombo = ref('')
const bindBusy = ref(false)
const bindError = ref('')

function shortcutsApi(): { register(shortcut: string, handler: () => void): Promise<() => Promise<void>> } | undefined {
  return (window as { otools?: { shortcuts?: { register(shortcut: string, handler: () => void): Promise<() => Promise<void>> } } }).otools?.shortcuts
}

async function refreshOwnBinding(): Promise<void> {
  if (!native) return
  try {
    const bindings = await invoke<unknown>('otools_get_keyword_shortcut_bindings', {})
    ownBinding.value = findOwnKeywordBinding(bindings, pluginUuid)
  } catch {
    ownBinding.value = null
  }
}

function stopRecording(): void {
  recording.value = false
  recordHintCombo.value = ''
  window.removeEventListener('keydown', onRecordingKeydown, true)
  window.removeEventListener('keyup', swallowEventCapture, true)
}

function swallowEventCapture(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
}

function onRecordingKeydown(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const combo = shortcutFromKeyboardEvent(event)
  if (!combo) {
    // 修饰键/不支持的主键：清除提示，等待完整组合。
    recordHintCombo.value = ''
    return
  }
  recordHintCombo.value = combo
  void commitBinding(combo)
}

function startRecording(): void {
  if (!native || bindBusy.value) return
  bindError.value = ''
  recording.value = true
  recordHintCombo.value = ''
  window.addEventListener('keydown', onRecordingKeydown, true)
  window.addEventListener('keyup', swallowEventCapture, true)
}

async function releaseRuntimeHotkey(): Promise<void> {
  if (!releaseHotkey) return
  const release = releaseHotkey
  releaseHotkey = undefined
  try {
    await release()
  } catch { /* 幂等释放，失败不影响主流程 */ }
}

/** 绑定/改键：先让出运行时注册（避免宿主 is_taken 冲突），失败则恢复。 */
async function commitBinding(shortcut: string): Promise<void> {
  if (!native || bindBusy.value) return
  bindBusy.value = true
  bindError.value = ''
  const hadRuntime = releaseHotkey !== undefined
  await releaseRuntimeHotkey()
  try {
    const saved = await invoke<unknown>('otools_upsert_keyword_shortcut_binding', {
      binding: {
        id: SCREENDRAW_KEYWORD_BINDING_ID,
        pluginUuid,
        shortcut,
        keyword: SCREENDRAW_KEYWORD,
        enabled: true,
      },
    })
    ownBinding.value = findOwnKeywordBinding([saved], pluginUuid) ?? ownBinding.value
    hotkeyStatus.value = 'persistent'
    hotkeyError.value = ''
  } catch (error) {
    bindError.value = String(error)
    hotkeyStatus.value = 'conflict'
    if (hadRuntime) await registerRuntimeHotkey()
  } finally {
    bindBusy.value = false
    stopRecording()
  }
}

async function setBindingEnabled(enabled: boolean): Promise<void> {
  const binding = ownBinding.value
  if (!native || !binding || bindBusy.value) return
  bindBusy.value = true
  bindError.value = ''
  try {
    const saved = await invoke<unknown>('otools_upsert_keyword_shortcut_binding', {
      binding: { ...binding, enabled },
    })
    ownBinding.value = findOwnKeywordBinding([saved], pluginUuid) ?? ownBinding.value
    await syncRuntimeHotkeyWithBinding()
  } catch (error) {
    bindError.value = String(error)
  } finally {
    bindBusy.value = false
  }
}

async function unbindBinding(): Promise<void> {
  const binding = ownBinding.value
  if (!native || !binding || bindBusy.value) return
  bindBusy.value = true
  bindError.value = ''
  try {
    await invoke('otools_remove_keyword_shortcut_binding', { id: binding.id })
    ownBinding.value = null
    await syncRuntimeHotkeyWithBinding()
  } catch (error) {
    bindError.value = String(error)
  } finally {
    bindBusy.value = false
  }
}

/** 运行时注册与持久绑定的共存策略：持久启用 → 让位；否则运行时兜底。 */
async function syncRuntimeHotkeyWithBinding(): Promise<void> {
  if (persistentBindingActive(ownBinding.value)) {
    await releaseRuntimeHotkey()
    hotkeyStatus.value = 'persistent'
    hotkeyError.value = ''
    return
  }
  if (releaseHotkey !== undefined) return
  await registerRuntimeHotkey()
}

async function registerRuntimeHotkey(): Promise<void> {
  if (!native) {
    hotkeyStatus.value = 'unsupported'
    return
  }
  const shortcuts = shortcutsApi()
  if (!shortcuts?.register) {
    hotkeyStatus.value = 'unsupported'
    return
  }
  try {
    // 先订阅再注册（宿主约定）；注册失败时由 SDK 清理订阅并抛错。
    const release = await shortcuts.register('CommandOrControl+Shift+D', () => {
      void toggleOverlay()
    })
    releaseHotkey = release
    if (hotkeyStatus.value !== 'persistent') {
      hotkeyStatus.value = 'registered'
      hotkeyError.value = ''
    }
  } catch (error) {
    hotkeyStatus.value = 'conflict'
    hotkeyError.value = String(error)
  }
}

// ---------- 直达与 toggle ----------
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
    title: t('plugin.overlayTitle'),
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

/** 语义统一为 toggle：无窗口创建（挂载即进会话），有窗口则进出切换。 */
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

function isMac(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? navigator.userAgent)
}

const runtimeHint = computed(() => {
  if (hotkeyStatus.value === 'persistent') return `✓ ${t('plugin.hotkey.persistentActive')}`
  if (hotkeyStatus.value === 'registered') return `✓ ${t('plugin.hotkey.registered')}`
  if (hotkeyStatus.value === 'conflict') return `✗ ${t('plugin.hotkey.conflict')} ${hotkeyError.value}`
  if (hotkeyStatus.value === 'unsupported') return t('plugin.hotkey.unsupported')
  return ''
})

const widthGroups = computed(() => {
  const groups = ['stroke', 'highlighter', 'eraser', 'text'] as const
  return groups.map(group => ({ group, value: settings.lineWidths[group] }))
})

const shortcutRows = computed(() => [
  { keys: isMac() ? '⌘⇧D' : 'Ctrl+Shift+D', label: t('plugin.hotkey.toggle') },
  { keys: '1-8 / V / T / N', label: t('plugin.hotkey.tools') },
  { keys: 'Q / E', label: t('plugin.hotkey.colors') },
  { keys: 'Space', label: t('plugin.hotkey.toolbar') },
  { keys: 'X', label: t('plugin.hotkey.penetration') },
  { keys: 'W', label: t('plugin.hotkey.whiteboard') },
  { keys: isMac() ? '⌘C' : 'Ctrl+C', label: t('plugin.hotkey.copy') },
  { keys: isMac() ? '⌘⇧C' : 'Ctrl+Shift+C', label: t('plugin.hotkey.clear') },
  { keys: 'Esc', label: t('plugin.hotkey.exit') },
])

function patch<K extends keyof ScreendrawSettings>(key: K, value: ScreendrawSettings[K]) {
  settings[key] = value
  saveSettings({ ...settings })
}

function patchWidth(group: keyof ScreendrawSettings['lineWidths'], value: number) {
  settings.lineWidths = { ...settings.lineWidths, [group]: value }
  saveSettings({ ...settings })
}

onMounted(async () => {
  try {
    stopLaunch = await onOtoolsKeyword(entries => {
      for (const entry of entries) {
        if (entry.keyword !== 'launch') continue
        // direct = 托盘/面板直达；shortcut = 宿主持久快捷键链路（冷启动后的关键词落点）。
        if (entry.source === 'direct' || entry.source === 'shortcut') {
          void toggleOverlay()
        }
      }
    })
  } catch (error) {
    console.error('[screendraw] keyword subscribe failed', error)
  }
  await refreshOwnBinding()
  await syncRuntimeHotkeyWithBinding()
})

onUnmounted(() => {
  stopLaunch?.()
  void releaseHotkey?.()
  stopRecording()
})
</script>

<template>
  <div class="min-h-screen bg-[var(--ui-bg)] text-[var(--ui-text-title)] p-5 space-y-5">
    <header class="flex items-center gap-3">
      <img src="../../logo.svg" alt="" class="w-10 h-10 rounded-lg" />
      <div>
        <h1 class="text-base font-semibold text-[var(--ui-text-heading)]">{{ t('plugin.panelTitle') }}</h1>
        <p class="text-xs text-[var(--ui-text-muted)]">{{ t('plugin.panelSubtitle') }}</p>
      </div>
    </header>

    <section class="rounded-xl border border-[var(--ui-border)] bg-[var(--ui-bg-elevated)] p-4 space-y-3">
      <div class="flex items-center gap-2 text-sm font-medium">
        <MousePointerClick class="w-4 h-4" />
        <span>{{ t('plugin.section.launch') }}</span>
      </div>
      <button
        class="w-full rounded-lg bg-[var(--ui-accent,#0a84ff)] hover:opacity-90 transition text-white text-sm py-2 font-medium disabled:opacity-50"
        :disabled="launching"
        @click="toggleOverlay()"
      >
        {{ launching ? t('plugin.launching') : t('plugin.startAnnotate') }}
      </button>
      <p class="text-xs text-[var(--ui-text-muted)]">{{ t('plugin.trayHint') }}</p>
    </section>

    <section class="rounded-xl border border-[var(--ui-border)] bg-[var(--ui-bg-elevated)] p-4 space-y-3">
      <div class="flex items-center gap-2 text-sm font-medium">
        <Keyboard class="w-4 h-4" />
        <span>{{ t('plugin.hotkey.cardTitle') }}</span>
      </div>
      <p class="text-xs text-[var(--ui-text-muted)]">{{ t('plugin.hotkey.cardHint') }}</p>

      <!-- 当前持久绑定 -->
      <div v-if="ownBinding" class="space-y-2">
        <div class="flex items-center justify-between text-sm">
          <span class="flex items-center gap-2">
            <kbd class="px-2 py-0.5 rounded bg-[var(--ui-bg-subtle)] border border-[var(--ui-border)] font-mono">
              {{ displayShortcut(ownBinding.shortcut) }}
            </kbd>
            <span
              class="text-xs px-1.5 py-0.5 rounded"
              :class="ownBinding.enabled
                ? 'text-[var(--ui-text-capture)]'
                : 'text-[var(--ui-text-faint)]'"
            >
              {{ ownBinding.enabled ? t('plugin.hotkey.enabled') : t('plugin.hotkey.disabled') }}
            </span>
          </span>
          <div class="flex gap-2">
            <button class="text-xs px-2 py-1 rounded bg-[var(--ui-bg-subtle)] hover:bg-[var(--ui-bg-subtle-hover)]" :disabled="bindBusy" @click="startRecording()">
              {{ t('plugin.hotkey.rebind') }}
            </button>
            <button class="text-xs px-2 py-1 rounded bg-[var(--ui-bg-subtle)] hover:bg-[var(--ui-bg-subtle-hover)]" :disabled="bindBusy" @click="setBindingEnabled(!ownBinding.enabled)">
              {{ ownBinding.enabled ? t('plugin.hotkey.disable') : t('plugin.hotkey.enable') }}
            </button>
            <button class="text-xs px-2 py-1 rounded text-[var(--ui-text-capture)] hover:opacity-80" :disabled="bindBusy" @click="unbindBinding()">
              {{ t('plugin.hotkey.unbind') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 录制新绑定 -->
      <div v-else class="space-y-2">
        <button
          class="w-full rounded-lg border border-dashed border-[var(--ui-border-strong)] py-2 text-sm"
          :class="recording ? 'text-[var(--ui-text-capture)]' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-bg-subtle)]'"
          :disabled="bindBusy"
          @click="recording ? stopRecording() : startRecording()"
        >
          {{ recording
            ? (recordHintCombo || t('plugin.hotkey.recording'))
            : t('plugin.hotkey.recordPrompt') }}
        </button>
        <p v-if="recording" class="text-xs text-[var(--ui-text-faint)]">{{ t('plugin.hotkey.recordingHint') }}</p>
      </div>

      <p v-if="bindError" class="text-xs text-[var(--ui-text-capture)]">{{ bindError }}</p>

      <!-- 运行时兜底状态 -->
      <p v-if="runtimeHint" class="text-xs" :class="hotkeyStatus === 'conflict' ? 'text-[var(--ui-text-capture)]' : 'text-[var(--ui-text-muted)]'">
        {{ runtimeHint }}
      </p>
      <p class="text-xs text-[var(--ui-text-faint)]">{{ t('plugin.hotkey.settingsHint') }}</p>
    </section>

    <section class="rounded-xl border border-[var(--ui-border)] bg-[var(--ui-bg-elevated)] p-4 space-y-4">
      <div class="flex items-center gap-2 text-sm font-medium">
        <SettingsIcon class="w-4 h-4" />
        <span>{{ t('plugin.section.behavior') }}</span>
      </div>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.entryMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.defaultEntryMode"
          @change="patch('defaultEntryMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['defaultEntryMode'])"
        >
          <option value="screen">{{ t('plugin.entryMode.screen') }}</option>
          <option value="whiteboard">{{ t('plugin.entryMode.whiteboard') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.toolbar') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.toolbarVisibility"
          @change="patch('toolbarVisibility', ($event.target as HTMLSelectElement).value as ScreendrawSettings['toolbarVisibility'])"
        >
          <option value="space">{{ t('plugin.toolbar.space') }}</option>
          <option value="always">{{ t('plugin.toolbar.always') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.whiteboardBg') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.whiteboardBackground"
          @change="patch('whiteboardBackground', ($event.target as HTMLSelectElement).value as ScreendrawSettings['whiteboardBackground'])"
        >
          <option value="white">{{ t('plugin.whiteboard.white') }}</option>
          <option value="black">{{ t('plugin.whiteboard.black') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.eraserMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.eraserMode"
          @change="patch('eraserMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['eraserMode'])"
        >
          <option value="stroke">{{ t('plugin.eraser.stroke') }}</option>
          <option value="object">{{ t('plugin.eraser.object') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.laserMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.laserMode"
          @change="patch('laserMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['laserMode'])"
        >
          <option value="trail">{{ t('plugin.laser.trail') }}</option>
          <option value="writing">{{ t('plugin.laser.writing') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.strokeSmoothing') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.strokeSmoothing"
          @change="patch('strokeSmoothing', ($event.target as HTMLSelectElement).value as ScreendrawSettings['strokeSmoothing'])"
        >
          <option value="off">{{ t('plugin.smoothing.off') }}</option>
          <option value="standard">{{ t('plugin.smoothing.standard') }}</option>
          <option value="strong">{{ t('plugin.smoothing.strong') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.dragMode') }}</span>
        <select
          class="bg-[var(--ui-bg-subtle)] rounded-md px-2 py-1 text-xs"
          :value="settings.dragMode"
          @change="patch('dragMode', ($event.target as HTMLSelectElement).value as ScreendrawSettings['dragMode'])"
        >
          <option value="off">{{ t('plugin.drag.off') }}</option>
          <option value="hover">{{ t('plugin.drag.hover') }}</option>
          <option value="modifier">{{ t('plugin.drag.modifier') }}</option>
        </select>
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.autoRevert') }}</span>
        <input
          type="checkbox"
          :checked="settings.autoRevertToPen"
          @change="patch('autoRevertToPen', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="flex items-center justify-between text-sm">
        <span>{{ t('plugin.setting.preserveDrawings') }}</span>
        <input
          type="checkbox"
          :checked="settings.preserveDrawings"
          @change="patch('preserveDrawings', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <div class="space-y-2">
        <div class="text-xs text-[var(--ui-text-muted)]">{{ t('plugin.setting.lineWidths') }}</div>
        <div v-for="row in widthGroups" :key="row.group" class="flex items-center justify-between text-sm">
          <span>{{ t(`plugin.widthGroup.${row.group}`) }}</span>
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
        <span>{{ t('plugin.section.shortcuts') }}</span>
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
