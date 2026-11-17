# 2026-06-28 chat-ui 改用 ranui builder + ranuts

## 决策变更

chat-ui 原本刻意零依赖（可发布、通用）。用户要求全仓统一用 ranui builder，遂**反转该决策**：chat-ui 也改用 ranui builder 构建 DOM、用 ranuts 工具。代价：chat-ui 现在依赖 `ranui`(beta) + `ranuts`，不再是零依赖通用包，发布时需带上它们。

## 改动

- `package.json`：加 `ranui` + `ranuts` 依赖；描述去掉 "dependency-free"。
- `chat-view.ts`：`document.createElement` 全改 ranui builder —— `Div/Span/ButtonBuilder/View('textarea')` + `.class/.attr/.aria/.on/.children/.build()`。SVG 图标 build 后赋 innerHTML（builder 不收原始 HTML）。scroll 监听用 ranuts `throttle(fn, 100)`。
- `styles.ts`：样式注入改用 ranui `Style().id().text().build()`。
- README/CLAUDE.md：更新表述（不再"零依赖"；改为"基于 ranui builder"）。

## 验证（chrome-devtools）

chat 挂载、composer/发送图标/textarea 输入、`Style()` 注入、输入即启用发送、零报错；tsc + 237 单测通过。

## 提交

chat-ui 包 + 文档。pnpm-workspace/lock 仍暂缓（含 chat-ui 新增依赖的 lock 变更）。
