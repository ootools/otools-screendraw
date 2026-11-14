/**
 * 本地主题解析：跟随系统深浅色，写 `data-theme` 供 style.css 的 token 生效。
 *
 * 与 MarkerOn 的 useAppTheme 的差异：不调用 `apply_app_theme` 原生命令
 * （宿主窗口透明策略由宿主统一管理），且 overlay 文档保持 `color-scheme: only light`
 * 防止 WKWebView/WebView2 在透明窗口上画出不透明底色。
 */
export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

function systemPrefersDark(): boolean {
  return globalThis.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return preference
}

const isOverlayDocument = (): boolean =>
  new URLSearchParams(globalThis.location.search).get('overlay') === '1'

let watching = false

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference)
  document.documentElement.dataset.theme = resolved
  // 透明覆盖层文档固定 only light：dark 的 color-scheme 会让 WebView 画出黑色不透明底。
  document.documentElement.style.colorScheme = isOverlayDocument() ? 'only light' : resolved
  if (!watching && preference === 'system') {
    watching = true
    globalThis
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => applyTheme('system'))
  }
  return resolved
}

export function watchSystemTheme(): void {
  applyTheme('system')
}
