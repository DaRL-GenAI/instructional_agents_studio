# 中英文首页对齐：语言切换箭头缺失根因 + 中文页"打开文件"CTA

日期：2026-07-11
分支：main
涉及：`packages/chat-ui/package.json`、`packages/converter/package.json`、
`public/ranui-iife/*`（重新同步）、`public/open-local.js`（新增）、
`lib/pending-open.ts`（新增）、`lib/document.ts`、`index.ts`、
`public/zh-CN/index.html`

## 问题（用户指出）

线上中英文首页没对齐：

1. 语言切换 r-select **中文页有下拉箭头，英文页没有**。
2. 中文页主 CTA "打开编辑器 →" 实际链到 `/?locale=zh-CN&new=docx`，和旁边
   "新建 Word" 完全重复；英文页主 CTA "Open a file" 是文件选择器，才是对的。

## 根因一：重复 ranui 版本吃掉了 select 的箭头图标

`@ranuts/chat-ui` 和 `@ranuts/converter`（workspace 包）锁死
`ranui@0.2.0-alpha.0`，主应用是 `alpha.5` → 生产 bundle 里**两份 ranui 并存**。
自定义元素注册有 guard（先到先得）：alpha.0 的 `r-icon` 先注册，alpha.5 的
select 把 `arrow-down` 图标注册进了 **alpha.5 自己的 registry**，旧 `r-icon`
读不到 → 箭头静默消失。

- **dev 不复现**（Vite optimizeDeps 下加载路径不同），`vite build` 后 100% 复现
  ——这也是它一直没被发现的原因。本地 `pnpm vite preview` 先复现、修后消失，
  已闭环验证。
- 顺带发现 `public/ranui-iife/*` 四个 vendored 文件与 node_modules 漂移
  （之前从别的构建拷入），已按 build.sh 同款逻辑重新同步为 alpha.5。

修法：两个 workspace 包 ranui 统一到 `0.2.0-alpha.5`，`pnpm why ranui` 现在
只有一个版本。**教训：workspace 包的 ranui/ranuts 版本必须跟根 package.json
一致，否则 bundle 里静默双份，坏的是运行时行为而不是构建。**

## 根因二：静态中文页没有应用 bundle，无法直接开文件选择器

对齐方案：**IndexedDB 文件交接**（保持"全本地"定位，不引入服务器）：

- `public/open-local.js`（新增，卫星页可复用）：`[data-open-local]` 按钮 →
  隐藏 `<input type=file>`（accept 与应用一致）→ 选中文件存入
  IndexedDB `document-handoff/files/pending` → 跳转按钮属性里的目标 URL
  （`/?locale=zh-CN&open=local`）。IDB 不可用（隐私模式）时降级为去掉
  `open=local` 直跳应用首页。
- `lib/pending-open.ts`（新增）：`takePendingFile()` 一次性取出并删除。
- `lib/document.ts`：把 `onOpenDocument` 选中文件后的处理体抽成导出的
  `openLocalFile(file)`，两条路径共用。
- `index.ts`：`?open=local` 时 hideLanding → 动态 import 取文件 →
  `openLocalFile`；**取完立即 `replaceState` 清掉 `open` 参数**（一次性深链，
  防刷新后卡在空 hero）；无待处理文件（过期书签/刷新）回落 `showLanding()`。
- `public/zh-CN/index.html`：主 CTA 改为
  `<r-button data-open-local="/?locale=zh-CN&open=local">打开文件</r-button>`，
  加载 open-local.js。

## 验证（构建产物 + 浏览器实测）

- 英文页构建产物：语言切换箭头恢复；中文页（alpha.5 iife）同款箭头 → 对齐
- 中文页点"打开文件"→ 注入 CSV 触发 change → 存 IDB → 跳转 → **中文界面**
  表格编辑器打开 handoff-test.csv，URL 参数已清理
- 直访 `/?open=local`（无待处理文件）→ 正常回落到落地页
- format / lint:ts / 240 单测 / 10 E2E 全过

## 后续可选

- 16 个卫星页的 CTA 也可换 `data-open-local`（脚本已按可复用写）
- SW 更新后线上英文页箭头需等新 bundle 生效（deploy 后自动 reload 逻辑已有）
