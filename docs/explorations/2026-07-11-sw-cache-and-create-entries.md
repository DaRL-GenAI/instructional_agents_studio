# 线上三问题：SW 跨部署缓存混乱、语言切换假 change、新建入口缺失

## 问题一：部署后页面样式全塌（用户报告，附控制台报错）

**症状**：线上打开/新建文档后，控制面板按钮无样式堆在左上角、编辑器画布高度
塌陷（PPT 显示 Zoom 5%）。控制台：`Refused to apply style from
'/assets/index-<hash>.css' because its MIME type ('text/html')`。

**根因**：旧 Service Worker 时代缓存的旧版 index.html 引用上一次部署的
hashed 资产；新部署后该文件已不存在，请求 404 回退成 HTML 页面，被当作
CSS 解析拒绝。JS 恰好还能命中缓存（所以按钮能点、能开文档），CSS 拿不到
（`html,body{height:100%}` 丢失 → #app/iframe 高度塌陷；r-button 样式全无）。
两处放大器：

1. 旧 SW 的 HTML network-first 用裸 `fetch(event.request)`，可能命中 HTTP
   缓存里的旧 HTML（状态 200，被当"最新"缓存下来）；
2. 单缓存 100 条上限，OnlyOffice 一次加载几百个资产，precache 的外壳文件
   （index.html 等）被 LRU 挤出，离线兜底随机失效。

**修复**（public/sw.js 重写）：

- HTML 导航请求 `fetch(request, { cache: 'no-cache' })` 强制与服务器再验证，
  永远拿到当前部署的 HTML → hashed 引用永远匹配；
- 拆双缓存：core（precache 外壳 + HTML，不参与修剪）与 runtime（SWR，上限
  600）；activate 清理所有旧版本缓存；
- `/assets/*` hashed 资产网络 404 时返回 `Response.error()`（绝不把 HTML
  体交给 CSS/JS 解析器），并顺手用 no-cache 重取 index.html 刷新外壳，下次
  导航自愈。
- 用户侧恢复路径：新 sw.js 部署后（文件名固定），浏览器导航时检查到更新 →
  install(skipWaiting) → activate(清旧缓存+claim) → 下一次导航即恢复正常，
  无需用户手动清缓存。

## 问题二：语言切换假 change 冲掉深链参数（防御性修复）

在带状态的环境观察到 `/?locale=zh-CN&new=docx` 被跳回 `/`。index.ts 的
lang-select change 监听器只要收到事件就整页跳转——任何来源的初始化/同值
change 都会把 `?new=` `?locale=` 深链冲掉。修复：与当前页面语言相同的值不
跳转（en 页收到 'en' 忽略、zh 页收到 'zh-CN' 忽略）。已核查 ranui select
源码：`syncSelectedFromValue`/`setDefaultValue` 都以 shouldDispatch=false
调用，初始化不派发 change——防御仍保留，成本为零、对任何回归免疫。
（顺带发现 CLAUDE.md 里的 lib/i18n.ts 已不存在，文档待刷新。）

## 问题三：首页缺新建 Excel/PPT 入口（用户报告的功能缺失）

改版后 hero 只有 "New document"（仅 docx）；新建 xlsx/pptx 的入口只在文档
打开后的 FAB 菜单里——首页彻底没有。修复：CTA 下加一行安静的 mono 快捷行
"start blank: Word · Excel · PowerPoint"（zh："新建空白：…"），走已有的
`?new=docx|xlsx|pptx` 深链（EN 直链，zh 带 `locale=zh-CN`）。样式
`.new-row`（12.5px mono，链接用 accent 蓝）。

## 验证

- 干净环境实测线上：静态页组件/样式正常（问题一确系用户浏览器旧 SW 状态）；
- 本地 `?new=xlsx` 深链：URL 保持、landing 隐藏、编辑器 iframe 全高；
- format/lint/240 单测/生产构建全绿。
