# OTools 屏幕标注（otools-screendraw）

快捷键或托盘一键唤起**全屏透明标注层**，直接在任意应用上作画：画笔、荧光笔、
箭头、矩形、椭圆、直线、文字、序号、橡皮擦、激光笔；支持点击穿透、白板模式、
批量选择编辑、复制标注截图。绘制引擎移植自 [MarkerOn](https://github.com/ifer47/markeron)（MIT）。

## 功能

- **一键直达**：安装后在宿主托盘「插件动作 → 屏幕标注」点击即进入标注，全程不打开面板
- **全局快捷键**：`Cmd/Ctrl+Shift+D` 唤起 / 退出（Panel 常驻期间生效；宿主重启后建议在宿主设置里为插件绑定「关键词快捷键」实现冷启动直达）
- **十种工具**：选择（拖拽/旋转/缩放/删除）、画笔、荧光笔、箭头、矩形、椭圆、直线、橡皮擦、激光笔、文字、序号印章
- **点击穿透**（X）：笔迹保留在屏幕上，鼠标操作传递给下层应用
- **白板模式**（W）：切换纯色背景作白板用
- **复制**：白板 `Cmd/Ctrl+C` 复制为图片；标注画面复制走宿主截图
- **全键盘**：数字键切工具、Q/E 换颜色、D 切线型、Cmd+滚轮调线宽、修饰键约束图形

## 开发

```bash
pnpm install
pnpm dev          # devUrl http://127.0.0.1:6553（宿主 quickDev 加载）
pnpm test         # vitest：核心绘制引擎 400+ 单测
pnpm build        # vue-tsc --noEmit && vite build
node scripts/pack-plugin.mjs     # 打包 dist-pack/*.oplg
node scripts/verify-plugin.mjs   # 校验 .oplg
```

- devUrl 端口 `6553`（6541–6549 已被其他插件占用；6550-6552 运行期被其他项目进程长期占用，实测顺延）
- 架构：单入口双页面——`index.html`（Panel：直达控制器 + 设置）与
  `index.html?overlay=1`（Overlay：全屏透明标注层，宿主 custom 窗口承载）
- 穿透模式依赖宿主 `core:window:allow-set-ignore-cursor-events` capability
- 复制图片依赖宿主 `otools_copy_image`；截图依赖宿主 capture SDK

## 目录

见 `docs/SPEC.md`。

## 许可

本插件代码遵循仓库整体许可；绘制引擎部分遵守
[MarkerOn 的 MIT 许可证](licenses/MarkerOn-LICENSE)，详见 `THIRD_PARTY_NOTICES.md`。
