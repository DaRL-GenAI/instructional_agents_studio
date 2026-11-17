# 2026-06-28 ChatView 对标业界的 IM 设计/交互优化

参考现代 AI 聊天（ChatGPT / Claude）做了一次 `@ranuts/chat-ui` 的设计与交互升级（零依赖，纯 CSS + 少量 JS）。

## 改动

### 消息样式

- **助手**：去气泡、全宽，提升行高/排版，长答案更易读。
- **用户**：右对齐强调气泡（圆角带尾），`--cui-user-bg`。
- **工具**：细微 pill chip（带圆点 + mono）。
- **错误**：浅红圆角块。
- 消息进入有轻微上浮动画；流式光标用强调色方块。

### 输入区（composer）

- 圆角容器（22px）+ 内嵌**圆形图标发送按钮**（↑），运行时变停止方块（⏹）。
- 空输入时发送按钮**禁用**（灰）；focus 时容器高亮描边。
- 自增高（≤160px）。`labels.send/stop` 变为按钮 title/aria-label。

### 交互

- **贴底自动滚动**：仅当用户已接近底部（<60px）时，新消息/流式才自动滚到底，避免用户上翻阅读时被拽下去。
- **跳到最新**按钮：上翻时出现（footer 上方居中圆钮），点击平滑滚到底。

### 结构

- ChatView 新增 footer（jump-to-latest + actionsEl + composer）；`actionsEl`（compose 工具槽）保留。

## 验证（chrome-devtools）

注入 user/agent/tool/error 样例，视觉符合预期；发送按钮空禁用→输入启用→清空禁用、图标 SVG；tsc 零错误 + 237 单测。

## 提交

chat-ui 包（chat-view.ts/styles.ts）+ 文档。pnpm-workspace/lock 仍暂缓。
