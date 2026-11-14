import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { otoolsTauriShimPlugin } from 'otools-plugin-sdk/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss(), otoolsTauriShimPlugin()],
  // 宿主经 otools-plugin://localhost/<packid>/dist/ 自定义协议加载插件页：
  // 资产必须是相对路径，绝对路径 /assets/* 会解析到协议根而 404（页面全白）。
  base: './',
  build: {
    target: 'es2022',
    // Panel 控制页与 Overlay 标注页同入口，按 ?overlay=1 分流；main.ts 懒加载
    // 各自页面组件，保持多 chunk —— Panel 不必加载整套绘制引擎（约省 1/3 体积）。
  },
  test: {
    environment: 'node',
    // jsdom 缺少 Canvas 的 Path2D：核心绘制测试依赖该 stub（沿自 MarkerOn）。
    setupFiles: ['tests/setup.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
