/**
 * Panel → Overlay 命令双通道（start / toggle / exit）。
 *
 * 跨 webview 的 Tauri 事件投递存在时序不确定性，因此除全局事件主通道外，
 * 再写一条同源 localStorage 邮箱兜底：storage 事件只在同源的其他 webview
 * 触发（宿主文档明确支持跨窗口同步），Overlay 收到任一通道后按 seq 去重，
 * 统一进同一个处理器执行。
 *
 * 注意：Overlay 侧只消费、绝不写邮箱 key，避免自触发。
 */
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'

export type OverlayCommandAction = 'start' | 'toggle' | 'exit'

export interface OverlayCommandMessage {
  seq: number
  action: OverlayCommandAction
  ts: number
}

/** 主通道：Tauri 全局事件（SDK event shim）。 */
export const OVERLAY_CMD_EVENT = 'otools-screendraw:cmd'
/** 兜底通道：同源 localStorage 邮箱（Panel 写 / Overlay 读）。 */
export const OVERLAY_CMD_MAILBOX_KEY = 'otools-screendraw:cmd:v1'

let seqCounter = 0

function nextSeq(): number {
  // Date.now() * 1000 + 自增：同毫秒内不重复，整体单调递增（防同毫秒 seq 撞车）。
  seqCounter = (seqCounter + 1) % 1000
  return Date.now() * 1000 + seqCounter
}

function isOverlayCommandAction(value: unknown): value is OverlayCommandAction {
  return value === 'start' || value === 'toggle' || value === 'exit'
}

/** Panel 侧：事件 + 邮箱双写，任一通道可达即可。 */
export async function sendOverlayCommand(action: OverlayCommandAction): Promise<void> {
  const message: OverlayCommandMessage = { seq: nextSeq(), action, ts: Date.now() }
  try {
    await emit(OVERLAY_CMD_EVENT, message)
  } catch (error) {
    console.error('[screendraw] cmd event channel failed', error)
  }
  try {
    localStorage.setItem(OVERLAY_CMD_MAILBOX_KEY, JSON.stringify(message))
  } catch (error) {
    console.error('[screendraw] cmd mailbox channel failed', error)
  }
}

/** 去重窗口：只记住最近 N 条，防止长会话下无限增长。 */
const DEDUPE_WINDOW = 64

/** Overlay 侧：订阅双通道，按 seq 去重后回调。返回释放函数（幂等安全）。 */
export async function onOverlayCommand(
  handler: (action: OverlayCommandAction) => void,
): Promise<UnlistenFn> {
  const seen = new Set<string>()

  function dispatch(raw: unknown): void {
    const message = raw as Partial<OverlayCommandMessage> | null | undefined
    if (!message || !isOverlayCommandAction(message.action)) return
    // 老面板可能只发 { action }（无 seq）：按 (ts+action) 兜底幂等。
    const key =
      typeof message.seq === 'number' ? `s${message.seq}` : `t${message.ts ?? ''}:${message.action}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > DEDUPE_WINDOW) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    handler(message.action)
  }

  const unlistenEvent = await listen<OverlayCommandMessage>(OVERLAY_CMD_EVENT, (event) => {
    dispatch(event.payload)
  })

  const onStorage = (e: StorageEvent) => {
    if (e.key !== OVERLAY_CMD_MAILBOX_KEY || !e.newValue) return
    try {
      dispatch(JSON.parse(e.newValue))
    } catch {
      // 非法载荷直接忽略。
    }
  }
  window.addEventListener('storage', onStorage)

  return () => {
    window.removeEventListener('storage', onStorage)
    void unlistenEvent()
  }
}
