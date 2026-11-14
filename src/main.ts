import { createApp } from 'vue'
import { createApp as createOverlayApp } from 'vue'
import './style.css'
import { applyTheme, watchSystemTheme } from './theme'
import { loadSettings } from './settings'

const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1'


if (isOverlay) {
  // 覆盖层：透明文档固定 only light，加载后立即应用主题再挂载，避免闪烁。
  applyTheme(loadSettings().theme)
  void import('./overlay/OverlayApp.vue').then(({ default: OverlayApp }) => {
    createOverlayApp(OverlayApp).mount('#app')
  })
} else {
  // Panel：直达控制器 + 设置页。
  applyTheme(loadSettings().theme)
  watchSystemTheme()
  void import('./panel/PanelApp.vue').then(({ default: PanelApp }) => {
    createApp(PanelApp).mount('#app')
  })
}
