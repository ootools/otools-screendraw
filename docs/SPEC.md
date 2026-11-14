# otools-screendraw 实现规格（屏幕标注）

## 定稿口径（2026-11-14）

| 项 | 口径 |
| --- | --- |
| 定位 | 全屏透明标注层：快捷键/托盘一键直达，在任意应用上作画；绘制引擎移植自 MarkerOn v2.2.0（MIT，见 THIRD_PARTY_NOTICES.md） |
| 打开方式 | `openMode: "panel"` + `directLaunch: true`：Panel webview 作为隐藏常驻控制器 + 用户主动打开时的设置页；标注层是 `windowId=overlay` 的额外 custom 窗口（transparent + alwaysOnTop + 无边框 + skipTaskbar + visibleOnAllWorkspaces） |
| 直达链路 | 托盘「插件动作」（宿主 `trayActions` manifest 字段，本次随宿主新增）或面板入口点击 → 宿主隐藏 Panel 投递 `launch/direct` 关键词 → Panel 页 `onOtoolsKeyword` 接收 → `open_custom_plugin_window`（不存在时创建；已存在时 emit `otools-screendraw:cmd {action:'start'}`） |
| 快捷键 | 运行时 `window.otools.shortcuts.register('CommandOrControl+Shift+D')`（Panel 页注册，webview 常驻期间生效）；穿透模式期间 overlay 页临时注册全局 `X`/`Escape` 保底（退出即释放）；冷启动建议用户在宿主设置绑定「插件关键词快捷键」 |
| 窗口自适配 | overlay 挂载后 `availableMonitors()` 取 (0,0) 主显示器 → `setPosition/setSize`（Logical，物理值 ÷ scaleFactor）撑满屏幕；页面坐标直接用 innerWidth/innerHeight；多显示器 v2 迭代 |
| 穿透 | `setIgnoreCursorEvents(true/false)`（SDK Window shim → 宿主 capability）；进入穿透隐藏工具栏/文字框/提示；失败 catch 保持交互模式不静默失联 |
| 工具 | 11 种全量对齐 MarkerOn：select（拖拽/旋转/缩放/删除）、pen、highlighter、arrow、rect、ellipse、line、eraser（stroke/object 两模式）、laser（trail/writing）、text、stamp（数字/字母序号） |
| 笔迹 | perfect-freehand 可变宽轮廓 + 三档平滑；对象模型撤销重做（存对象非位图）；虚线/点线（D/Shift+D）；修饰键约束（Alt 直线 / Ctrl 矩形 / Shift 椭圆 / Ctrl+Shift 箭头 / 再加 Alt 正方形圆） |
| 复制 | 白板/画布 → `canvas.toDataURL` → 宿主 `otools_copy_image`；标注截图 → 隐藏 UI → 宿主 `capture.select({mode:'region', hideHost:false})`（冻结画面含笔迹）→ `capture.readImage` → `otools_copy_image` → `capture.release` |
| 设置持久化 | 同源 localStorage `otools-screendraw:settings:v1`（Panel 写 / Overlay 读 + storage 事件热更新）；结构 `src/settings.ts`（MarkerOn AppConfig.general 可移植子集） |
| 工具栏 | 页内悬浮面板（Space 呼出 / always 常驻 / 可拖动）；MarkerOn 的两窗口工具栏架构不移植（穿透模式下工具栏隐藏，X 恢复） |
| 端口 | devUrl `http://127.0.0.1:6550`（6541-6549 已占用；6548 烧毁；6551 备用） |
| 版本 | 0.1.0 |

## plugin.json

`packid=otools-screendraw`，`entry=dist/index.html`，`devUrl=http://127.0.0.1:6550`，`quickDev=true`，
`logo.svg` 在仓库根，`icon=🖍️`，keywords：标注/屏幕/画笔/批注/白板/annotat/draw/marker/screen。
直达模式 + `trayActions:[{id:"annotate", title:"Screen Draw", titleCN:"屏幕标注", keyword:"launch"}]`
（宿主 ≥ 本次 trayActions 扩展版本才渲染托盘入口；老宿主降级为面板内手动启动）。
打包时 `pack-plugin.mjs` 自动剥掉 `devUrl/quickDev`。

## 目录

```
otools-screendraw/
├── plugin.json / package.json / logo.svg / index.html
├── vite.config.ts            # vue + tailwindcss + otools sdk shim；vitest setupFiles=tests/setup.ts（Path2D stub）
├── src/
│   ├── main.ts               # 入口分流：?overlay=1 → OverlayApp（懒加载）；否则 PanelApp
│   ├── settings.ts           # ScreendrawSettings 定义/解析/读写（Panel↔Overlay 同源共享）
│   ├── theme.ts              # 本地主题解析（overlay 文档锁 color-scheme: only light 防透明窗黑底）
│   ├── style.css             # 全局样式（自 MarkerOn，含 UI token）
│   ├── panel/PanelApp.vue    # 直达控制器（关键词订阅/快捷键注册/overlay 窗口管理）+ 设置 UI
│   ├── overlay/
│   │   ├── OverlayApp.vue    # 全屏透明标注层（自 DrawingOverlay.vue 适配）
│   │   ├── ToolToolbar.vue   # 页内悬浮工具栏（自两窗口架构改造）
│   │   ├── TextBox.vue       # 文字编辑浮层（原样移植）
│   │   └── hostBridge.ts     # 宿主桥：穿透/隐藏窗口/复制图片/区域截图
│   ├── core/                 # MarkerOn 移植引擎（MIT；vitest 单测 403 个）
│   │   ├── composables/      # useDrawing / drawingGeometry / drawingRender / drawingReshape
│   │   │                     #   / useOverlayKeyboard / strokeSmoothingState / useTooltip / overlayBridge(未引用)
│   │   ├── constants/        # tools / colors / laser / penStroke / stamp / textOutline
│   │   ├── utils/            # 平滑/线锁定/拖拽/橡皮/激光/RMB擦除/白板背景/光标等
│   │   └── types/            # app.d.ts / diagnostics.ts
│   └── i18n/                 # zh-CN / en（含 plugin.* 区块）
├── tests/setup.ts            # vitest 全局 Path2D stub（jsdom 缺 Canvas API）
├── scripts/                  # pack-plugin / verify-plugin / publish-market / serve-dist（games 模板）
├── vendor/otools-plugin-sdk  # 固定快照（来源见 vendor/sdk-source.json，宿主 9d8a85a0）
├── licenses/MarkerOn-LICENSE
├── THIRD_PARTY_NOTICES.md
└── docs/SPEC.md
```

## 与 MarkerOn 的差异（移植改造点）

1. **窗口层**：Tauri Rust 后端（全局快捷键/托盘/穿透/截图/复制）全部替换为 OTools 宿主桥——
   `otools.shortcuts` / `trayActions` 直达 / `setIgnoreCursorEvents` / `capture.select` / `otools_copy_image`。
2. **两窗口 → 单窗口**：MarkerOn 的绘制层与工具栏是两个原生窗口（overlayBridge 事件总线 +
   工具栏弹出窗口定位）；本插件合并为单 overlay 窗口内的页内悬浮工具栏，删除
   `toolbarWindow/toolbarPosition` 的窗口级逻辑（纯函数保留）。
3. **配置**：Rust config 文件 → 同源 localStorage（`src/settings.ts`），字段子集见上表。
4. **诊断**：`append_diagnostic_event` 原生上报删除，保留本地环形缓冲。
5. **主题**：`apply_app_theme` 原生调用删除，overlay 文档锁 `only light`，Panel 跟随系统。
6. **入口**：托盘常驻 + `exit_drawing` 隐藏窗口（实例常驻 webview，二次唤起秒开）。

## 风险与验收

- macOS 透明窗首击丢失 / 拖拽丢事件：宿主 capture 覆盖层同款窗口参数已在线上验证；
  如遇首击丢失需宿主 `CustomWindowOptions` 补 `acceptFirstMouse` 透传（后续小改）。
- 穿透恢复三重保底：全局 X/Esc（穿透期注册）→ 托盘再次点击（start 语义 show+续画）→ 宿主关闭窗口。
- 快捷键冲突：注册失败在 Panel 显示状态，不静默。
- 验收清单（quickDev 联调）：托盘点击直达 / Cmd+Shift+D 唤起与退出 / 十一工具绘制 /
  撤销重做 / 穿透开启恢复 / 白板进出 / 复制白板图 / 复制标注截图进剪贴板 / Esc 退出不残留 /
  保留笔迹开关 / 设置项热生效。
