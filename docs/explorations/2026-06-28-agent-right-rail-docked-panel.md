# 2026-06-28 Agent 一体化入口：右栏 AI 按钮 + 停靠面板

## 目标

把 AI 助手做成"一体化"：按钮进 OnlyOffice 自带的图标栏，点击后聊天面板停靠、占据布局（不再浮层遮挡）。最终按钮放在**右栏**（与面板同侧、相邻）。

## 实现

### 1. 左栏 → 右栏注入 AI 按钮（`public/onlyoffice-v7-iframe-patch.js`）

- patch 已注入每个编辑器 iframe（同源），用它在 `#right-menu` 里**克隆**一个 `.btn-category` 生成 AI 按钮（克隆而非硬编码，自动适配结构 / v9）。
- 剥掉克隆来的 transient/修饰类：`active` / `disabled` / `arrow-left`。
- `MutationObserver` 保活（右菜单重渲染后补回）。
- 点击：同源优先直连 `window.top.__toggleAgentPanel()`，失败回退 `postMessage({type:'agent:toggle'})`。
- 监听 `agent:state` 消息，同步按钮 `active` 高亮。

### 2. 父页桥接（`index.ts`）

- 暴露 `window.__toggleAgentPanel`（懒加载 agent-plugin 后调用 `toggleAgentPanel`）。
- 监听 `agent:toggle` 消息作为兜底。

### 3. 面板单例 + 停靠（`lib/agent-plugin/ui/panel.ts`、`ui/index.ts`）

- 新增 `toggleAgentPanel()` + 单例 `panelHandle`；`createAgentPanel` 幂等（已存在则复用）。
- `setOpen` 同时切换 `body.agent-docked`，并向编辑器 iframe 广播 `agent:state`。
- 修订模式按特性检测：`typeof api.asc_IsTrackRevisions === 'function'`（PPT 无此 API，否则一打开就崩）。

### 4. 停靠样式（`styles/base.css`）

- `body.agent-docked #app iframe { width: calc(100% - 360px) !important }`，编辑器让出 360px。

### 5. 菜单入口（`lib/ui.ts`）

- FAB 菜单加"AI 助手"项（懒加载、幂等），用于未打开文档时也能开面板。

## 关键踩坑（用 chrome-devtools 实测定位）

1. **编辑器 iframe 没有 id**：DocsAPI `replaceChild` 把占位 `#iframe` div 换成 iframe，且该 iframe **`id=""`、只有 `name="frameEditor"`**。所以 `#iframe` 选择器匹配不到 → 停靠无效。改用 **`#app iframe`** 才命中。实测 `width` 1440→1080 且 OnlyOffice 自动重排。
2. **iframe→父页消息送达**：按钮在 iframe 内、面板在父页，需 `window.top` 通信；加了同源直连 `__toggleAgentPanel` 主通道。
3. **克隆按钮带 `disabled`**：样板按钮当时是禁用态，克隆 className 带进了 `disabled`（显灰），需剥离。
4. **按钮与面板同侧**：原放 `#left-menu`，但面板停右，改到 `#right-menu` 更顺手。

## 验证（chrome-devtools 端到端）

- 打开：`body.agent-docked` 生效、编辑器变窄、AI 按钮 `active` 高亮、面板停右不遮挡。
- 关闭：编辑器恢复全宽、`agent-docked` 移除、高亮消失。
- 三个编辑器（Word/Excel/PPT）均注入；PPT 修订模式按钮正确置灰。
