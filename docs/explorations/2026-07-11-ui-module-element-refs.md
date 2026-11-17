# lib/ui.ts：自建元素改用模块级引用，去掉重复 querySelector

日期：2026-07-11
分支：main
涉及：`lib/ui.ts`

## 问题（用户指出）

`hideControlPanel` / `showControlPanel` 每次调用都
`document.querySelector('#control-panel-container') as HTMLElement`，
但这两个元素（还有 `#fab-button`）本来就是本模块的
`createControlPanel()` / `createFixedActionButton()` 自己创建并挂到 body 的
——既然创建方在手里，就不该再绕 DOM 查询回来。

## 方案

模块级引用：

```ts
let controlPanelContainer: HTMLElement | null = null;
let fabContainer: HTMLElement | null = null;
let fabButton: HTMLElement | null = null;
```

- 创建函数在 `appendChild` 后给模块变量赋值；show/hide/guide 直接用。
- **null 守卫保留**：embed 消息等路径理论上可能在 create 之前触发
  show/hide，行为与原来 querySelector 查不到时一致（静默跳过）。
- 类型上更诚实：原来 `as HTMLElement` 把 `Element | null` 断言成非空，
  现在是显式 `HTMLElement | null` + 收窄（函数内先 `const container = ...`
  再判空，避免 mutable 模块变量在 setTimeout 闭包里丢失收窄）。
- `showMenuGuide` 里的 `#fab-button` 查询同模式一并替换。

## 边界说明

- `#landing-hero` 的 `getElementById` **保留**：hero 是服务端 HTML 里
  预渲染的（SEO），不是本模块创建的，查询是合理的归属。
- TS 坑：先声明 `let x: HTMLElement | null = null` 而赋值语句还没写时，
  流分析会把守卫后的类型收窄成 `never` 报一片错——按"声明+赋值+使用"
  一次改完即可。

## 验证

- lint:ts / format / 240 单测 / 10 E2E 全过
- 构建产物实测 `?new=docx`：编辑器打开后控制面板 display:none、
  FAB block、menu guide 出现（fabButton 引用生效）；
  `showControlPanel()` 面板恢复 flex，编辑器存在时 FAB 保留——与改前一致
