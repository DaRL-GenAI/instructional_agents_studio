# 2026-06-28 修复 Agent 面板：select 下拉打不开 + 工具栏溢出

## 现象

- 面板里两个 `r-select`（Provider / 模型）点击无反应、看不到选项。
- 工具栏 Quote selection / Clear chat 被裁切。

## 排查（chrome-devtools）

- r-select 已正常升级：`aria-expanded` 点击会 true/false 切换、`r-option` 有 `ran-option` class、`value` 正确。
- 但展开时选项仍 `display:none`、rect 为 0。
- 关键：`aria-controls` 指向的下拉是 light-DOM 里的 `<r-dropdown role="listbox">` 门户（`body > div > r-dropdown`），inline `position:absolute`，**`z-index: 10`**。
- 而 `.agent-panel` 是 **z-index: 10000** → 下拉一打开就被面板盖在后面，肉眼"打不开"。
- 实测注入 `r-dropdown{z-index:100000}` 后，下拉出现在 select 正下方、最顶层为可点的 `r-dropdown-item`。✓

## 修复（styles/base.css）

```css
r-dropdown[role='listbox'] {
  z-index: 100000;
} /* 抬到面板之上 */
.agent-panel-toolbar {
  flex-wrap: wrap;
  gap: 8px;
} /* 防溢出，必要时换行 */
```

## 验证

下拉弹出显示 5 个 Provider；工具栏不再横向溢出（换行成两行）。

## 是否 ranui 的问题

**部分是。** ranui 把下拉/弹层渲染成 body 级门户却只给 `z-index: 10`，过低，任何稍微抬高的 app 浮层都会盖住它。建议反馈 ranui：把 dropdown/popover 门户放到高 z-index 层级，或暴露 CSS 变量（如 `--ran-z-dropdown`）让消费方可调，避免 `!important` 覆盖。我们这条 z-index 覆盖是临时 workaround。
