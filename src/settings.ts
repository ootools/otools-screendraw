/**
 * 插件设置：Panel 写、Overlay 读，同源 localStorage 共享 + storage 事件同步。
 * 结构沿用 MarkerOn AppConfig.general 的可移植子集；持久化格式独立演进。
 */
import {
  createDefaultLineWidths,
  resolveLineWidths,
  type ToolLineWidths,
} from './core/constants/tools'
import type { DragMode } from './core/utils/dragMode'
import type { DefaultEntryMode } from './core/utils/entryMode'
import type { ToolbarVisibility } from './core/utils/toolbarSettings'
import type { EraserMode } from './core/utils/eraserMode'
import type { LaserMode } from './core/utils/laserMode'
import type { PenCursorStyle } from './core/utils/penCursor'
import type { CrosshairCursorStyle } from './core/utils/crosshairCursor'
import type { StrokeSmoothing } from './core/utils/strokeSmoothing'
import type { WhiteboardBackground } from './core/utils/whiteboardBackground'
import type { ThemePreference } from './theme'

export interface ScreendrawSettings {
  dragMode: DragMode
  toolbarVisibility: ToolbarVisibility
  defaultEntryMode: DefaultEntryMode
  whiteboardBackground: WhiteboardBackground
  eraserMode: EraserMode
  laserMode: LaserMode
  penCursorStyle: PenCursorStyle
  crosshairCursorStyle: CrosshairCursorStyle
  strokeSmoothing: StrokeSmoothing
  autoRevertToPen: boolean
  /** 会话结束后是否保留笔迹（下次唤起可续画）。 */
  preserveDrawings: boolean
  whiteboardPreserveDrawings: boolean
  lineWidths: ToolLineWidths
  theme: ThemePreference
}

export const SETTINGS_STORAGE_KEY = 'otools-screendraw:settings:v1'

export function defaultSettings(): ScreendrawSettings {
  return {
    dragMode: 'hover',
    toolbarVisibility: 'space',
    defaultEntryMode: 'screen',
    whiteboardBackground: 'white',
    eraserMode: 'stroke',
    laserMode: 'trail',
    penCursorStyle: 'pen',
    crosshairCursorStyle: 'crosshair',
    strokeSmoothing: 'standard',
    autoRevertToPen: false,
    preserveDrawings: false,
    whiteboardPreserveDrawings: false,
    lineWidths: createDefaultLineWidths(),
    theme: 'system',
  }
}

export function resolveSettings(raw: unknown): ScreendrawSettings {
  const defaults = defaultSettings()
  if (!raw || typeof raw !== 'object') return defaults
  const record = raw as Record<string, unknown>
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback
  return {
    dragMode: pick(record.dragMode, ['off', 'hover', 'modifier'] as const, defaults.dragMode),
    toolbarVisibility: pick(record.toolbarVisibility, ['space', 'always'] as const, defaults.toolbarVisibility),
    defaultEntryMode: pick(record.defaultEntryMode, ['screen', 'whiteboard'] as const, defaults.defaultEntryMode),
    whiteboardBackground: pick(record.whiteboardBackground, ['white', 'black'] as const, defaults.whiteboardBackground),
    eraserMode: pick(record.eraserMode, ['stroke', 'object'] as const, defaults.eraserMode),
    laserMode: pick(record.laserMode, ['trail', 'writing'] as const, defaults.laserMode),
    penCursorStyle: pick(record.penCursorStyle, ['pen', 'dot'] as const, defaults.penCursorStyle),
    crosshairCursorStyle: pick(record.crosshairCursorStyle, ['crosshair', 'dot'] as const, defaults.crosshairCursorStyle),
    strokeSmoothing: pick(record.strokeSmoothing, ['off', 'standard', 'strong'] as const, defaults.strokeSmoothing),
    autoRevertToPen: record.autoRevertToPen === true,
    preserveDrawings: record.preserveDrawings === true,
    whiteboardPreserveDrawings: record.whiteboardPreserveDrawings === true,
    lineWidths: resolveLineWidths(record.lineWidths as Partial<ToolLineWidths> | null),
    theme: pick(record.theme, ['dark', 'light', 'system'] as const, defaults.theme),
  }
}

export function loadSettings(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): ScreendrawSettings {
  if (!storage) return defaultSettings()
  try {
    return resolveSettings(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null'))
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(
  settings: ScreendrawSettings,
  storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage,
): ScreendrawSettings {
  const normalized = resolveSettings(settings)
  storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
  return normalized
}
