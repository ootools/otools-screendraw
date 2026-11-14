# 第三方声明（Third Party Notices）

## MarkerOn（绘制引擎）

本项目（otools-screendraw）的全屏标注绘制引擎——包括绘图对象模型、几何计算、
Canvas 渲染、变形编辑（拖拽/旋转/缩放）、笔迹平滑、激光笔衰减轨迹与快捷键
处理——移植自 [MarkerOn](https://github.com/ifer47/markeron)（v2.2.0 源码，
MIT 许可证），并针对 OTools 插件宿主环境做了窗口管理与配置持久化的适配改造。

- 源仓库：https://github.com/ifer47/markeron
- 许可证：MIT（全文见 `licenses/MarkerOn-LICENSE`）
- 改造说明：移除 Tauri 原生命令依赖，替换为 OTools 宿主桥
  （`src/overlay/hostBridge.ts`）；两窗口工具栏架构改为页内悬浮工具栏；
  配置持久化改用同源 localStorage。

MarkerOn 依赖的第三方库随引擎一并引入：

| 库 | 用途 | 许可证 |
| --- | --- | --- |
| [perfect-freehand](https://github.com/steveruizok/perfect-freehand) | 手绘笔迹可变宽度轮廓 | MIT |
| [@excalidraw/laser-pointer](https://github.com/excalidraw/laser-pointer) | 激光笔时间衰减轨迹 | MIT |
| [@lucide/vue](https://lucide.dev) | 工具栏图标 | ISC |

以上依赖均通过 npm/pnpm 安装，其许可证文本可在各自的 npm 包内查阅。
