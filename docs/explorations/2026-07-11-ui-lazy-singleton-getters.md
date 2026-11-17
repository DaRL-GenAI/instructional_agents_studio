# lib/ui.ts 二迭代：可空模块变量 → 惰性单例 getter（Swift lazy var 等价物）

日期：2026-07-11
分支：main
涉及：`lib/ui.ts`（上一条 [2026-07-11-ui-module-element-refs.md](2026-07-11-ui-module-element-refs.md) 的改进）

## 问题（用户指出）

上一轮改成的三个 `let x: HTMLElement | null = null` 是"两阶段初始化"——
Swift 语境下就是满地 `Optional` + `guard let`：每个消费方都要判空 +
局部常量收窄（躲 setTimeout 闭包丢收窄），有没有更好的模式？

## 方案：惰性单例 getter（`??=`）

TS 里 Swift `lazy var` 的等价物——首次访问时构建，之后复用：

```ts
let controlPanel: HTMLElement | null = null;
let fab: { container: HTMLElement; button: HTMLElement } | null = null;

const getControlPanel = (): HTMLElement => (controlPanel ??= buildControlPanel());
const getFab = () => (fab ??= buildFab());
```

- **null 从消费方类型里消失**：`getControlPanel()` 返回 `HTMLElement`，
  show/hide/guide 里的守卫和收窄样板全部删掉。可空性被封死在 getter
  一行里（"make illegal states unrepresentable"）。
- **调用顺序不再是问题**：谁先调 getter 谁触发构建，之前"embed 消息可能
  早于 create"的顾虑直接消解（真早到也只是提前构建，而不是静默跳过）。
- **FAB 的 container + button 收进一个对象**：同时创建、只成对使用，
  两个散的模块变量并成一个聚合。
- 原 `createControlPanel` / `createFixedActionButton` 保留为薄包装
  （index.ts 启动预热的公共 API 不变），现在天然幂等——二次调用不会
  重复建 DOM。
- builder 用 **function 声明**（有提升），getter 在文件顶部引用文件
  下方的 builder 也不踩 TDZ/lint。

## 备选对比（为什么不用）

- `let x!: HTMLElement`（definite assignment，≈ Swift 的 IUO `!`）：
  对编译器撒谎，时序错了直接运行时炸，最差选项。
- class 封装（`new LandingUI()`）：合法但此文件只有两个单例元素，
  引入实例生命周期管理是过度设计。
- 依赖注入（把元素传进函数）：会改动 show/hide 的公共签名，波及
  index.ts / embed 回调接线，收益不成比例。

## 验证

- lint:ts / format / 240 单测 / 10 E2E 全过
- 构建产物实测 `?new=docx`：面板 none、FAB block；`showControlPanel()`
  恢复 flex、编辑器存在时 FAB 保留；`#control-panel-container` /
  `#fab-container` 各仅 1 个实例（幂等确认）
