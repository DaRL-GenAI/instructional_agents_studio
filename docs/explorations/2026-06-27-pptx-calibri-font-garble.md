# 2026-06-27 PPTX Calibri 字体乱码：根因 + 为什么运行时修不了

新建 PPT 的占位符文字渲染成乱码（如标题 "Click to add title" 显示为 "Ajgai rm_bb rgjc"，每个字符字形向前偏移约 2 位）。Word、Excel、以及 Arial 字体的文字都正常。**结论：这是 v7.5 离线构建的字体引擎层问题，运行时/元数据层改不动，需 OnlyOffice 字体构建工具链或升级 9.x。已彻底排查，勿重复试以下无效方案。**

## 根因

- 新建 PPT 默认主题用 **Calibri / Calibri Light**（`public/sdkjs/common/AllFonts.js` 里有 `'Calibri Light', 232, 0, 233, ...` 等条目）。
- 本仓库 `public/fonts/` 只打包了开源字体（LiberationSans = Arial 兼容克隆、NotoSansSC 等），**没有 Calibri**。
- OnlyOffice 字体引擎把 Calibri 替换成 LiberationSans，**但仍用 Calibri 的字形索引映射** → LiberationSans 的字形顺序和 Calibri 不同 → 一致地错位（偏移 ~2）。
- Arial 正常，是因为 **LiberationSans 本就是 Arial 的字形兼容克隆**（字形顺序一致）。Excel 默认 Arial 所以不乱。

## 试过且无效的修法（chrome-devtools 实测，均已验证"加载了但没用"）

1. **加 Carlito（Calibri 的字形兼容免费克隆，LibreOffice 自带）+ font-map.json 映射 `calibri*.ttf → Carlito*`**
   - 给 `public/onlyoffice-v7-iframe-patch.js` 加日志证明:**编辑器从不发任何 Calibri 字体文件的 XHR**（winpath/ascdesktop/relfonts/UNMATCHED 全无日志）。
   - OnlyOffice 在字体管理器层就判定 Calibri 不可用并替换，**根本不请求文件** → font-map/iframe-patch 这层（只拦截 `ascdesktop://fonts/` 和 `c:\…\Fonts\` 请求，给 cell SDK 用的）拦不到。**无效。**

2. **改 `AllFonts.js` 的 `__fonts_infos`，把 Calibri/Calibri Light 的字体索引从自身（229/232…）改成 Arial 的（223,0,226,0,224,0,225,0）**
   - `fetch('/sdkjs/common/AllFonts.js')` 确认编辑器加载的是改后版本（Calibri Light 条目已是 223），但**乱码依旧**。
   - 说明 `__fonts_infos` 的索引不决定字形渲染。真正的字形映射在更深的 **`fonts.wasm` + `__fonts_ranges`（二进制字形数据）**。**无效。**

## AllFonts.js 结构备忘（排查时摸清的）

```
window.__fonts_files  = ['C:\\Windows\\Fonts\\arial.ttf', ...]   // 字体文件路径数组
window.__fonts_infos  = ['Arial', 223,0, 226,0, 224,0, 225,0]    // [名字, 常规idx,0, 粗idx,0, 斜idx,0, 粗斜idx,0]
window.__fonts_ranges = ...                                       // 二进制字形 range 数据（真正的 cmap/glyph）
```

头部注释说明：真实 Windows 字体已移除，这里只保留字体名"用于兼容"，应用回退到开源替代——但回退用的是 Calibri 自己的字形数据，于是错位。

## 正确的修法（都是较大的独立任务，未做）

- **用 OnlyOffice `allfontsgen` 重新生成** `AllFonts.js` + `fonts_thumbnail`，把 Calibri 映射到 Carlito（或真实字体）并让字形 range 匹配实际打包字体。需 OnlyOffice core 构建环境 + emscripten。
- **或随计划中的 OnlyOffice 7.5 → 9.x 升级一起处理**（见 CLAUDE.md「版本升级」章节）。
- **不要**手改 `fonts.wasm` 或 `__fonts_ranges` 二进制——改错会让线上所有字体乱码，部署线风险过高。

## 影响

- 仅影响 **Calibri 主题的 PPT 文字**（占位符及该主题下的文字）；Word / Excel / Arial 文字正常。
- 与 agent 协同功能无关；agent 功能在 `feat/agent-collab` 分支独立完整。
