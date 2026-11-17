# 2026-06-28 Agent 面板：设置页收纳 + panel.ts 全面 builder 化

## 目标（用户）

把面板里的 Provider/模型/Key 配置收进一个设置页（⚙ 按钮切换），主面板只留聊天，更简洁；默认加载一个模型。并提醒：panel.ts 也要像 ui.ts 一样用 ranui `builder`。

## 决策（用户确认）

- 默认模型：**打开面板就自动加载**（接受 WebLLM ~1.8GB；有缓存则秒开）。
- 主面板保留的快捷操作：**Quote / Clear / Review** 三个都留。

## 改动

### panel.ts 全面改用 ranui builder

之前 ui.ts 用了 builder，但 panel.ts 仍是 `document.createElement`（不一致，用户指出）。这次全部改为 ranui `builder`：

- 自定义元素用 `View('r-select' | 'r-input' | 'r-button' | 'r-checkbox' | 'r-option')`。
- 原生用 `Div / Span / Label / ButtonBuilder`。
- 链式 `.id().class().attr().text().children().on().build()`；事件用 `.on()`（闭包可引用后定义的 submit/controller）。
- `ranButton/ranSelect/ranInput` 三个 helper 用 builder 重写。

### 设置页重构

- Header 加 **⚙ 设置按钮**（i18n `agentSettings`，zh「设置」/en「Settings」），切换 `.agent-panel-settings-hidden`。
- 设置区（默认隐藏）：Provider 选择 / Key / Ollama 模型名 / 模型选择 + Load。
- `note`（加载进度/提示）移到**主面板**（`:empty` 时隐藏），这样自动加载进度可见。
- 工具栏（Review/Quote/Clear）+ 聊天留主面板。
- 打开面板时若 `webllm + WebGPU` → 自动 `loadModel()`（从 Load 按钮逻辑抽出复用）。

### CSS（base.css）

`.agent-panel-settings-hidden{display:none}`；`.agent-panel-settings-toggle`（gear，`margin-left:auto` 推到右侧、close 左边）。

## 验证（chrome-devtools）

- ⚙ 存在（title "Settings"）；设置区默认隐藏、点击开/关切换正常。
- 工具栏 + 聊天在；note 在主面板显示 "Model loaded — you can start chatting"（自动加载完成，模型有缓存）。
- Provider 选择仍 5 项。
- tsc 零错误、`pnpm test` 237/237。

## 提交

代码 + i18n 源提交；`pnpm-workspace.yaml` + `lock` 仍暂缓（ranui 本地 link，待发版补）。
