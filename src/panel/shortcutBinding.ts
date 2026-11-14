/**
 * 持久全局快捷键绑定（宿主 `keywordShortcuts`）的插件侧纯逻辑。
 *
 * 冷启动语义：绑定由宿主持有并在启动时向 OS 注册，宿主重启后仍生效；
 * 按键 → `launch_direct_keyword_shortcut`（直达插件）→ 隐藏 Panel 消费请求
 * → 派发 `{keyword, source:"direct"}`。运行时注册（`otools.shortcuts`）只覆盖
 * Panel webview 常驻期间，作为无持久绑定时的兜底。
 */

/** 本插件关键词绑定的稳定 id（upsert 按此幂等，remove 按此删除）。 */
export const SCREENDRAW_KEYWORD_BINDING_ID = 'screendraw-annotate'
/** 与 plugin.json trayActions 的 keyword 一致：动作语义 = 进入/退出标注。 */
export const SCREENDRAW_KEYWORD = 'launch'

export interface KeywordBinding {
  id: string
  pluginUuid: string
  shortcut: string
  keyword: string
  enabled: boolean
}

const MODIFIER_ONLY_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'Fn', 'FnLock', 'CapsLock', 'NumLock', 'ScrollLock'])

let macPlatformOverride: boolean | null = null

/** 仅测试用：jsdom 继承真机 platform，测试需显式固定平台分支。 */
export function setMacPlatformForTests(value: boolean | null): void {
  macPlatformOverride = value
}

function isMacPlatform(): boolean {
  if (macPlatformOverride !== null) return macPlatformOverride
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? navigator.userAgent)
}

/**
 * 录制中的 KeyboardEvent → Tauri 全局快捷键字符串。
 *
 * 规则：
 * - 修饰键单独按下返回 null（组合未完成）；
 * - 主键限定字母 / 数字 / F1-F12（字母数字必须带 Ctrl/Cmd 或 Alt，避免 Shift+字母
 *   在正常打字大写时误触全局事件）；
 * - mac 上 Meta→`Command`、Control→`Control` 分开保留，其余平台 Control；
 * - 最终有效性由宿主 `canonicalize_shortcut` 裁决（冲突/非法原样抛错）。
 */
export function shortcutFromKeyboardEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_ONLY_KEYS.has(e.key)) return null
  const key = e.key
  let mainKey: string | null = null
  if (/^[a-z]$/i.test(key)) mainKey = key.toUpperCase()
  else if (/^[0-9]$/.test(key)) mainKey = key
  else if (/^F([1-9]|1[0-2])$/.test(key)) mainKey = key
  if (!mainKey) return null

  const lettersDigits = /^[A-Z0-9]$/.test(mainKey)
  const strongModifier = e.metaKey || e.ctrlKey || e.altKey
  // 字母/数字必须带 Command/Ctrl/Alt；Shift 单独不算修饰（打字大写会误触）。
  if (lettersDigits && !strongModifier) return null

  const mac = isMacPlatform()
  const parts: string[] = []
  if (mac) {
    if (e.metaKey) parts.push('Command')
    if (e.ctrlKey) parts.push('Control')
  } else {
    // 非 mac：Ctrl 走 CommandOrControl（跨平台别名），Windows 键罕见地映射 Command。
    if (e.metaKey) parts.push('Command')
    else if (e.ctrlKey) parts.push('CommandOrControl')
  }
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(mainKey)
  return parts.join('+')
}

/** 录制结果的人类可读展示（Command→⌘ 等，与宿主 canonicalize 无关）。 */
export function displayShortcut(shortcut: string): string {
  const mac = isMacPlatform()
  return shortcut
    .split('+')
    .map(part => {
      switch (part) {
        case 'Command':
        case 'CmdOrCtrl':
        case 'CommandOrControl':
          return mac ? '⌘' : 'Ctrl'
        case 'Control':
          return mac ? '⌃' : 'Ctrl'
        case 'Alt':
          return mac ? '⌥' : 'Alt'
        case 'Shift':
          return mac ? '⇧' : 'Shift'
        default:
          return part
      }
    })
    .join(mac ? '' : '+')
}

/**
 * 从宿主 `otools_get_keyword_shortcut_bindings` 响应中找出本插件的绑定：
 * 优先稳定 id，其次 keyword 匹配（用户在宿主设置页手动建的同语义绑定）。
 * 形状不合法的条目跳过。
 */
export function findOwnKeywordBinding(raw: unknown, pluginUuid: string): KeywordBinding | null {
  if (!Array.isArray(raw)) return null
  const target = pluginUuid.trim().toLowerCase()
  let byKeyword: KeywordBinding | null = null
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const uuid = typeof record.pluginUuid === 'string' ? record.pluginUuid.trim().toLowerCase() : ''
    const shortcut = typeof record.shortcut === 'string' ? record.shortcut.trim() : ''
    const keyword = typeof record.keyword === 'string' ? record.keyword.trim().toLowerCase() : ''
    // 宿主 normalize_keyword_binding 保证 id/pluginUuid/keyword 非空；缺 id 视为畸形。
    if (!id || !uuid || uuid !== target || !keyword || !shortcut) continue
    const binding: KeywordBinding = {
      id,
      pluginUuid: uuid,
      shortcut,
      keyword,
      enabled: record.enabled === true,
    }
    if (id === SCREENDRAW_KEYWORD_BINDING_ID) return binding
    if (keyword === SCREENDRAW_KEYWORD && !byKeyword) byKeyword = binding
  }
  return byKeyword
}

/** 持久绑定启用中 → 运行时注册应让位（同一组合键双注册会冲突）。 */
export function persistentBindingActive(binding: KeywordBinding | null): boolean {
  return binding !== null && binding.enabled && binding.shortcut.trim() !== ''
}

/** 读取插件身份：宿主注入的 env 优先，兜底清单 uuid。 */
export function resolvePluginUuid(envPluginUuid: unknown, fallback = 'otools-screendraw'): string {
  const value = typeof envPluginUuid === 'string' ? envPluginUuid.trim() : ''
  return value || fallback
}
