# 2026-06-28 PPT 字体乱码修复（按编辑器精准化字体改写）

## 现象

新建 PPT 占位符文字乱码："Click to add title" → "Ajgai rm_bb rgjc"，整体 **-2 字形偏移**。Word/Excel 正常。用户反馈 **v0.0.4 tag 时是好的**。

## 排查

1. 本分支(feat/agent-collab) vs `release/v0.0.4`：字体文件、empty_bin、converter、字体 patch 改动均为空 → 不是本分支引入。
2. 改 `font-map.json`（去掉 calibri 映射）→ **乱码不变**。
3. DevTools Network 过滤 `calibri` → **根本没有 calibri 请求**。说明 PPT 字形不走 XHR，font-map 改目标无效。
4. v0.0.4 tag → HEAD 全量 diff：引擎二进制（`fonts.wasm` / `AllFonts.js` / `sdk-all-min.js`）**完全没变**；`presentationeditor/main/index.html` **只多了一行**——注入 `onlyoffice-v7-iframe-patch.js`。
5. 隔离测试：patch 里加 `DISABLE_FONT_REMAP=true`（全局关字体改写）→ **PPT 恢复正常**。确认 patch 的字体改写就是元凶。

## 根因

patch（本为修 Excel cell 的 CJK #62/#64）全局劫持 `XMLHttpRequest.open` 改写所有字体请求，且被注入到**所有**编辑器。幻灯片引擎**按 glyph-ID 渲染**：请求被改写成替换 TTF（如 LiberationSans）后字表错位 → 整体偏移。让请求失败（=v0.0.4 行为）则引擎走内置 cmap 字形，正常。

杠杆在"**要不要改写**"，不在"改写成谁"——因为 PPT 压根不发 calibri 的 XHR。

## 修法

[public/onlyoffice-v7-iframe-patch.js](../../public/onlyoffice-v7-iframe-patch.js)：

```js
// 仅在 spreadsheet(cell) 编辑器需要改写（修 CJK #62/#64）；
// presentation 编辑器按 glyph-ID 渲染，改写会偏移 → 禁用。
var DISABLE_FONT_REMAP = window.location.pathname.indexOf('presentationeditor') !== -1;
```

即 **PPT 禁用字体改写、Word/Excel 保留**。

## 验证

- PPT：新建 → 英文占位符标题正常，不偏移。
- Excel：新建 → 中文 / 日期 / 中英混排正常，CJK 未回归。

## 修正的旧认知

之前 memory/记录判定为"字体引擎层不可修、需 allfontsgen 或升级 9.x"——**错**。font-map calibri→Carlito/Arial、AllFonts 索引改法之所以无效，是因为 PPT 不走 XHR 取 calibri，而非引擎不可修。memory `project_pptx_calibri_font_garble` 已更新。
