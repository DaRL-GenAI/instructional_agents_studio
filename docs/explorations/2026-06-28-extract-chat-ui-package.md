# 2026-06-28 抽离 @ranuts/chat-ui 包 + 重构 Agent 面板

## 目标

做一个 IM/聊天 UI 比较复杂，值得独立成包复用/发布。把 Agent 面板里的"消息流 + 输入"抽成通用组件包 `@ranuts/chat-ui`，本项目引入使用；顺带把面板做精致。这是 monorepo 规划里"从最自包含的叶子开始抽"的第一步落地。

## 决策

- 包名/定位（用户定）：**`@ranuts/chat-ui`**，**可发布、尽量通用** → 零依赖、原生 TS + DOM、自注入样式。
- 边界：IM 包只管"渲染 + 事件"，不碰 LLM provider / API Key / 编辑器工具（那些留在 agent 面板）。
- 提交（用户定）：**只提交代码，`pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 暂缓**——因为它们和用户暂不提交的 ranui 本地 link 纠缠，待 ranui 发版后连干净 lock 一起补。

## 产出

### 新包 `packages/chat-ui`

- `ChatView`（[chat-view.ts](../../packages/chat-ui/src/chat-view.ts)）：滚动消息列表 + 流式 + 自增高输入框，按钮 Send/Stop 二合一。
  - API：`append / appendDelta / endStream / setRunning / clear / getInput / setInput / focus / setLabels`。
  - 角色：user（右对齐主色气泡）、agent（灰）、tool（虚线 mono）、error（红）。
  - 样式自注入（`cui-*` 前缀，`--cui-*` 变量可覆盖），消费方零 CSS 导入。
- 构建：`tsc` 出 `dist`（ESM + d.ts）；`dist` 仍 gitignore，加 **`prepare` 脚本**让 `pnpm install` 自动构建（已验证 fresh-clone 可用）。

### 面板重构（[panel.ts](../../lib/agent-plugin/ui/panel.ts)）

- 删除自建的 conversation/appendTurn/液泡流式/textarea/sendBtn 与对应的 running signal、send/stop effect。
- 改用 `new ChatView({ onSend: submit, onStop, labels })`；`submit(text)` 取参数；流式转发 `appendDelta/endStream`；clear/quote 走 ChatView；i18n 用 `chat.setLabels`。
- `styles/base.css`：删掉被取代的 `.agent-panel-conversation/.agent-turn*/.agent-panel-input*/.agent-panel-send` 死样式；加 `.agent-panel .cui-root { flex:1; min-height:0 }` 让聊天区在面板里撑满。

## 验证（chrome-devtools 端到端 + 单测）

- ChatView 挂载进面板、样式注入、Vite 免重启解析 `@ranuts/chat-ui`。
- 面板/聊天/输入底边对齐视口、无溢出、消息区可滚动；停靠仍正常。
- 气泡样式（user/agent/tool/error + 角色标签）渲染正确。
- `pnpm test` 237/237 通过。

## 后续

- ranui 发版后：`pnpm-workspace.yaml`（保留 `packages:` glob、去掉 ranui link）+ 干净 `pnpm-lock.yaml` 一起提交，使提交态可 fresh-install / 过 CI。
- 可继续抽 `agent-core`（LLM + runtime）等叶子，见 [monorepo 规划](../superpowers/plans/2026-06-28-monorepo-v7-v9-split.md)。
