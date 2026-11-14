<script setup lang="ts">
/**
 * OverlayApp — 全屏透明标注层（自 MarkerOn DrawingOverlay.vue 适配 OTools 插件环境）。
 *
 * 环境边界改动（绘制/指针/键盘逻辑保持原样）：
 * - 两窗口工具栏架构 → 页内悬浮 ToolToolbar（本地状态，无 overlayBridge 事件总线）；
 * - MarkerOn 原生 invoke → settings(localStorage) / overlayHost / SDK capture；
 * - 会话由 Panel 的 `otools-screendraw:cmd`（事件 + localStorage 邮箱双通道）驱动；
 *   穿透模式期间注册全局 X / Escape 保底快捷键（退出即释放）。
 */
import { ref, shallowRef, onMounted, onUnmounted, nextTick, computed, watch } from 'vue'
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useDrawing, type Tool, type DrawAction } from '../core/composables/useDrawing'
import type { TextOutlineStyle } from '../core/composables/drawingTypes'
import { useTooltip } from '../core/composables/useTooltip'
import {
  createKeyDownHandler,
  trackCopyModifierKeyUp,
  resetCopyModifierState,
  invalidateCopyModifierForPointerInteraction,
  markPointerInteractionEnded,
} from '../core/composables/useOverlayKeyboard'
import { setStrokeSmoothing } from '../core/composables/strokeSmoothingState'
import TextBox from './TextBox.vue'
import ToolToolbar from './ToolToolbar.vue'
import { overlayHost } from './hostBridge'
import { onOverlayCommand, type OverlayCommandAction } from '../commandChannel'
import { capture } from 'otools-plugin-sdk/capture'
import { loadSettings, saveSettings, SETTINGS_STORAGE_KEY, type ScreendrawSettings } from '../settings'
import {
  TOOL_ICON_MAP,
  WIDTH_PRESETS,
  eraserLineWidth,
  isDashableTool,
  nextStrokeDashStyle,
  resolveLineWidths,
  type StrokeDashStyle,
} from '../core/constants/tools'
import {
  cycleStampKind as cycleStampKindState,
  getStampKind,
  resetActiveStampCounter,
  stampFontSizeFromWidth,
  takeStampLabel,
} from '../core/constants/stamp'
import { createDefaultTextOutline, normalizeTextOutline } from '../core/constants/textOutline'
import {
  EMPTY_TEXT_RMB_CLICK,
  TEXT_RMB_DOUBLE_MS,
  noteTextRmbClick,
  type TextRmbClickState,
} from '../core/utils/textRmbDoubleClick'
import {
  IDLE_RMB_ERASE,
  beginRmbErase,
  canStartRmbErase,
  endRmbErase,
  type RmbEraseGesture,
} from '../core/utils/rmbHoldErase'
import { COLOR_PALETTE } from '../core/constants/colors'
import { isMacOS, MAC_HIDDEN_CURSOR, setMacOverlaySystemCursorHidden } from '../core/utils/platform'
import { canStartElementDrag as canStartElementDragGate } from '../core/utils/dragInteraction'
import { isDragEnabled, resolveDragMode, type DragMode } from '../core/utils/dragMode'
import { isToolbarPinned, resolveToolbarVisibility, type ToolbarVisibility } from '../core/utils/toolbarSettings'
import { resolveDefaultEntryMode, shouldClearWhiteboardOnEntry, type DefaultEntryMode } from '../core/utils/entryMode'
import {
  resolveWhiteboardBackground,
  whiteboardBackgroundColor,
  type WhiteboardBackground,
} from '../core/utils/whiteboardBackground'
import { logDiagnostic, logSessionEvent, logActionEvent } from '../core/utils/diagnosticEvents'
import { nextEraserMode, resolveEraserMode, type EraserMode } from '../core/utils/eraserMode'
import { resolveLaserMode } from '../core/utils/laserMode'
import { nextPenCursorStyle, resolvePenCursorStyle, type PenCursorStyle } from '../core/utils/penCursor'
import {
  nextCrosshairCursorStyle,
  resolveCrosshairCursorStyle,
  usesCrosshairCursor,
  type CrosshairCursorStyle,
} from '../core/utils/crosshairCursor'
import { resolveToolbarSelectTool } from '../core/utils/toolbarSelectTool'
import { resolveStrokeSmoothing } from '../core/utils/strokeSmoothing'
import { resolveAutoRevertToPen, toolAfterShapeStroke } from '../core/utils/autoRevertToPen'
import { noteStableViewportSample } from '../core/utils/overlayViewport'
import { normalizePressure } from '../core/constants/penStroke'
import { useI18n } from '../i18n'

const { t } = useI18n()

/** 工具栏动作（原 overlayBridge.ToolbarAction 的页内副本）。 */
type ToolbarAction =
  | { type: 'selectTool'; tool: Tool }
  | { type: 'selectColor'; color: string }
  | { type: 'updateLineWidth'; width: number }
  | { type: 'updateTextOutline'; textOutline: TextOutlineStyle }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clearAll' }
  | { type: 'toggleWhiteboard' }
  | { type: 'copy' }
  | { type: 'togglePenetration' }
  | { type: 'togglePin' }
  | { type: 'exitDrawing' }

type ExitReason = 'keyboard' | 'toolbar' | 'shortcut' | 'cmd' | 'unknown'

function modDown(e: PointerEvent | KeyboardEvent): boolean {
  return e.ctrlKey || (isMacOS() && e.metaKey)
}

function snapLineModifierDown(e: PointerEvent): boolean {
  return e.altKey
}

const toolIconMap = TOOL_ICON_MAP

const historyCanvasRef = ref<HTMLCanvasElement | null>(null)
const previewCanvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const textBoxRef = ref<InstanceType<typeof TextBox> | null>(null)
const active = ref(false)
const penetrationMode = ref(false)
type OverlaySessionMode = 'hidden' | 'drawing' | 'penetration'
let lastOverlayMode: OverlaySessionMode = 'hidden'
/** overlay 窗口是否处于隐藏态（exitDrawing 隐藏后置位；cmd start 时先 show 再续会话）。 */
const overlayHidden = ref(false)
const toolbarVisibility = ref<ToolbarVisibility>('space')
const toolbarPinned = computed(() => isToolbarPinned(toolbarVisibility.value))
const showToolbarPopup = ref(false)
/** Space 呼出弹出层时的锚点（页内 CSS px = 指针位置）。 */
const toolbarAnchor = ref({ x: 0, y: 0 })
const toolbarPanelHovered = ref(false)
const toolbarPanelDragging = ref(false)
/** Hide overlay chrome during screen capture so panels are not in the clipboard image. */
const hideUiForCapture = ref(false)
const sessionActive = computed(() => active.value || penetrationMode.value)
/** 页内工具栏可见性：会话中且非穿透，常驻或弹出；截图时一并隐藏。 */
const showToolbar = computed(
  () =>
    sessionActive.value &&
    !penetrationMode.value &&
    !hideUiForCapture.value &&
    (toolbarPinned.value || showToolbarPopup.value),
)
const mousePos = ref({ x: 0, y: 0 })
const textBoxPos = ref<{ x: number; y: number } | null>(null)
const whiteboardMode = ref(false)
const defaultEntryMode = ref<DefaultEntryMode>('screen')
const whiteboardBackground = ref<WhiteboardBackground>('white')
const whiteboardBgColor = computed(() => whiteboardBackgroundColor(whiteboardBackground.value))

const toolLabelMap = computed<Record<Tool, string>>(() => ({
  select: t('tools.select'),
  pen: t('tools.pen'),
  highlighter: t('tools.highlighter'),
  laser: t('tools.laser'),
  arrow: t('tools.arrow'),
  rect: t('tools.rect'),
  ellipse: t('tools.ellipse'),
  line: t('tools.line'),
  eraser: t('tools.eraser'),
  text: t('tools.text'),
  stamp: t('tools.stamp'),
}))

const colorNameMap = computed<Record<string, string>>(() => ({
  '#FF3B30': t('colors.#FF3B30'),
  '#FF6B35': t('colors.#FF6B35'),
  '#FFCC02': t('colors.#FFCC02'),
  '#34C759': t('colors.#34C759'),
  '#007AFF': t('colors.#007AFF'),
  '#5856D6': t('colors.#5856D6'),
  '#FFFFFF': t('colors.#FFFFFF'),
  '#000000': t('colors.#000000'),
}))

const {
  state: tooltip,
  showTool: showToolTip,
  showColor: showColorTip,
  showWidth: showWidthTip,
  showMessage: showTip,
  dispose: disposeTooltip,
} = useTooltip({ toolLabelMap, colorNameMap, t })

const toolTip = tooltip.text
const toolTipTool = tooltip.tool
const toolTipColor = tooltip.color
const toolTipWidth = tooltip.width

const showQuickColors = ref(false)
const quickColorsPos = ref({ x: 0, y: 0 })

/** Double right-click while editing text commits (issue #32). */
let textRmbClick: TextRmbClickState = { ...EMPTY_TEXT_RMB_CLICK }
/** Swallow trailing contextmenu after text confirm so the palette does not open. */
let suppressQuickColorsUntil = 0

let rmbEraseGesture: RmbEraseGesture = IDLE_RMB_ERASE
let rmbErasePointerId: number | null = null

function resetTextRmbDoubleClick() {
  textRmbClick = { ...EMPTY_TEXT_RMB_CLICK }
}

/**
 * While a text box is open: first RMB arms a timer; second nearby RMB commits.
 * Returns true when the event was handled for text editing (do not open quick colors).
 */
function handleTextBoxContextMenu(e: MouseEvent): boolean {
  if (performance.now() < suppressQuickColorsUntil) return true
  if (!active.value || penetrationMode.value || !textBoxPos.value) return false
  // macOS maps Control+click to right-click; skip after a Control+drag.
  if (isMacOS() && e.ctrlKey && pointerMovedSinceDown) return true

  const { isDouble, next } = noteTextRmbClick(textRmbClick, e.clientX, e.clientY, performance.now())
  textRmbClick = next
  if (!isDouble) return true

  hideToolbarPopupForCanvasInteraction()
  showQuickColors.value = false
  commitCurrentTextBox(false)
  // Double-RMB often delivers an extra contextmenu after the box is gone; block palette briefly.
  suppressQuickColorsUntil = performance.now() + TEXT_RMB_DOUBLE_MS + 150
  logActionEvent('text committed', { reason: 'double-right-click' })
  return true
}

const quickColorList = COLOR_PALETTE

function cycleColor(direction: number) {
  const idx = quickColorList.indexOf(currentColor.value)
  const newIdx = idx === -1 ? 0 : (idx + direction + quickColorList.length) % quickColorList.length
  currentColor.value = quickColorList[newIdx]
  showColorTip(currentColor.value)
}

async function onRmbPointerDown(e: PointerEvent) {
  if (rmbEraseGesture.active) return
  if (
    !canStartRmbErase({
      active: active.value,
      penetration: penetrationMode.value,
      textBoxOpen: !!textBoxPos.value,
    })
  ) {
    return
  }
  if (isMacOS() && e.ctrlKey && pointerMovedSinceDown) return

  // Same layout gate as LMB: idle/DPI catch-up must finish before erase ink commits.
  if (!(await ensureOverlayLayoutForPointer(e, 2))) return
  if (
    !canStartRmbErase({
      active: active.value,
      penetration: penetrationMode.value,
      textBoxOpen: !!textBoxPos.value,
    })
  ) {
    return
  }

  // Drop in-progress select gestures so RMB erase receives moves; keep selectedActions.
  cancelSelectGestures()

  rmbEraseGesture = beginRmbErase(currentTool.value)
  rmbErasePointerId = e.pointerId
  pointerDownClient = { x: e.clientX, y: e.clientY }
  pointerMovedSinceDown = false
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  invalidateCopyModifierForPointerInteraction()
  hideToolbarPopupForCanvasInteraction()
  currentTool.value = 'eraser'
  capturePointer(e)
  startDraw({
    x: e.clientX,
    y: e.clientY,
    pressure: normalizePressure(e.pressure),
    pointerType: e.pointerType,
  })
  logActionEvent('rmb erase start', { toolBefore: rmbEraseGesture.toolBefore })
}

function finishRmbErasePointerUp(e: PointerEvent): boolean {
  if (rmbErasePointerId === null || e.pointerId !== rmbErasePointerId) return false

  const end = endRmbErase(rmbEraseGesture)
  rmbEraseGesture = end.next
  rmbErasePointerId = null

  const wasDrawing = isDrawing.value
  releaseCapturedPointer()
  if (wasDrawing) {
    endDraw()
  }
  if (end.restoreTool !== null) {
    currentTool.value = end.restoreTool as Tool
  }
  markPointerInteractionEnded()
  resetPointerGestureState()
  if (end.wasActive && wasDrawing) {
    logDiagnostic('pointer', 'stroke end', {
      pointerType: e.pointerType,
      button: e.button,
      reason: 'rmb-erase',
    })
  }
  return true
}

function resetRmbEraseGesture() {
  if (!rmbEraseGesture.active && rmbErasePointerId === null) return
  const end = endRmbErase(rmbEraseGesture)
  rmbEraseGesture = end.next
  rmbErasePointerId = null
  if (end.restoreTool !== null) {
    currentTool.value = end.restoreTool as Tool
  }
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  if (handleTextBoxContextMenu(e)) return
  // Right-click is erase-on-hold; never open the old quick-color panel.
}

function onWheel(e: WheelEvent) {
  if (!active.value || !e.ctrlKey) return
  e.preventDefault()
  const tool = currentTool.value
  const dir = e.deltaY < 0 ? 1 : -1
  const idx = WIDTH_PRESETS.indexOf(lineWidth.value)
  const cur =
    idx !== -1
      ? idx
      : Math.max(
          0,
          WIDTH_PRESETS.findIndex((v) => v >= lineWidth.value),
        )
  const next = Math.max(0, Math.min(WIDTH_PRESETS.length - 1, cur + dir))
  // Pass current pointer so mid-gesture eraser resize splits at the cursor (not old path points).
  setLineWidth(WIDTH_PRESETS[next], { x: lastPointerX, y: lastPointerY })
  const labelKey = tool === 'text' || tool === 'stamp' ? `textSizes.${lineWidth.value}` : `widths.${lineWidth.value}`
  showWidthTip(lineWidth.value, t(labelKey))
  schedulePersistLineWidths()
  // Wheel often does not fire pointermove; re-anchor cursor so eraser scales from center.
  updateCursorEl(lastPointerX, lastPointerY)
}

const {
  currentTool,
  currentColor,
  lineWidth,
  lineWidths,
  setLineWidths,
  setLineWidth,
  eraserMode,
  setEraserMode,
  setLaserMode,
  shapeDashStyle,
  setShapeDashStyle,
  isDrawing,
  startDraw,
  draw,
  drawBatch,
  endDraw,
  getActiveStrokePointCount,
  getStrokeSamplingStats,
  addTextAction,
  addStampAction,
  findActionAt,
  findActionsInRect,
  removeAction,
  removeSelected,
  selectedActions,
  clearSelection,
  setSelection,
  toggleInSelection,
  isActionSelected,
  findSelectedActionAt,
  setMarqueeRect,
  undo,
  redo,
  canUndo,
  canRedo,
  canClear,
  clearAll,
  exportAsDataURL,
  hardReset,
  redrawAll,
  beginDrag,
  beginDragMany,
  updateDragOffset,
  endDrag,
  cancelDrag,
  findReshapeHandleAt,
  beginReshape,
  updateReshape,
  endReshape,
  destroy,
} = useDrawing(historyCanvasRef, previewCanvasRef)

const textFontSize = computed(() => Math.max(16, lineWidth.value * 6))
const eraserCursorDiameter = computed(() => Math.min(80, eraserLineWidth(lineWidth.value)))
const eraserCursorRadius = computed(() => eraserCursorDiameter.value / 2)
const textOutline = ref<TextOutlineStyle>(createDefaultTextOutline())

const activeTextBoxColor = ref('#FF0000')
const activeTextBoxFontSize = ref(24)
const activeTextBoxInitialText = ref('')
const activeTextBoxOutline = ref<TextOutlineStyle>(createDefaultTextOutline())
const editingOriginalAction = shallowRef<DrawAction | null>(null)

// ---------------------------------------------------------------------------
// 设置（同源 localStorage：Panel 写 / Overlay 读 + storage 事件热更新）
// ---------------------------------------------------------------------------

const dragMode = ref<DragMode>('off')
const penCursorStyle = ref<PenCursorStyle>('pen')
const crosshairCursorStyle = ref<CrosshairCursorStyle>('crosshair')
const pointerModDown = ref(false)
const preserveDrawings = ref(false)
const whiteboardPreserveDrawings = ref(true)
const autoRevertToPen = ref(false)

function applySettings(s: ScreendrawSettings): void {
  dragMode.value = resolveDragMode(s)
  toolbarVisibility.value = resolveToolbarVisibility(s)
  defaultEntryMode.value = resolveDefaultEntryMode(s)
  whiteboardBackground.value = resolveWhiteboardBackground(s)
  setEraserMode(resolveEraserMode(s))
  setLaserMode(resolveLaserMode(s))
  penCursorStyle.value = resolvePenCursorStyle(s)
  crosshairCursorStyle.value = resolveCrosshairCursorStyle(s)
  setStrokeSmoothing(resolveStrokeSmoothing(s))
  autoRevertToPen.value = resolveAutoRevertToPen(s)
  setLineWidths(resolveLineWidths(s.lineWidths))
  preserveDrawings.value = s.preserveDrawings
  whiteboardPreserveDrawings.value = s.whiteboardPreserveDrawings
}

function onSettingsStorage(e: StorageEvent): void {
  // e.key === null 表示 localStorage.clear()；其余只响应设置 key。
  if (e.key !== null && e.key !== SETTINGS_STORAGE_KEY) return
  applySettings(loadSettings())
}

function persistSettingsPatch(patch: Partial<ScreendrawSettings>): void {
  try {
    saveSettings({ ...loadSettings(), ...patch })
  } catch (error) {
    console.error('[screendraw] save settings failed', error)
  }
}

// ---------------------------------------------------------------------------
// 页内工具栏：弹出层显隐 / 固定切换（本地状态，无跨窗口事件）
// ---------------------------------------------------------------------------

function setToolbarPopupVisible(visible: boolean) {
  if (toolbarPinned.value) return
  if (showToolbarPopup.value === visible) return
  showToolbarPopup.value = visible
  if (!visible) {
    toolbarPanelHovered.value = false
    toolbarPanelDragging.value = false
    return
  }
  toolbarAnchor.value = { x: lastPointerX, y: lastPointerY }
  logActionEvent('toolbar popup opened', {
    pointerClient: { x: lastPointerX, y: lastPointerY },
    overlayViewport: { width: window.innerWidth, height: window.innerHeight },
  })
}

function toggleToolbarPopupVisible() {
  if (toolbarPinned.value) return
  setToolbarPopupVisible(!showToolbarPopup.value)
}

function hideToolbarPopupForCanvasInteraction() {
  if (!toolbarPinned.value && showToolbarPopup.value) {
    showToolbarPopup.value = false
    toolbarPanelHovered.value = false
    toolbarPanelDragging.value = false
  }
}

function toggleToolbarPin() {
  const nextVisibility: ToolbarVisibility = toolbarPinned.value ? 'space' : 'always'
  toolbarVisibility.value = nextVisibility
  persistSettingsPatch({ toolbarVisibility: nextVisibility })
  logActionEvent('toolbar pin toggled', { reason: 'toolbar', visibility: nextVisibility })
}

/**
 * Restore a real modifier-temp tool, or optionally snap one-shot shapes back to pen.
 * Abort paths pass `allowAutoRevert: false` so interrupted sticky shapes stay selected.
 */
function restoreToolAfterStroke(options?: { allowAutoRevert?: boolean }) {
  const next = toolAfterShapeStroke({
    autoRevertToPen: autoRevertToPen.value,
    toolBeforeModifier,
    currentTool: currentTool.value,
    allowAutoRevert: options?.allowAutoRevert !== false,
  })
  toolBeforeModifier = null
  if (next !== null) currentTool.value = next
}

let persistLineWidthsTimer: ReturnType<typeof setTimeout> | null = null

function schedulePersistLineWidths() {
  if (persistLineWidthsTimer !== null) clearTimeout(persistLineWidthsTimer)
  persistLineWidthsTimer = setTimeout(() => {
    persistLineWidthsTimer = null
    persistLineWidths()
  }, 250)
}

/** Cancel debounce and persist immediately (exit drawing / unmount). */
function flushPersistLineWidths() {
  if (persistLineWidthsTimer === null) return
  clearTimeout(persistLineWidthsTimer)
  persistLineWidthsTimer = null
  persistLineWidths()
}

function persistLineWidths() {
  persistSettingsPatch({ lineWidths: resolveLineWidths(lineWidths.value) })
}

function applyDefaultEntryOnActivate() {
  if (defaultEntryMode.value === 'whiteboard') {
    void enterWhiteboardMode({ fromDefaultEntry: true })
  } else {
    whiteboardMode.value = false
  }
}

async function enterWhiteboardMode(options?: { fromDefaultEntry?: boolean }) {
  if (whiteboardMode.value) return
  await resumeDrawingFromToolbar()
  if (
    shouldClearWhiteboardOnEntry({
      whiteboardPreserveDrawings: whiteboardPreserveDrawings.value,
      preserveDrawings: preserveDrawings.value,
      fromDefaultEntry: options?.fromDefaultEntry ?? false,
      hasDrawings: canClear.value,
    })
  ) {
    hardReset()
    logActionEvent('canvas hard reset', { reason: 'whiteboard-entry' })
  }
  // 白板底色直接画在画布/容器层（set_whiteboard_mode 纯本地化）。
  whiteboardMode.value = true
  showQuickColors.value = false
  textBoxPos.value = null
  if (!options?.fromDefaultEntry) {
    currentTool.value = 'pen'
  }
  logSessionEvent('whiteboard entered', {
    fromDefaultEntry: options?.fromDefaultEntry ?? false,
  })
  showTip(t('overlay.whiteboardReady'))
}

function exitWhiteboardMode() {
  if (!whiteboardMode.value) return
  whiteboardMode.value = false
  showQuickColors.value = false
  textBoxPos.value = null
  if (!whiteboardPreserveDrawings.value) {
    hardReset()
    logActionEvent('canvas hard reset', { reason: 'whiteboard-exit' })
  }
  logSessionEvent('whiteboard exited')
  showTip(t('overlay.whiteboardExit'))
}

const hoveredActionInfo = shallowRef<{ action: DrawAction; index: number } | null>(null)
/** Select tool: pointer is inside a selected action's bbox (drag-from-frame). */
const pointerOverSelectionBbox = ref(false)
/** Select tool: pointer over a reshape handle (endpoint / corner). */
const pointerOverReshapeHandle = ref(false)
const reshapeHandleCursor = ref('default')
const isMoving = ref(false)
const isReshaping = ref(false)
let hoverRafId: number | null = null
let isDragging = false
let isMarqueeSelecting = false
let marqueeAdditive = false
let marqueeStartX = 0
let marqueeStartY = 0
let dragStartX = 0
let dragStartY = 0
let capturedPointerId: number | null = null
/** Suppress Control+click context menu after Control+drag (macOS maps ctrl+click to right-click). */
let pointerDownClient: { x: number; y: number } | null = null
let pointerMovedSinceDown = false
const CONTEXT_MENU_DRAG_THRESHOLD_PX = 5
let lastPointerX = 0
let lastPointerY = 0
/** Gate custom SVG cursor until the first real pointermove seeds its position. */
const customCursorPositionReady = ref(true)

watch(currentTool, (tool, prev) => {
  if (prev === 'select' && tool !== 'select') {
    // RMB hold-erase temporarily swaps to eraser: gestures already cancelled in
    // onRmbPointerDown; keep selectedActions for when select is restored.
    if (rmbEraseGesture.active) return
    cancelSelectGestures()
    clearSelection()
    clearSelectionHover()
  }
})

function cancelMarqueeSelection() {
  if (isMarqueeSelecting) isMarqueeSelecting = false
  setMarqueeRect(null)
}

function clearSelectionHover() {
  pointerOverSelectionBbox.value = false
  pointerOverReshapeHandle.value = false
  reshapeHandleCursor.value = 'default'
}

function cancelSelectGestures() {
  let cancelled = false
  if (isReshaping.value || isDragging) {
    isReshaping.value = false
    isDragging = false
    isMoving.value = false
    cancelDrag()
    cancelled = true
  }
  if (isMarqueeSelecting) {
    cancelMarqueeSelection()
    cancelled = true
  }
  return cancelled
}

function onGlobalPointerUp(e: PointerEvent) {
  if (capturedPointerId === null || e.pointerId !== capturedPointerId) return
  onPointerUp(e)
}

function onGlobalPointerMove(e: PointerEvent) {
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  mousePos.value = { x: e.clientX, y: e.clientY }
  // 会话内第一次真实 pointermove 到达后才显示自定义光标（避免开场闪现在 0,0）。
  if (!customCursorPositionReady.value) customCursorPositionReady.value = true
}

watch(
  sessionActive,
  (isLive) => {
    if (isLive) {
      window.addEventListener('pointermove', onGlobalPointerMove, { passive: true })
      window.addEventListener('pointerup', onGlobalPointerUp)
      window.addEventListener('pointercancel', onGlobalPointerUp)
    } else {
      window.removeEventListener('pointermove', onGlobalPointerMove)
      window.removeEventListener('pointerup', onGlobalPointerUp)
      window.removeEventListener('pointercancel', onGlobalPointerUp)
    }
  },
  { immediate: true },
)

// Cap total canvas bitmap pixels to keep drawImage / clearRect fast on
// high-resolution displays with low scale factors (e.g. 4K @ 150% → 2560×1440
// CSS viewport, 8.3M bitmap pixels). The budget is set so that typical laptop
// displays (e.g. 2880×1800 @ 200%) are unaffected.
const MAX_CANVAS_PIXELS = 9_000_000

function getEffectiveDpr(): number {
  const rawDpr = window.devicePixelRatio || 1
  const cssW = window.innerWidth
  const cssH = window.innerHeight
  const rawPixels = cssW * rawDpr * cssH * rawDpr
  if (rawPixels <= MAX_CANVAS_PIXELS) return rawDpr
  return Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)))
}

function overlayCanvasLayoutSize(): { bitmapW: number; bitmapH: number; cssW: string; cssH: string } | null {
  if (window.innerWidth <= 0 || window.innerHeight <= 0) return null
  const dpr = getEffectiveDpr()
  return {
    bitmapW: Math.round(window.innerWidth * dpr),
    bitmapH: Math.round(window.innerHeight * dpr),
    cssW: window.innerWidth + 'px',
    cssH: window.innerHeight + 'px',
  }
}

function overlayCanvasMatchesLayout(): boolean {
  const historyCanvas = historyCanvasRef.value
  const previewCanvas = previewCanvasRef.value
  const next = overlayCanvasLayoutSize()
  if (!historyCanvas || !previewCanvas || !next) return false
  return [historyCanvas, previewCanvas].every(
    (canvas) =>
      canvas.width === next.bitmapW &&
      canvas.height === next.bitmapH &&
      canvas.style.width === next.cssW &&
      canvas.style.height === next.cssH,
  )
}

function resizeCanvas() {
  const historyCanvas = historyCanvasRef.value
  const previewCanvas = previewCanvasRef.value
  const next = overlayCanvasLayoutSize()
  if (!historyCanvas || !previewCanvas || !next) return

  let bitmapChanged = false
  let cssChanged = false
  for (const canvas of [historyCanvas, previewCanvas]) {
    if (canvas.width !== next.bitmapW || canvas.height !== next.bitmapH) {
      canvas.width = next.bitmapW
      canvas.height = next.bitmapH
      bitmapChanged = true
    }
    if (canvas.style.width !== next.cssW || canvas.style.height !== next.cssH) {
      canvas.style.width = next.cssW
      canvas.style.height = next.cssH
      cssChanged = true
    }
  }

  // Re-assigning canvas.width to the same value still clears the bitmap in Chromium.
  // Skip that when a deferred geometry pulse did not actually change layout.
  if (bitmapChanged || cssChanged) redrawAll()
}

/** False while overlay canvas is catching up after a monitor move / DPI change. */
const overlayLayoutReady = ref(false)
let overlayResizeGeneration = 0
let overlayResizeInFlight: Promise<void> | null = null

/** Wait for Win32/WebView2 to finish DPI relayout after a monitor move. */
function afterLayoutFrames(frameCount = 2): Promise<void> {
  return new Promise((resolve) => {
    const step = (remaining: number) => {
      if (remaining <= 0) {
        resolve()
        return
      }
      let settled = false
      const next = () => {
        if (settled) return
        settled = true
        step(remaining - 1)
      }
      requestAnimationFrame(next)
      // Hidden overlay webviews throttle rAF; keep activation from stalling.
      window.setTimeout(next, 32)
    }
    step(frameCount)
  })
}

function viewportLayoutKey(): string {
  return `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`
}

/** Layout key from the last hidden session — reject early "stable" samples after cross-monitor activate. */
let staleViewportKey: string | null = null

/**
 * Wait until CSS viewport + DPR stop changing (WebView2 per-monitor DPI catch-up).
 * @returns true when the viewport held steady for `neededStable` samples.
 */
async function waitForStableViewport(): Promise<boolean> {
  const maxFrames = isMacOS() ? 4 : 16
  const neededStable = isMacOS() ? 1 : 3
  // Reject a few samples of the previous monitor size; keep this short so same-monitor
  // reactivation (common path) does not add ~200ms before strokes are allowed.
  const allowStaleAfterSamples = isMacOS() ? 0 : 3
  let state = { last: '', stable: 0 }
  for (let i = 0; i < maxFrames; i++) {
    await afterLayoutFrames(1)
    if (window.innerWidth <= 0) {
      state = { last: '', stable: 0 }
      continue
    }
    const key = viewportLayoutKey()
    const next = noteStableViewportSample(key, state, {
      neededStable,
      staleKey: staleViewportKey,
      sampleIndex: i,
      allowStaleAfterSamples,
    })
    state = { last: next.last, stable: next.stable }
    if (staleViewportKey && key !== staleViewportKey) {
      staleViewportKey = null
    }
    if (next.accepted) return true
  }
  return false
}

/**
 * Resize overlay canvases after Win32/WebView2 geometry settles.
 *
 * Every caller awaits until `overlayLayoutReady` is true for the latest generation.
 * 首次挂载的自适配（setPosition/setSize）触发 onResized → debouncedResize 走同一代数门，
 * 避免以旧视口尺寸落笔。
 */
async function scheduleOverlayResize(): Promise<void> {
  overlayLayoutReady.value = false
  overlayResizeGeneration += 1

  if (!overlayResizeInFlight) {
    overlayResizeInFlight = (async () => {
      try {
        let unsettledPasses = 0
        while (true) {
          const generation = overlayResizeGeneration
          const settled = await waitForStableViewport()
          if (generation !== overlayResizeGeneration) continue
          resizeCanvas()

          if (!isMacOS()) {
            await afterLayoutFrames(2)
            if (generation !== overlayResizeGeneration) continue
            resizeCanvas()
          }

          watchDpr()
          if (generation !== overlayResizeGeneration) continue

          // If DPI never settled, avoid marking ready on a mismatched canvas; retry once.
          if (!settled && !overlayCanvasMatchesLayout() && unsettledPasses < 1) {
            unsettledPasses += 1
            continue
          }

          overlayLayoutReady.value = true
          return
        }
      } finally {
        overlayResizeInFlight = null
      }
    })()
  }

  await overlayResizeInFlight

  // A concurrent schedule may have flipped ready back to false after this pass
  // finished; keep waiting so activate / pointer-down never proceed on a stale layout.
  if (!overlayLayoutReady.value) {
    await scheduleOverlayResize()
  }
}

/** Await DPI/layout ready before starting a pointer stroke; false = abort the gesture. */
async function ensureOverlayLayoutForPointer(e: PointerEvent, buttonBit: number): Promise<boolean> {
  if (overlayLayoutReady.value) return true
  await scheduleOverlayResize()
  if (!active.value || penetrationMode.value) return false
  if ((e.buttons & buttonBit) === 0) {
    markPointerInteractionEnded()
    resetPointerGestureState()
    return false
  }
  return true
}

let toolBeforeModifier: string | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let dprMediaQuery: MediaQueryList | null = null

function debouncedResize() {
  if (resizeTimer) clearTimeout(resizeTimer)
  // Route through scheduleOverlayResize so DPI/size changes share the same
  // generation + layout-ready gate as activate (avoids mid-stroke
  // bare resizeCanvas racing preview→history commit).
  resizeTimer = setTimeout(() => {
    void scheduleOverlayResize()
  }, 100)
}

function watchDpr() {
  dprMediaQuery?.removeEventListener('change', onDprChange)
  dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprMediaQuery.addEventListener('change', onDprChange)
}

function onDprChange() {
  debouncedResize()
  watchDpr()
}

function commitCurrentTextBox(cancel = false) {
  if (textBoxRef.value && textBoxPos.value) {
    if (cancel && editingOriginalAction.value) {
      // Cancel edit: restore the original text action
      const a = editingOriginalAction.value
      addTextAction(a.text!, a.points[0].x, a.points[0].y, 0, a.fontSize!, a.color, normalizeTextOutline(a.textOutline))
    } else if (!cancel) {
      const text = textBoxRef.value.getText()
      const actualFs = textBoxRef.value.getFontSize()
      if (text.trim()) {
        addTextAction(
          text,
          textBoxPos.value.x,
          textBoxPos.value.y,
          0,
          actualFs,
          activeTextBoxColor.value,
          activeTextBoxOutline.value,
        )
      }
    }
    textBoxPos.value = null
    editingOriginalAction.value = null
    resetTextRmbDoubleClick()
  }
}

function canStartElementDrag(e: PointerEvent): boolean {
  if (currentTool.value === 'eraser' || currentTool.value === 'select') return false
  return canStartElementDragGate({
    dragMode: dragMode.value,
    hasHoveredElement: !!hoveredActionInfo.value,
    modifierDown: modDown(e),
  })
}

function wantsHoverHitTest(): boolean {
  return isDragEnabled(dragMode.value) || currentTool.value === 'select'
}

function finishMarqueeSelection(clientX: number, clientY: number) {
  const rect = {
    x1: marqueeStartX,
    y1: marqueeStartY,
    x2: clientX,
    y2: clientY,
  }
  const dx = clientX - marqueeStartX
  const dy = clientY - marqueeStartY
  const moved = dx * dx + dy * dy > CONTEXT_MENU_DRAG_THRESHOLD_PX * CONTEXT_MENU_DRAG_THRESHOLD_PX

  isMarqueeSelecting = false
  setMarqueeRect(null)

  if (!moved) {
    if (!marqueeAdditive) setSelection([])
    return
  }

  const hits = findActionsInRect(rect)
  if (marqueeAdditive) {
    const merged = [...selectedActions.value]
    for (const action of hits) {
      if (!merged.includes(action)) merged.push(action)
    }
    setSelection(merged)
  } else {
    setSelection(hits)
  }
}

function onDoubleClick(e: MouseEvent) {
  if (e.button !== 0) return
  if (penetrationMode.value || showQuickColors.value) return

  const pos = { x: e.clientX, y: e.clientY }
  const clickedActionInfo = findActionAt(pos)

  if (clickedActionInfo && clickedActionInfo.action.tool === 'text') {
    hideToolbarPopupForCanvasInteraction()
    if (textBoxPos.value) {
      commitCurrentTextBox()
    }

    const { action, index } = clickedActionInfo
    editingOriginalAction.value = action
    removeAction(index)

    activeTextBoxColor.value = action.color
    activeTextBoxFontSize.value = action.fontSize ?? 24
    activeTextBoxInitialText.value = action.text ?? ''
    activeTextBoxOutline.value = normalizeTextOutline(action.textOutline)
    textOutline.value = normalizeTextOutline(action.textOutline)

    currentTool.value = 'text'

    nextTick(() => {
      textBoxPos.value = { x: action.points[0].x, y: action.points[0].y }
    })
  } else if (currentTool.value === 'text') {
    // In text mode, double-click on empty area to create new text
    hideToolbarPopupForCanvasInteraction()
    if (textBoxPos.value) {
      commitCurrentTextBox()
    }
    activeTextBoxColor.value = currentColor.value
    activeTextBoxFontSize.value = textFontSize.value
    activeTextBoxInitialText.value = ''
    activeTextBoxOutline.value = normalizeTextOutline(textOutline.value)
    nextTick(() => {
      textBoxPos.value = pos
    })
  }
}

function capturePointer(e: PointerEvent) {
  previewCanvasRef.value?.setPointerCapture(e.pointerId)
  capturedPointerId = e.pointerId
}

function releaseCapturedPointer() {
  if (capturedPointerId === null || !previewCanvasRef.value) return
  try {
    previewCanvasRef.value.releasePointerCapture(capturedPointerId)
  } catch {
    // pointer already released
  }
  capturedPointerId = null
}

/**
 * Prefer high-frequency pen samples via pointerrawupdate when supported.
 * WebKit/WKWebView (macOS Tauri) does not implement it — never gate pointermove
 * on raw updates unless the event is actually available, or pen strokes stall.
 */
const supportsPointerRawUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window

let penRawUpdatesActive = false

function pointerSample(e: PointerEvent) {
  return { x: e.clientX, y: e.clientY, pressure: normalizePressure(e.pressure) }
}

function ingestDrawingPointer(e: PointerEvent) {
  if (!isDrawing.value) return
  const isPerfect = snapLineModifierDown(e)
  const coalesced = e.getCoalescedEvents?.()
  if (coalesced && coalesced.length > 0) {
    drawBatch(coalesced, isPerfect)
  } else {
    draw(pointerSample(e), isPerfect)
  }
}

function onPointerRawUpdate(e: Event) {
  if (!(e instanceof PointerEvent)) return
  if (!penRawUpdatesActive || !isDrawing.value) return
  if (capturedPointerId !== null && e.pointerId !== capturedPointerId) return
  ingestDrawingPointer(e)
}

function startPenRawUpdates(e: PointerEvent) {
  if (!supportsPointerRawUpdate || e.pointerType !== 'pen' || penRawUpdatesActive) return
  penRawUpdatesActive = true
  window.addEventListener('pointerrawupdate', onPointerRawUpdate)
}

function stopPenRawUpdates() {
  if (!penRawUpdatesActive) return
  penRawUpdatesActive = false
  window.removeEventListener('pointerrawupdate', onPointerRawUpdate)
}

function resetPointerGestureState() {
  pointerDownClient = null
  pointerMovedSinceDown = false
}

function finishActivePointerInteraction() {
  if (hoverRafId !== null) {
    cancelAnimationFrame(hoverRafId)
    hoverRafId = null
  }
  resetRmbEraseGesture()
  releaseCapturedPointer()
  if (isDragging) {
    const wasReshaping = isReshaping.value
    isDragging = false
    isReshaping.value = false
    isMoving.value = false
    if (wasReshaping) {
      endReshape()
    } else {
      endDrag()
    }
  } else if (isMarqueeSelecting) {
    cancelMarqueeSelection()
  } else if (isDrawing.value) {
    endDraw()
    restoreToolAfterStroke()
  }
  stopPenRawUpdates()
  hoveredActionInfo.value = null
  clearSelectionHover()
  pointerModDown.value = false
  markPointerInteractionEnded()
  resetPointerGestureState()
}

async function onPointerDown(e: PointerEvent) {
  if (e.button === 2) {
    await onRmbPointerDown(e)
    return
  }
  if (e.button !== 0) return
  if (penetrationMode.value || !active.value || showQuickColors.value) return

  // Space 呼出的弹出工具栏：点击面板外的画布区域先收起面板、不落笔
  // （对齐旧两窗口架构里 backdrop 吞掉点击的语义；面板自身的事件不会到达画布）。
  if (!toolbarPinned.value && showToolbarPopup.value) {
    hideToolbarPopupForCanvasInteraction()
    return
  }

  pointerDownClient = { x: e.clientX, y: e.clientY }
  pointerMovedSinceDown = false
  invalidateCopyModifierForPointerInteraction()

  // Layout wait can outlive the press; abort if primary button is already up.
  if (!(await ensureOverlayLayoutForPointer(e, 1))) return

  lastPointerX = e.clientX
  lastPointerY = e.clientY

  if (textBoxPos.value) {
    hideToolbarPopupForCanvasInteraction()
    commitCurrentTextBox()
    return
  }

  // Capture immediately so move/up events are not lost mid-gesture.
  const willInteract =
    currentTool.value === 'select' ||
    canStartElementDrag(e) ||
    (currentTool.value !== 'text' && currentTool.value !== 'stamp' && !penetrationMode.value)
  if (willInteract) {
    capturePointer(e)
  }

  // Select tool: click/marquee select, reshape handles, drag selected group (ignores dragMode).
  // Priority: reshape handle → stroke/bbox drag → marquee.
  if (currentTool.value === 'select') {
    hideToolbarPopupForCanvasInteraction()
    const pos = { x: e.clientX, y: e.clientY }
    // Always hit-test at down position — hoveredActionInfo can be a frame stale after await.
    // Handle hit wins over Shift multi-select so Shift+drag-handle can constrain from the start.
    const reshapeHandle = findReshapeHandleAt(pos)
    if (reshapeHandle && selectedActions.value.length === 1) {
      const action = selectedActions.value[0]
      isReshaping.value = true
      isDragging = true
      dragStartX = e.clientX
      dragStartY = e.clientY
      isMoving.value = true
      reshapeHandleCursor.value = reshapeHandle.cursor
      beginReshape(action, reshapeHandle.id, pos)
      updateReshape({ x: e.clientX, y: e.clientY }, e.shiftKey)
      return
    }

    const strokeHit = findActionAt(pos)
    const selectedBboxHit = findSelectedActionAt(pos)

    if (e.shiftKey) {
      if (strokeHit) {
        toggleInSelection(strokeHit.action)
        return
      }
      // Deselect by clicking anywhere in a selected action's bbox (not only the stroke).
      if (selectedBboxHit) {
        toggleInSelection(selectedBboxHit)
        return
      }
      // Shift + empty: additive marquee
      isMarqueeSelecting = true
      marqueeAdditive = true
      marqueeStartX = e.clientX
      marqueeStartY = e.clientY
      setMarqueeRect({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY })
      return
    }

    if (strokeHit && !isActionSelected(strokeHit.action)) {
      setSelection([strokeHit.action])
      isDragging = true
      dragStartX = e.clientX
      dragStartY = e.clientY
      isMoving.value = true
      beginDragMany([strokeHit.action])
      return
    }

    if (selectedBboxHit || strokeHit) {
      isDragging = true
      dragStartX = e.clientX
      dragStartY = e.clientY
      isMoving.value = true
      beginDragMany(
        selectedActions.value.length > 0 ? selectedActions.value : strokeHit ? [strokeHit.action] : [selectedBboxHit!],
      )
      return
    }

    isMarqueeSelecting = true
    marqueeAdditive = false
    marqueeStartX = e.clientX
    marqueeStartY = e.clientY
    setSelection([])
    setMarqueeRect({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY })
    return
  }

  // Drag when over an element; optional: require Ctrl/Command (scheme A — modifier on element wins over rect draw)
  if (canStartElementDrag(e)) {
    hideToolbarPopupForCanvasInteraction()
    isDragging = true
    dragStartX = e.clientX
    dragStartY = e.clientY
    isMoving.value = true
    beginDrag(hoveredActionInfo.value!.action)
    return
  }

  // In text mode, single-click is a no-op (text creation is handled by double-click)
  if (currentTool.value === 'text') {
    return
  }

  // Stamp: single click places the next number/letter badge
  if (currentTool.value === 'stamp') {
    hideToolbarPopupForCanvasInteraction()
    placeStampAt(e.clientX, e.clientY)
    return
  }

  hideToolbarPopupForCanvasInteraction()

  if (modDown(e) && e.shiftKey) {
    toolBeforeModifier = currentTool.value
    currentTool.value = 'arrow'
  } else if (modDown(e)) {
    toolBeforeModifier = currentTool.value
    currentTool.value = 'rect'
  } else if (e.shiftKey) {
    toolBeforeModifier = currentTool.value
    currentTool.value = 'ellipse'
  } else if (e.altKey) {
    toolBeforeModifier = currentTool.value
    currentTool.value = 'line'
  }

  capturePointer(e)
  startPenRawUpdates(e)
  startDraw({
    x: e.clientX,
    y: e.clientY,
    pressure: normalizePressure(e.pressure),
    pointerType: e.pointerType,
  })
}

function onPointerMove(e: PointerEvent) {
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  if (pointerDownClient) {
    const dx = e.clientX - pointerDownClient.x
    const dy = e.clientY - pointerDownClient.y
    if (dx * dx + dy * dy > CONTEXT_MENU_DRAG_THRESHOLD_PX * CONTEXT_MENU_DRAG_THRESHOLD_PX) {
      pointerMovedSinceDown = true
    }
  }
  pointerModDown.value = modDown(e)
  if (!toolbarPanelHovered.value) {
    updateCursorEl(e.clientX, e.clientY)
  }

  if (isDragging) {
    if (isReshaping.value) {
      updateReshape({ x: e.clientX, y: e.clientY }, e.shiftKey)
    } else {
      updateDragOffset(e.clientX - dragStartX, e.clientY - dragStartY)
    }
    return
  }

  if (isMarqueeSelecting) {
    setMarqueeRect({
      x1: marqueeStartX,
      y1: marqueeStartY,
      x2: e.clientX,
      y2: e.clientY,
    })
    return
  }

  if (!isDrawing.value) {
    mousePos.value.x = e.clientX
    mousePos.value.y = e.clientY

    if (active.value && !penetrationMode.value && !showQuickColors.value && !textBoxPos.value && wantsHoverHitTest()) {
      if (hoverRafId === null) {
        hoverRafId = requestAnimationFrame(() => {
          hoverRafId = null
          if (
            active.value &&
            !penetrationMode.value &&
            !showQuickColors.value &&
            !textBoxPos.value &&
            wantsHoverHitTest()
          ) {
            hoveredActionInfo.value = findActionAt(mousePos.value)
            if (currentTool.value === 'select') {
              const handle = findReshapeHandleAt(mousePos.value)
              if (handle) {
                pointerOverReshapeHandle.value = true
                reshapeHandleCursor.value = handle.cursor
                pointerOverSelectionBbox.value = false
              } else {
                pointerOverReshapeHandle.value = false
                reshapeHandleCursor.value = 'default'
                pointerOverSelectionBbox.value = !!findSelectedActionAt(mousePos.value)
              }
            } else {
              pointerOverReshapeHandle.value = false
              pointerOverSelectionBbox.value = false
            }
          }
        })
      }
    } else {
      hoveredActionInfo.value = null
      pointerOverSelectionBbox.value = false
      pointerOverReshapeHandle.value = false
    }
    return
  }

  // Pen high-rate samples come from pointerrawupdate when that path is active.
  if (penRawUpdatesActive) return

  ingestDrawingPointer(e)
}

function onPointerUp(e: PointerEvent) {
  if (finishRmbErasePointerUp(e)) return
  if (capturedPointerId !== null && e.pointerId !== capturedPointerId) return
  // Text-tool / commit-textbox clicks invalidate the copy modifier on pointerdown but
  // never capture — still clear gesture state so Ctrl+C works after the press.
  if (capturedPointerId === null && !isDrawing.value && !isDragging && !isMarqueeSelecting) {
    markPointerInteractionEnded()
    resetPointerGestureState()
    return
  }
  const wasDrawing = isDrawing.value
  const pointCount = wasDrawing ? getActiveStrokePointCount() : 0
  const sampling = wasDrawing ? getStrokeSamplingStats() : null
  releaseCapturedPointer()

  if (isDragging) {
    const wasReshaping = isReshaping.value
    isDragging = false
    isReshaping.value = false
    isMoving.value = false
    if (wasReshaping) {
      endReshape()
    } else {
      endDrag()
    }
    stopPenRawUpdates()
    markPointerInteractionEnded()
    resetPointerGestureState()
    return
  }

  if (isMarqueeSelecting) {
    finishMarqueeSelection(e.clientX, e.clientY)
    stopPenRawUpdates()
    markPointerInteractionEnded()
    resetPointerGestureState()
    return
  }

  endDraw()
  if (wasDrawing && sampling) {
    const effectiveDpr = getEffectiveDpr()
    const rawDpr = window.devicePixelRatio || 1
    const previewCanvas = previewCanvasRef.value
    const cssW = previewCanvas ? parseFloat(previewCanvas.style.width) : 0
    const canvasDpr = previewCanvas && cssW > 0 ? previewCanvas.width / cssW : null
    logDiagnostic('pointer', 'stroke end', {
      pointerType: e.pointerType,
      button: e.button,
      pressure: e.pressure,
      pointerId: e.pointerId,
      pointCount,
      strokeSmoothing: sampling.smoothing,
      minDistSq: sampling.minDistSq,
      rawDpr,
      effectiveDpr,
      dprCapped: effectiveDpr < rawDpr - 1e-6,
      viewport: sampling.viewport,
      canvas: previewCanvas
        ? {
            bitmapW: previewCanvas.width,
            bitmapH: previewCanvas.height,
            cssW,
            cssH: parseFloat(previewCanvas.style.height) || 0,
            canvasDpr,
          }
        : null,
      overlayLayoutReady: overlayLayoutReady.value,
    })
  }
  stopPenRawUpdates()
  if (wasDrawing) {
    restoreToolAfterStroke()
  } else {
    toolBeforeModifier = null
  }
  markPointerInteractionEnded()
  resetPointerGestureState()
}

function abortActivePointerInteraction() {
  if (hoverRafId !== null) {
    cancelAnimationFrame(hoverRafId)
    hoverRafId = null
  }
  resetRmbEraseGesture()
  releaseCapturedPointer()
  if (isDragging) {
    const wasReshaping = isReshaping.value
    isDragging = false
    isReshaping.value = false
    isMoving.value = false
    if (wasReshaping) {
      cancelDrag()
    } else {
      endDrag()
    }
  }
  if (isMarqueeSelecting) {
    cancelMarqueeSelection()
  }
  if (isDrawing.value) {
    endDraw()
  }
  // Abort: restore real modifier-temp tools only — never auto-revert to pen.
  restoreToolAfterStroke({ allowAutoRevert: false })
  hoveredActionInfo.value = null
  clearSelectionHover()
  pointerModDown.value = false
  markPointerInteractionEnded()
  resetPointerGestureState()
}

function onTextCommit() {
  commitCurrentTextBox(false)
}

function onTextCancel() {
  commitCurrentTextBox(true)
}

function showStampTip() {
  const kind = getStampKind()
  showTip(t(kind === 'number' ? 'tools.stampNumber' : 'tools.stampLetter'))
}

function cycleStampKind() {
  cycleStampKindState()
  showStampTip()
}

function eraserModeTipLabel(mode: EraserMode) {
  return t(mode === 'stroke' ? 'settings.eraserModeStroke' : 'settings.eraserModeObject')
}

function showEraserTip() {
  showTip(`${t('tools.eraser')} · ${eraserModeTipLabel(eraserMode.value)}`)
}

function cycleEraserMode(reason: 'keyboard' | 'toolbar' = 'keyboard') {
  const next = nextEraserMode(eraserMode.value)
  setEraserMode(next)
  showEraserTip()
  logActionEvent('eraser mode cycled', { mode: next, reason })
  persistSettingsPatch({ eraserMode: next })
}

function penCursorTipLabel(style: PenCursorStyle) {
  return t(style === 'pen' ? 'tools.penCursorPen' : 'tools.penCursorDot')
}

function showPenTip() {
  showTip(`${t('tools.pen')} · ${penCursorTipLabel(penCursorStyle.value)}`)
}

function cyclePenCursorStyle(reason: 'keyboard' | 'toolbar' = 'keyboard') {
  const next = nextPenCursorStyle(penCursorStyle.value)
  penCursorStyle.value = next
  showPenTip()
  logActionEvent('pen cursor style cycled', { style: next, reason })
  persistSettingsPatch({ penCursorStyle: next })
}

function crosshairCursorTipLabel(style: CrosshairCursorStyle) {
  return t(style === 'crosshair' ? 'tools.crosshairCursorCrosshair' : 'tools.crosshairCursorDot')
}

function showCrosshairTip() {
  const tool = currentTool.value
  const name = usesCrosshairCursor(tool) ? t(`tools.${tool}`) : t('tools.arrow')
  showTip(`${name} · ${crosshairCursorTipLabel(crosshairCursorStyle.value)}`)
}

function cycleCrosshairCursorStyle(reason: 'keyboard' | 'toolbar' = 'keyboard') {
  const next = nextCrosshairCursorStyle(crosshairCursorStyle.value)
  crosshairCursorStyle.value = next
  showCrosshairTip()
  logActionEvent('crosshair cursor style cycled', { style: next, reason })
  persistSettingsPatch({ crosshairCursorStyle: next })
}

function shapeDashTipLabel(style: StrokeDashStyle) {
  if (style === 'dashed') return t('tools.strokeDashed')
  if (style === 'dotted') return t('tools.strokeDotted')
  return t('tools.strokeSolid')
}

function showShapeDashTip() {
  showTip(shapeDashTipLabel(shapeDashStyle.value))
}

function cycleShapeDash(direction: 1 | -1 = 1, reason: 'keyboard' = 'keyboard') {
  if (!isDashableTool(currentTool.value)) return
  const next = nextStrokeDashStyle(shapeDashStyle.value, direction)
  setShapeDashStyle(next)
  showShapeDashTip()
  logActionEvent('shape dash cycled', { style: next, direction, reason })
}

function resetStampCounter() {
  const label = resetActiveStampCounter()
  showTip(t('tools.stampReset', { label }))
  logActionEvent('stamp counter reset', { kind: getStampKind(), next: label })
}

function placeStampAt(x: number, y: number) {
  const label = takeStampLabel()
  addStampAction(label, x, y, stampFontSizeFromWidth(lineWidth.value), currentColor.value)
  logActionEvent('stamp placed', { kind: getStampKind(), label })
}

const onKeyDown = createKeyDownHandler(
  {
    active,
    showToolbarPopup,
    toolbarPinned,
    showQuickColors,
    quickColorsPos,
    textBoxPos,
    currentTool,
    whiteboardMode,
    isDrawing,
    lastPointerX: () => lastPointerX,
    lastPointerY: () => lastPointerY,
    mousePos,
  },
  {
    cycleColor,
    showToolTip,
    showStampTip,
    cycleStampKind,
    resetStampCounter,
    cycleEraserMode,
    showEraserTip,
    cyclePenCursorStyle,
    showPenTip,
    cycleCrosshairCursorStyle,
    showCrosshairTip,
    cycleShapeDash,
    undo,
    redo,
    removeSelected: () => {
      cancelSelectGestures()
      removeSelected()
      clearSelectionHover()
    },
    hasSelection: () =>
      selectedActions.value.length > 0 || isMarqueeSelecting || (isDragging && currentTool.value === 'select'),
    clearSelection: () => {
      cancelSelectGestures()
      clearSelection()
      clearSelectionHover()
    },
    togglePenetrationMode,
    enterWhiteboardMode,
    exitWhiteboardMode,
    copyScreen: () => {
      void copyScreen('keyboard')
    },
    copyWhiteboard: () => {
      void copyWhiteboard('keyboard')
    },
    toggleToolbarPopupVisible,
    commitCurrentTextBox,
    exitDrawing: () => {
      exitDrawing('keyboard')
    },
  },
)

// ---------------------------------------------------------------------------
// 会话生命周期：进入 / 退出 / 穿透 / 全局快捷键保底 / Panel 命令
// ---------------------------------------------------------------------------

async function enterDrawing(): Promise<void> {
  if (active.value) return
  const previousMode = lastOverlayMode
  lastOverlayMode = 'drawing'
  logSessionEvent('session enter', { from: previousMode })
  customCursorPositionReady.value = false
  overlayLayoutReady.value = false
  active.value = true
  showQuickColors.value = false
  textBoxPos.value = null
  toolbarPanelHovered.value = false
  toolbarPanelDragging.value = false
  if (!toolbarPinned.value && previousMode === 'hidden') {
    showToolbarPopup.value = false
  }
  if (previousMode === 'hidden') {
    applyDefaultEntryOnActivate()
  }
  void (async () => {
    await scheduleOverlayResize()
    await refreshCustomCursorPosition()
  })()
}

function exitDrawing(reason: ExitReason = 'unknown') {
  logActionEvent('exit drawing', { reason })
  commitCurrentTextBox()
  showQuickColors.value = false
  textBoxPos.value = null
  void teardownSession()
}

async function teardownSession(): Promise<void> {
  // 穿透中退出：先释放全局键并恢复鼠标事件，再隐藏窗口（下次唤起不失联）。
  await releasePenetrationShortcuts()
  if (penetrationMode.value) {
    try {
      await overlayHost.setIgnoreCursorEvents(false)
    } catch (error) {
      console.error('[screendraw] restore cursor events failed', error)
    }
    penetrationMode.value = false
  }
  abortActivePointerInteraction()
  flushPersistLineWidths()
  whiteboardMode.value = false
  lastOverlayMode = 'hidden'
  toolbarPanelHovered.value = false
  toolbarPanelDragging.value = false
  showToolbarPopup.value = false
  // 记住本次 CSS 尺寸：下次唤起时拒绝把旧视口样本当作已稳定。
  if (window.innerWidth > 0 && window.innerHeight > 0) {
    staleViewportKey = viewportLayoutKey()
  }
  if (!preserveDrawings.value) {
    hardReset()
    logActionEvent('canvas hard reset', { reason: 'exit-drawing' })
  } else {
    cancelSelectGestures()
    clearSelection()
  }
  active.value = false
  try {
    await overlayHost.hideOverlayWindow()
    overlayHidden.value = true
  } catch (error) {
    console.error('[screendraw] hide overlay window failed', error)
  }
  logSessionEvent('session exited')
}

async function togglePenetrationMode() {
  if (whiteboardMode.value) return
  if (penetrationMode.value) {
    await exitPenetrationMode()
  } else {
    await enterPenetrationMode()
  }
}

async function enterPenetrationMode(): Promise<void> {
  if (penetrationMode.value || whiteboardMode.value) return
  abortActivePointerInteraction()
  clearSelection()
  try {
    await overlayHost.setIgnoreCursorEvents(true)
  } catch {
    // 穿透失败保持交互模式（hostBridge 已记录），不注册全局保底键。
    return
  }
  penetrationMode.value = true
  lastOverlayMode = 'penetration'
  showQuickColors.value = false
  textBoxPos.value = null
  await registerPenetrationShortcuts()
  logSessionEvent('penetration entered')
}

async function exitPenetrationMode(): Promise<void> {
  if (!penetrationMode.value) return
  await releasePenetrationShortcuts()
  try {
    await overlayHost.setIgnoreCursorEvents(false)
  } catch (error) {
    // 恢复失败也要回到绘制状态，避免永久失联。
    console.error('[screendraw] restore cursor events failed', error)
  }
  penetrationMode.value = false
  lastOverlayMode = 'drawing'
  // 光标位置标记保持 false：等下一次真实 pointermove 重新播种（穿透期间 lastPointer 已过期）。
  await refreshCustomCursorPosition()
  logSessionEvent('penetration exited')
}

// ---------------------------------------------------------------------------
// 穿透模式全局快捷键保底（该模式下本页收不到键盘输入）：X 恢复绘制 / Escape 退出
// ---------------------------------------------------------------------------

type ShortcutRelease = () => Promise<void>

interface OToolsShortcutHost {
  otools?: {
    shortcuts?: {
      register(shortcut: string, handler: () => void): Promise<() => Promise<void>>
    }
  }
}

let penetrationShortcutReleases: ShortcutRelease[] = []
let registeringPenetrationShortcuts = false

function shortcutApi(): OToolsShortcutHost['otools'] {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as OToolsShortcutHost).otools
}

async function registerPenetrationShortcuts(): Promise<void> {
  if (registeringPenetrationShortcuts) return
  registeringPenetrationShortcuts = true
  const shortcuts = shortcutApi()?.shortcuts
  if (!shortcuts?.register) {
    logSessionEvent('penetration shortcuts unavailable', undefined, 'warn')
    registeringPenetrationShortcuts = false
    return
  }
  const releases: ShortcutRelease[] = []
  const register = async (shortcut: string, run: () => void): Promise<void> => {
    try {
      releases.push(await shortcuts.register(shortcut, run))
    } catch (error) {
      logSessionEvent('penetration shortcut register failed', { shortcut, error: String(error) }, 'warn')
    }
  }
  await register('X', () => {
    void togglePenetrationMode()
  })
  await register('Escape', () => {
    exitDrawing('shortcut')
  })
  penetrationShortcutReleases = releases
  registeringPenetrationShortcuts = false
}

/** 释放穿透期注册的全局键；幂等（重复调用安全）。 */
async function releasePenetrationShortcuts(): Promise<void> {
  const releases = penetrationShortcutReleases
  penetrationShortcutReleases = []
  for (const release of releases) {
    try {
      await release()
    } catch (error) {
      logSessionEvent('penetration shortcut release failed', { error: String(error) }, 'warn')
    }
  }
}

// ---------------------------------------------------------------------------
// Panel → Overlay 命令（事件 + localStorage 邮箱双通道，commandChannel 已按 seq 去重）
// ---------------------------------------------------------------------------

async function showOverlayWindowIfNeeded(): Promise<void> {
  try {
    // 以真实可见性为准（页面可能在隐藏期间被宿主重载，本地标记会失真）。
    if (await getCurrentWindow().isVisible()) return
  } catch {
    // 查询失败退回本地标记，避免一次 IPC 抖动卡住唤起。
    if (!overlayHidden.value) return
  }
  try {
    await getCurrentWindow().show()
    overlayHidden.value = false
  } catch (error) {
    console.error('[screendraw] show overlay window failed', error)
  }
}

async function handleOverlayCommand(action: OverlayCommandAction): Promise<void> {
  logSessionEvent('overlay command received', { action })
  switch (action) {
    case 'start':
      // start 语义：窗口隐藏先 show，再进入绘制（保留已有笔迹）。
      await showOverlayWindowIfNeeded()
      if (!sessionActive.value) await enterDrawing()
      break
    case 'toggle':
      if (sessionActive.value) {
        exitDrawing('cmd')
      } else {
        await showOverlayWindowIfNeeded()
        await enterDrawing()
      }
      break
    case 'exit':
      exitDrawing('cmd')
      break
  }
}

/** 挂载自适配：撑满 (0,0) 主显示器（物理坐标 ÷ scaleFactor → 逻辑坐标）。 */
async function selfSizeToPrimaryMonitor(): Promise<void> {
  try {
    const monitors = await availableMonitors()
    const primary =
      monitors.find((m) => m.position.x === 0 && m.position.y === 0) ?? (monitors.length > 0 ? monitors[0] : null)
    if (!primary) return
    const scale = primary.scaleFactor > 0 ? primary.scaleFactor : 1
    const win = getCurrentWindow()
    await win.setPosition(new LogicalPosition(primary.position.x / scale, primary.position.y / scale))
    await win.setSize(new LogicalSize(primary.size.width / scale, primary.size.height / scale))
  } catch (error) {
    console.error('[screendraw] self-size to primary monitor failed', error)
  }
}

async function resumeDrawingFromToolbar(): Promise<void> {
  if (penetrationMode.value) {
    await exitPenetrationMode()
  }
}

function logToolbarAction(action: ToolbarAction) {
  const reason = 'toolbar' as const
  switch (action.type) {
    case 'selectTool':
      logActionEvent('tool selected', { reason, tool: action.tool })
      break
    case 'selectColor':
      logActionEvent('color selected', { reason, color: action.color })
      break
    case 'updateLineWidth':
      logActionEvent('line width changed', { reason, width: action.width })
      break
    case 'updateTextOutline':
      logActionEvent('text outline changed', { reason, textOutline: action.textOutline })
      break
    case 'undo':
      logActionEvent('undo', { reason })
      break
    case 'redo':
      logActionEvent('redo', { reason })
      break
    case 'clearAll':
      logActionEvent('canvas cleared', { reason })
      break
    case 'toggleWhiteboard':
      logActionEvent('whiteboard toggle requested', { reason })
      break
    case 'copy':
      logActionEvent('copy requested', { reason, mode: whiteboardMode.value ? 'whiteboard' : 'screen' })
      break
    case 'togglePenetration':
      logActionEvent('toggle penetration requested', { reason })
      break
    case 'togglePin':
      logActionEvent('toolbar pin toggle requested', { reason })
      break
    case 'exitDrawing':
      logActionEvent('exit drawing requested', { reason })
      break
  }
}

async function handleToolbarAction(action: ToolbarAction) {
  logToolbarAction(action)
  switch (action.type) {
    case 'selectTool': {
      // Stroke locks action.tool at pointer-down; ignore UI/tool changes until release.
      const effect = resolveToolbarSelectTool({
        isDrawing: isDrawing.value,
        currentTool: currentTool.value,
        nextTool: action.tool,
      })
      if (effect.type === 'ignore') break
      await resumeDrawingFromToolbar()
      switch (effect.type) {
        case 'cycleStampKind':
          cycleStampKind()
          break
        case 'cyclePenCursor':
          cyclePenCursorStyle('toolbar')
          break
        case 'cycleEraserMode':
          cycleEraserMode('toolbar')
          break
        case 'cycleCrosshairCursor':
          cycleCrosshairCursorStyle('toolbar')
          break
        case 'select':
          currentTool.value = effect.tool
          if (effect.tip === 'stamp') showStampTip()
          else if (effect.tip === 'pen') showPenTip()
          else if (effect.tip === 'eraser') showEraserTip()
          else if (effect.tip === 'crosshair') showCrosshairTip()
          else showToolTip(effect.tool)
          break
      }
      break
    }
    case 'selectColor':
      await resumeDrawingFromToolbar()
      currentColor.value = action.color
      showColorTip(action.color)
      break
    case 'updateLineWidth':
      await resumeDrawingFromToolbar()
      lineWidth.value = action.width
      schedulePersistLineWidths()
      break
    case 'updateTextOutline':
      await resumeDrawingFromToolbar()
      textOutline.value = normalizeTextOutline(action.textOutline)
      if (textBoxPos.value) {
        activeTextBoxOutline.value = normalizeTextOutline(action.textOutline)
      }
      break
    case 'undo':
      undo()
      break
    case 'redo':
      redo()
      break
    case 'clearAll':
      if (isDrawing.value || isDragging || capturedPointerId !== null) {
        finishActivePointerInteraction()
      }
      clearAll()
      break
    case 'toggleWhiteboard':
      await toggleWhiteboardFromToolbar()
      break
    case 'copy':
      copyFromToolbar()
      break
    case 'togglePenetration':
      await togglePenetrationMode()
      break
    case 'togglePin':
      toggleToolbarPin()
      break
    case 'exitDrawing':
      exitDrawing('toolbar')
      break
  }
}

// 页内工具栏事件桥（ToolToolbar emits → ToolbarAction 分发器）
function handleToolbarSelectTool(tool: Tool) {
  void handleToolbarAction({ type: 'selectTool', tool })
}
function handleToolbarSelectColor(color: string) {
  void handleToolbarAction({ type: 'selectColor', color })
}
function handleToolbarUpdateLineWidth(width: number) {
  void handleToolbarAction({ type: 'updateLineWidth', width })
}
function handleToolbarUpdateTextOutline(textOutlineStyle: TextOutlineStyle) {
  void handleToolbarAction({ type: 'updateTextOutline', textOutline: textOutlineStyle })
}
function handleToolbarUndo() {
  void handleToolbarAction({ type: 'undo' })
}
function handleToolbarRedo() {
  void handleToolbarAction({ type: 'redo' })
}
function handleToolbarClearAll() {
  void handleToolbarAction({ type: 'clearAll' })
}
function handleToolbarToggleWhiteboard() {
  void handleToolbarAction({ type: 'toggleWhiteboard' })
}
function handleToolbarCopy() {
  void handleToolbarAction({ type: 'copy' })
}
function handleToolbarTogglePenetration() {
  void handleToolbarAction({ type: 'togglePenetration' })
}
function handleToolbarTogglePin() {
  void handleToolbarAction({ type: 'togglePin' })
}
function handleToolbarExitDrawing() {
  void handleToolbarAction({ type: 'exitDrawing' })
}
function onToolbarPanelHover(hovering: boolean) {
  toolbarPanelHovered.value = hovering
}
function onToolbarPanelDrag(dragging: boolean) {
  toolbarPanelDragging.value = dragging
  if (dragging) {
    toolbarPanelHovered.value = true
  }
}

function syncPointerModFromKey(e: KeyboardEvent) {
  if (e.key === 'Control' || e.key === 'Meta' || modDown(e)) {
    pointerModDown.value = modDown(e)
  }
}

/** Re-apply reshape when Shift is pressed/released mid-drag (no pointer move needed). */
function syncReshapeConstraintFromKey(e: KeyboardEvent) {
  if (!isReshaping.value) return
  if (e.key !== 'Shift' && e.key !== 'ShiftLeft' && e.key !== 'ShiftRight') return
  updateReshape({ x: lastPointerX, y: lastPointerY }, e.shiftKey)
}

function onKeyUp(e: KeyboardEvent) {
  trackCopyModifierKeyUp(e)
  if (e.key === 'Alt') {
    e.preventDefault()
  }
  if (e.key === 'Control' || e.key === 'Meta') {
    pointerModDown.value = false
  }
  syncReshapeConstraintFromKey(e)
}

const unlisteners: UnlistenFn[] = []

onMounted(async () => {
  void scheduleOverlayResize()
  window.addEventListener('resize', debouncedResize)
  window.addEventListener('keydown', syncPointerModFromKey)
  window.addEventListener('keydown', syncReshapeConstraintFromKey)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  watchDpr()

  const overlayWindow = getCurrentWindow()
  unlisteners.push(
    await overlayWindow.onResized(() => {
      debouncedResize()
    }),
  )
  unlisteners.push(
    await overlayWindow.onScaleChanged(() => {
      watchDpr()
      debouncedResize()
    }),
  )

  // 设置：挂载读一次 + storage 事件热更新（Panel 写 / Overlay 读，同源共享）。
  applySettings(loadSettings())
  window.addEventListener('storage', onSettingsStorage)

  // Panel → Overlay 命令双通道（事件 + localStorage 邮箱），按 seq 去重。
  try {
    const releaseCmd = await onOverlayCommand((action) => {
      void handleOverlayCommand(action)
    })
    unlisteners.push(releaseCmd)
  } catch (error) {
    console.error('[screendraw] command channel subscribe failed', error)
  }

  // 自适配主显示器并自动进入绘制会话（本页只在 overlay 窗口加载）。
  await selfSizeToPrimaryMonitor()
  await enterDrawing()
})

onUnmounted(() => {
  resetRmbEraseGesture()
  stopPenRawUpdates()
  window.removeEventListener('pointermove', onGlobalPointerMove)
  window.removeEventListener('pointerup', onGlobalPointerUp)
  window.removeEventListener('pointercancel', onGlobalPointerUp)
  window.removeEventListener('resize', debouncedResize)
  window.removeEventListener('storage', onSettingsStorage)
  void releasePenetrationShortcuts()
  if (resizeTimer) {
    clearTimeout(resizeTimer)
    resizeTimer = null
  }
  flushPersistLineWidths()
  dprMediaQuery?.removeEventListener('change', onDprChange)
  dprMediaQuery = null
  window.removeEventListener('keydown', syncPointerModFromKey)
  window.removeEventListener('keydown', syncReshapeConstraintFromKey)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  if (hoverRafId !== null) {
    cancelAnimationFrame(hoverRafId)
    hoverRafId = null
  }
  setMacOverlaySystemCursorHidden(false)
  unlisteners.forEach((fn) => fn())
  unlisteners.length = 0
  resetCopyModifierState()
  disposeTooltip()
  destroy()
})

let isCopying = false

async function toggleWhiteboardFromToolbar() {
  if (whiteboardMode.value) {
    exitWhiteboardMode()
  } else {
    await enterWhiteboardMode()
  }
}

function copyFromToolbar() {
  if (whiteboardMode.value) {
    void copyWhiteboard('toolbar')
  } else {
    void copyScreen('toolbar')
  }
}

function onPointerLeave(e: PointerEvent) {
  if (isDrawing.value || isDragging || isMarqueeSelecting) return
  onPointerUp(e)
}

async function copyScreen(reason = 'unknown') {
  if (isCopying) {
    logDiagnostic('copy', 'copyScreen skipped', { reason, cause: 'already-copying' }, 'warn')
    return
  }
  logDiagnostic('copy', 'copyScreen invoked', { reason })
  isCopying = true
  let capturedImageId: string | null = null
  try {
    // 截图前隐藏页内 UI（工具栏/提示/文字框），冻结画面只含标注笔迹。
    hideUiForCapture.value = true
    showQuickColors.value = false
    disposeTooltip()
    await nextTick()
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 32))),
    )
    const result = await overlayHost.captureAnnotatedRegion()
    if (!result || result.status !== 'completed') {
      if (result && result.status === 'error') {
        logDiagnostic(
          'copy',
          'capture failed',
          { reason, code: result.error.code, message: result.error.message },
          'error',
        )
      }
      showTip(t('plugin.captureCancelled'))
      return
    }
    capturedImageId = result.image.imageId
    const bytes = await capture.readImage(result.image.imageId)
    const copied = await overlayHost.copyImageDataUrl('data:image/png;base64,' + bytesToBase64(bytes))
    if (!copied) {
      showTip(t('plugin.copyFailed'))
      return
    }
    logDiagnostic('copy', 'clipboard tip shown', { type: 'screen', reason })
    showTip(t('plugin.copied'))
  } catch (err) {
    console.error('Copy screen failed:', err)
    logDiagnostic('copy', 'copyScreen failed', { reason, error: String(err) }, 'error')
    showTip(t('plugin.copyFailed'))
  } finally {
    if (capturedImageId) {
      try {
        await capture.release(capturedImageId)
      } catch {
        // already released / expired
      }
    }
    hideUiForCapture.value = false
    isCopying = false
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 4096
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

async function copyWhiteboard(reason = 'unknown') {
  if (isCopying) {
    logDiagnostic('copy', 'copyWhiteboard skipped', { reason, cause: 'already-copying' }, 'warn')
    return
  }
  const dataUrl = exportAsDataURL(whiteboardBgColor.value)
  if (!dataUrl) {
    logDiagnostic('copy', 'copyWhiteboard skipped', { reason, cause: 'empty-canvas' }, 'warn')
    return
  }

  logDiagnostic('copy', 'copyWhiteboard invoked', { reason })
  isCopying = true
  try {
    const copied = await overlayHost.copyImageDataUrl(dataUrl)
    if (copied) {
      logDiagnostic('copy', 'clipboard tip shown', { type: 'whiteboard', reason })
      showTip(t('plugin.copied'))
    } else {
      showTip(t('plugin.copyFailed'))
    }
  } catch (err) {
    console.error('Copy whiteboard failed:', err)
    logDiagnostic('copy', 'copyWhiteboard failed', { reason, error: String(err) }, 'error')
    showTip(t('plugin.copyFailed'))
  } finally {
    isCopying = false
  }
}

// Custom cursor element ref — position updated directly in pointermove for performance
const cursorEl = ref<HTMLDivElement | null>(null)

function getCursorHotspot(): { x: number; y: number } {
  const tool = currentTool.value
  // SVG viewBox is 0 0 1024 1024. Pen tip is at approximately (388, 846).
  // Mapped to 32x32 cursor size: x = 388/1024*32 ≈ 12, y = 846/1024*32 ≈ 26
  if (tool === 'pen') {
    if (penCursorStyle.value === 'dot') return { x: 8, y: 8 }
    return { x: 12, y: 26 }
  }
  if (tool === 'highlighter') return { x: 5, y: 27 } // tip at ~(150, 850) in 1024x1024 space
  // Eraser uses CSS translate(-50%, -50%) so size changes stay centered on the pointer.
  if (tool === 'eraser') return { x: 0, y: 0 }
  if (usesCrosshairCursor(tool) && crosshairCursorStyle.value === 'dot') return { x: 8, y: 8 }
  return { x: 14, y: 14 }
}

function updateCursorEl(x: number, y: number) {
  if (!cursorEl.value) return
  if (currentTool.value === 'eraser') {
    // Center of the ring stays under the pointer when Ctrl+wheel resizes the eraser.
    cursorEl.value.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
    return
  }
  const { x: hx, y: hy } = getCursorHotspot()
  cursorEl.value.style.transform = `translate(${x - hx}px, ${y - hy}px)`
}

async function refreshCustomCursorPosition() {
  await nextTick()
  if (!showCustomCursor.value) return
  if (cursorEl.value) {
    updateCursorEl(lastPointerX, lastPointerY)
    return
  }
  requestAnimationFrame(() => updateCursorEl(lastPointerX, lastPointerY))
}

const showDragCursor = computed(
  () =>
    !pointerOverReshapeHandle.value &&
    !isReshaping.value &&
    ((currentTool.value === 'select' &&
      (isMoving.value ||
        pointerOverSelectionBbox.value ||
        (!!hoveredActionInfo.value && !isDrawing.value && !isMarqueeSelecting))) ||
      (isDragEnabled(dragMode.value) &&
        (isMoving.value ||
          (hoveredActionInfo.value && !isDrawing.value && dragMode.value === 'modifier' && pointerModDown.value)))),
)

const wantsCustomCursor = computed(
  () =>
    active.value &&
    customCursorPositionReady.value &&
    !penetrationMode.value &&
    !textBoxPos.value &&
    !hideUiForCapture.value &&
    !showQuickColors.value &&
    !toolbarPanelHovered.value &&
    !toolbarPanelDragging.value &&
    !showDragCursor.value &&
    currentTool.value !== 'text' &&
    currentTool.value !== 'stamp' &&
    currentTool.value !== 'select',
)

// Use system cursor as fallback whenever the SVG overlay cursor is suppressed.
const canvasCursor = computed(() => {
  if (penetrationMode.value) return 'default'
  if (isReshaping.value || pointerOverReshapeHandle.value) {
    return isReshaping.value && reshapeHandleCursor.value === 'grab' ? 'grabbing' : reshapeHandleCursor.value
  }
  if (showDragCursor.value) return 'move'
  if (currentTool.value === 'text') return 'text'
  if (currentTool.value === 'stamp') return 'crosshair'
  if (currentTool.value === 'select') return 'default'
  if (showQuickColors.value) return 'default'
  if (wantsCustomCursor.value) return isMacOS() ? MAC_HIDDEN_CURSOR : 'none'
  return 'default'
})

const showCustomCursor = computed(() => wantsCustomCursor.value)

// Fix cursor offset when switching tools/colors via shortcut while pointer is stationary
watch([currentTool, currentColor, penCursorStyle, crosshairCursorStyle], () => {
  void refreshCustomCursorPosition()
})

// Eraser ring diameter changes with Ctrl+wheel; keep the ring centered on the pointer.
watch(eraserCursorDiameter, () => {
  if (currentTool.value === 'eraser' && showCustomCursor.value) {
    updateCursorEl(lastPointerX, lastPointerY)
  }
})

watch(showCustomCursor, (visible, wasVisible) => {
  setMacOverlaySystemCursorHidden(visible)
  if (visible) {
    void (async () => {
      // Re-focus overlay when resuming the custom pen (matches drawing-mode entry).
      if (isMacOS() && !wasVisible) {
        try {
          await getCurrentWindow().setFocus()
        } catch {
          // non-fatal
        }
      }
      await refreshCustomCursorPosition()
    })()
  }
})
</script>

<template>
  <div
    ref="containerRef"
    class="fixed top-0 left-0 w-screen h-screen z-99999"
    :class="[active && !penetrationMode ? 'pointer-events-auto' : 'pointer-events-none']"
    :style="[
      active && !penetrationMode ? { cursor: canvasCursor } : undefined,
      whiteboardMode ? { backgroundColor: whiteboardBgColor } : undefined,
    ]"
  >
    <canvas
      ref="historyCanvasRef"
      class="absolute top-0 left-0 w-full h-full pointer-events-none"
      style="contain: strict"
      :style="whiteboardMode ? { backgroundColor: whiteboardBgColor } : undefined"
    />
    <canvas
      ref="previewCanvasRef"
      class="absolute top-0 left-0 w-full h-full touch-none"
      style="contain: strict"
      :style="{ cursor: canvasCursor }"
      @pointerdown="onPointerDown"
      @dblclick="onDoubleClick"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave"
      @contextmenu.prevent="onContextMenu"
      @wheel="onWheel"
    />

    <!-- 页内悬浮工具栏：常驻（always）或 Space 弹出；穿透/截图时隐藏 -->
    <ToolToolbar
      v-show="showToolbar"
      :pinned="toolbarPinned"
      :current-tool="currentTool"
      :current-color="currentColor"
      :line-width="lineWidth"
      :text-outline="textOutline"
      :whiteboard-mode="whiteboardMode"
      :penetration-mode="penetrationMode"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :can-clear="canClear"
      :anchor-x="toolbarAnchor.x"
      :anchor-y="toolbarAnchor.y"
      :pointer-x="mousePos.x"
      :pointer-y="mousePos.y"
      @select-tool="handleToolbarSelectTool"
      @select-color="handleToolbarSelectColor"
      @update-line-width="handleToolbarUpdateLineWidth"
      @update-text-outline="handleToolbarUpdateTextOutline"
      @undo="handleToolbarUndo"
      @redo="handleToolbarRedo"
      @clear-all="handleToolbarClearAll"
      @toggle-whiteboard="handleToolbarToggleWhiteboard"
      @copy="handleToolbarCopy"
      @toggle-penetration="handleToolbarTogglePenetration"
      @toggle-pin="handleToolbarTogglePin"
      @exit-drawing="handleToolbarExitDrawing"
      @panel-hover="onToolbarPanelHover"
      @panel-drag="onToolbarPanelDrag"
    />

    <!-- Custom cursor element: SVG rendered in DOM, positioned via transform -->
    <div
      v-show="showCustomCursor"
      ref="cursorEl"
      class="fixed top-0 left-0 pointer-events-none select-none drop-shadow-md"
      style="z-index: 100010; will-change: transform"
    >
      <!-- Pen: icon or centered color dot (press 1 again / re-click toolbar to cycle) -->
      <svg
        v-if="currentTool === 'pen' && penCursorStyle === 'pen'"
        width="32"
        height="32"
        viewBox="0 0 1024 1024"
        xmlns="http://www.w3.org/2000/svg"
        style="display: block; overflow: visible; filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.3))"
      >
        <g transform="rotate(15 388 846)">
          <path d="M482.9 279.5L357.6 694.1l45.3 152.5 121.9-102L650 330z" fill="#FFDCB3"></path>
          <path d="M490.435 254.311l167.144 50.477L532.37 719.395l-167.145-50.477z" fill="#FECD44"></path>
          <path d="M388.3 797.1l14.6 49.5 39.6-33.1z" fill="#AEABA8"></path>
          <path d="M402.9 846.6l66.2-118.8 23.9-37.4 31.8 54.2z" fill="#CC9D71"></path>
          <!-- Pen tip: bound to currentColor -->
          <path d="M424.4 808.1l-21.5 38.5 39.6-33.1z" :fill="currentColor"></path>
          <path d="M413.4 710.9l-10.5 135.7 66.2-118.8 0.6-53.3-38.6 5.2z" fill="#F0BF92"></path>
          <!-- Pen body stripe: dynamic color for better visibility -->
          <path
            d="M413.4 710.9s-9-15.2-24.4-19.9c-15.4-4.7-31.3 3.1-31.3 3.1l125.2-414.6 55.7 16.8-125.2 414.6z"
            :fill="currentColor"
            opacity="0.6"
          ></path>
          <path
            d="M469.1 727.8s-8.5-15.1-24.4-19.9c-15.9-4.8-31.3 3.1-31.3 3.1l125.2-414.6 55.7 16.8-125.2 414.6z"
            :fill="currentColor"
            opacity="0.8"
          ></path>
          <path
            d="M524.8 744.6s-9.9-15.5-24.4-19.9-31.3 3.1-31.3 3.1l125.2-414.6L650 330 524.8 744.6z"
            :fill="currentColor"
          ></path>
          <path d="M406.3 802.6l-3.4 44 21.5-38.5z" fill="#63585B"></path>
          <!-- Pen cap: follows currentColor -->
          <path
            d="M650 330l-167.1-50.5 12.1-40c13.9-46.2 62.7-72.3 108.8-58.3 46.2 13.9 72.3 62.6 58.3 108.8L650 330z"
            :fill="currentColor"
          ></path>
          <!-- Divider between cap and body: white by default, black when pen color is white -->
          <g
            :fill="currentColor.toUpperCase() === '#FFFFFF' ? '#333333' : '#FFFFFF'"
            :stroke="currentColor.toUpperCase() === '#FFFFFF' ? '#333333' : '#FFFFFF'"
            stroke-width="32"
            stroke-linejoin="round"
          >
            <path d="M481.713 251.694l184.663 55.767-7.603 25.177-184.663-55.767z"></path>
            <path d="M474.075 276.876l7.604-25.177 61.554 18.589-7.603 25.177z"></path>
            <path d="M535.656 295.425l7.603-25.177 61.554 18.59-7.603 25.176z"></path>
          </g>
          <path
            d="M637.3 227.1c7.8 11.9 10.2 24.1 12.2 22.8s2.9-15.7-5-27.6c-7.8-11.9-21.3-16.8-23.3-15.5-1.9 1.3 8.3 8.4 16.1 20.3z"
            fill="#FFFFFF"
          ></path>
          <path d="M533.7 312.5l4.9-16.2-55.7-16.8-7.4 24.2z" fill="#7898E3"></path>
          <path d="M591.8 321.2l2.5-8.1-55.7-16.8-4.9 16.2z" fill="#3463D9"></path>
          <path d="M650 330l-55.7-16.9-2.5 8.1z" fill="#1A46AB"></path>
        </g>
      </svg>
      <svg
        v-else-if="currentTool === 'pen'"
        width="16"
        height="16"
        xmlns="http://www.w3.org/2000/svg"
        style="display: block; overflow: visible"
      >
        <circle cx="8" cy="8" r="4.5" fill="black" fill-opacity="0.35" />
        <circle cx="8" cy="8" r="3.5" :fill="currentColor" />
        <circle
          cx="8"
          cy="8"
          r="3.5"
          fill="none"
          :stroke="currentColor.toUpperCase() === '#FFFFFF' ? '#333333' : '#FFFFFF'"
          stroke-opacity="0.85"
          stroke-width="1"
        />
      </svg>

      <!-- Highlighter: custom SVG icon -->
      <svg
        v-else-if="currentTool === 'highlighter'"
        width="32"
        height="32"
        viewBox="0 0 1024 1024"
        xmlns="http://www.w3.org/2000/svg"
        style="display: block; overflow: visible; filter: drop-shadow(1px 2px 3px rgba(0, 0, 0, 0.3))"
      >
        <path
          d="M312.32 829.013333a4.266667 4.266667 0 0 0 4.778667-0.853333l40.106666-40.106667a4.266667 4.266667 0 0 0 0-6.016l-114.602666-114.645333a4.266667 4.266667 0 0 0-6.016 0l-83.2 83.114667a4.266667 4.266667 0 0 0 1.28 6.912l157.653333 71.68v-0.042667z m220.288-382.208a32 32 0 0 0 45.226667 45.226667l162.474666-162.432a32 32 0 0 0-45.226666-45.269333l-162.474667 162.474666z"
          :fill="currentColor"
        ></path>
        <path
          d="M384.426667 748.8a40.533333 40.533333 0 0 0 57.301333 0l77.312-77.269333a10.666667 10.666667 0 0 1 3.114667-2.133334l97.450666-44.714666c8.021333-3.712 15.36-8.789333 21.674667-15.061334l231.893333-231.893333a74.666667 74.666667 0 0 0 0-105.6L752.512 151.466667a74.666667 74.666667 0 0 0-105.6 0L415.018667 383.36a74.666667 74.666667 0 0 0-15.061334 21.674667l-44.672 97.450666a10.666667 10.666667 0 0 1-2.133333 3.114667l-77.354667 77.312a40.533333 40.533333 0 0 0 0 57.301333l108.629334 108.629334v-0.042667z m89.386666-122.538667L413.013333 686.976l-75.434666-75.434667 60.714666-60.714666a74.666667 74.666667 0 0 0 15.061334-21.674667l44.672-97.450667a10.666667 10.666667 0 0 1 2.133333-3.114666l231.893333-231.850667a10.666667 10.666667 0 0 1 15.104 0l120.661334 120.661333a10.666667 10.666667 0 0 1 0 15.104l-231.850667 231.850667a10.666667 10.666667 0 0 1-3.114667 2.133333l-97.450666 44.714667a74.794667 74.794667 0 0 0-21.674667 15.061333z"
          :fill="currentColor"
          opacity="0.8"
        ></path>
      </svg>
      <!-- Eraser: dashed circle + crosshair (dark halo under white for light/dark pages) -->
      <svg
        v-else-if="currentTool === 'eraser'"
        :width="eraserCursorDiameter"
        :height="eraserCursorDiameter"
        xmlns="http://www.w3.org/2000/svg"
        style="display: block; overflow: visible"
      >
        <circle
          :cx="eraserCursorRadius"
          :cy="eraserCursorRadius"
          :r="Math.max(2, eraserCursorRadius - 2)"
          fill="none"
          stroke="black"
          stroke-opacity="0.55"
          stroke-width="3"
          stroke-dasharray="3 2"
        />
        <circle
          :cx="eraserCursorRadius"
          :cy="eraserCursorRadius"
          :r="Math.max(2, eraserCursorRadius - 2)"
          fill="none"
          stroke="white"
          stroke-width="1.5"
          stroke-dasharray="3 2"
        />
        <line
          :x1="eraserCursorRadius"
          :y1="eraserCursorRadius - 4"
          :x2="eraserCursorRadius"
          :y2="eraserCursorRadius + 4"
          stroke="black"
          stroke-opacity="0.55"
          stroke-width="3"
          stroke-linecap="round"
        />
        <line
          :x1="eraserCursorRadius - 4"
          :y1="eraserCursorRadius"
          :x2="eraserCursorRadius + 4"
          :y2="eraserCursorRadius"
          stroke="black"
          stroke-opacity="0.55"
          stroke-width="3"
          stroke-linecap="round"
        />
        <line
          :x1="eraserCursorRadius"
          :y1="eraserCursorRadius - 4"
          :x2="eraserCursorRadius"
          :y2="eraserCursorRadius + 4"
          stroke="white"
          stroke-width="1"
          stroke-linecap="round"
        />
        <line
          :x1="eraserCursorRadius - 4"
          :y1="eraserCursorRadius"
          :x2="eraserCursorRadius + 4"
          :y2="eraserCursorRadius"
          stroke="white"
          stroke-width="1"
          stroke-linecap="round"
        />
      </svg>
      <!-- Shape/laser: crosshair (default) or compact color dot (re-press tool key to cycle) -->
      <svg
        v-else-if="crosshairCursorStyle === 'crosshair'"
        width="28"
        height="28"
        xmlns="http://www.w3.org/2000/svg"
        style="display: block"
      >
        <line
          x1="14"
          y1="2"
          x2="14"
          y2="10"
          stroke="black"
          stroke-opacity="0.4"
          stroke-width="3"
          stroke-linecap="round"
        />
        <line
          x1="14"
          y1="18"
          x2="14"
          y2="26"
          stroke="black"
          stroke-opacity="0.4"
          stroke-width="3"
          stroke-linecap="round"
        />
        <line
          x1="2"
          y1="14"
          x2="10"
          y2="14"
          stroke="black"
          stroke-opacity="0.4"
          stroke-width="3"
          stroke-linecap="round"
        />
        <line
          x1="18"
          y1="14"
          x2="26"
          y2="14"
          stroke="black"
          stroke-opacity="0.4"
          stroke-width="3"
          stroke-linecap="round"
        />
        <line x1="14" y1="2" x2="14" y2="10" :stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="14" y1="18" x2="14" y2="26" :stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="2" y1="14" x2="10" y2="14" :stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="18" y1="14" x2="26" y2="14" :stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <circle cx="14" cy="14" r="2.5" fill="black" fill-opacity="0.3" />
        <circle cx="14" cy="14" r="2" :fill="currentColor" />
      </svg>
      <svg v-else width="16" height="16" xmlns="http://www.w3.org/2000/svg" style="display: block; overflow: visible">
        <circle cx="8" cy="8" r="4.5" fill="black" fill-opacity="0.35" />
        <circle cx="8" cy="8" r="3.5" :fill="currentColor" />
        <circle
          cx="8"
          cy="8"
          r="3.5"
          fill="none"
          :stroke="currentColor.toUpperCase() === '#FFFFFF' ? '#333333' : '#FFFFFF'"
          stroke-opacity="0.85"
          stroke-width="1"
        />
      </svg>
    </div>

    <TextBox
      v-if="active && textBoxPos && !hideUiForCapture"
      ref="textBoxRef"
      :x="textBoxPos.x"
      :y="textBoxPos.y"
      :color="activeTextBoxColor"
      :font-size="activeTextBoxFontSize"
      :initial-text="activeTextBoxInitialText"
      :text-outline="activeTextBoxOutline"
      @commit="onTextCommit"
      @cancel="onTextCancel"
      @context-menu="onContextMenu"
    />

    <Transition name="tooltip-fade">
      <div
        v-if="active && toolTip && !hideUiForCapture"
        class="overlay-toast fixed bottom-12 left-1/2 -translate-x-1/2 z-100003"
      >
        <span
          v-if="toolTipColor"
          class="w-4 h-4 rounded-full color-dot-ring shrink-0"
          :style="{ backgroundColor: toolTipColor }"
        />
        <span
          v-else-if="toolTipWidth"
          class="overlay-toast-width-bar shrink-0"
          :style="{ width: '20px', height: Math.max(1.5, toolTipWidth * 1.2) + 'px' }"
        />
        <component v-else-if="toolTipTool" :is="toolIconMap[toolTipTool]" :size="18" color="var(--ui-toast-icon)" />
        <span>{{ toolTip }}</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.tooltip-fade-enter-active {
  transition: opacity 0.15s ease;
}
.tooltip-fade-leave-active {
  transition: opacity 0.4s ease;
}
.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
}
</style>
