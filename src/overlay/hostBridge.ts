/**
 * OTools 宿主桥：MarkerOn 原生命令在插件环境下的等价实现。
 *
 * - 窗口操作走 otools-plugin-sdk 的 Tauri shim（`core:window:allow-*` capability 已放行）；
 * - 图片复制走宿主 `otools_copy_image`（dataURL/文件路径 → 系统剪贴板）；
 * - 屏幕截图走宿主 capture.select（冻结画面自带我们的置顶标注笔迹）；
 * - 退出 = 隐藏 overlay 窗口（Panel 保持隐藏，笔迹随会话保留在页面状态里）。
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { capture } from 'otools-plugin-sdk/capture';
import type { CaptureResult } from 'otools-plugin-sdk/capture-factory';

export interface OverlayHost {
  /** 穿透模式切换：true = 鼠标事件穿透到下层应用。 */
  setIgnoreCursorEvents(ignore: boolean): Promise<void>;
  /** 隐藏 overlay 窗口（退出标注会话；窗口实例保留以便下次唤起秒开）。 */
  hideOverlayWindow(): Promise<void>;
  /** 写图片进系统剪贴板；dataURL 形如 `data:image/png;base64,...`。 */
  copyImageDataUrl(dataUrl: string): Promise<boolean>;
  /** 宿主区域截图（冻结画面，含 overlay 笔迹）；失败/取消返回 null。 */
  captureAnnotatedRegion(): Promise<CaptureResult | null>;
  /** 宿主是否为 macOS（快捷键提示、光标行为分支）。 */
  isMacOS(): boolean;
}

function tauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function currentWindowSafe(): ReturnType<typeof getCurrentWindow> | null {
  if (!tauriAvailable()) return null;
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export const overlayHost: OverlayHost = {
  async setIgnoreCursorEvents(ignore) {
    const win = currentWindowSafe();
    if (!win) return;
    try {
      await win.setIgnoreCursorEvents(ignore);
    } catch (error) {
      // 穿透失败保持交互模式 —— 功能降级但 UI 永不失联。
      console.error('[screendraw] setIgnoreCursorEvents failed', error);
      throw error;
    }
  },

  async hideOverlayWindow() {
    const win = currentWindowSafe();
    if (!win) return;
    try {
      await win.hide();
    } catch (error) {
      console.error('[screendraw] hide overlay failed', error);
    }
  },

  async copyImageDataUrl(dataUrl) {
    if (!dataUrl.startsWith('data:image/')) return false;
    return (await invoke<unknown>('otools_copy_image', { image: dataUrl })) === true;
  },

  async captureAnnotatedRegion() {
    if (!tauriAvailable()) return null;
    try {
      const result = await capture.select(
        { mode: 'region', edit: false, hideHost: false, restoreHost: false },
        undefined,
      );
      return result;
    } catch (error) {
      console.error('[screendraw] capture region failed', error);
      return null;
    }
  },

  isMacOS(): boolean {
    if (typeof navigator === 'undefined') return false;
    const platform = navigator.platform ?? '';
    return /Mac|iPhone|iPad|iPod/i.test(platform);
  },
};
