# 2026-06-23 Agent Phase 1：editor-bridge + 首个工具

承接 Phase 0 验证结论（见 `docs/superpowers/plans/2026-05-30-agent-collab-editor.md` 的「验证结果」），在 `feat/agent-collab` 分支落地 agent 工具层的地基。

## 背景结论（来自 Phase 0）

离线 v7.5 构建裁掉了标准插件模型（无 `plugins.js`、`Asc.plugin` 单例 undefined），但插件命令 API 全部编译进 SDK，挂在编辑器 iframe（同源）的 `contentWindow.editor`（asc_docs_api 实例）上，可被父页面直接调用。所以工具层走「同源直连」而非插件 iframe / postMessage。

## 本次新增

```
lib/agent-plugin/
  editor-bridge.ts   # 同源访问器：定位编辑器 iframe，取出 contentWindow.editor
  types.ts           # AgentTool 接口（传输无关：name/description/inputSchema/readOnlyHint/execute）
  tools.ts           # insert_text 首个工具 + textToHtml 辅助 + agentTools 注册表
test/unit/
  agent-editor-bridge.test.ts
  agent-tools.test.ts
```

### editor-bridge.ts

- `getEditorApi()`：`document.getElementById('iframe')` → `querySelector('iframe')` → `contentWindow.editor`，每次现查（编辑器会销毁重建，缓存会拿到陈旧句柄）。跨域访问 try/catch 兜底返回 null（同源部署下不会触发）。
- `requireEditorApi()`：取不到时抛 `EditorNotReadyError`。
- `EditorApi` 接口只把 Phase 0 验证过的方法显式类型化（PasteHtml/InputText/GetSelectedText/GetSelectionType/SetTrackRevisions），其余用索引签名兜住，避免每个调用点 `any`。

### tools.ts — insert_text

- 封装 `pluginMethod_PasteHtml`（Phase 0 已实证可插入）。
- `textToHtml()`：先转义 `& < >` 再把换行转 `<br />`，防止文本里的标记被当 HTML 注入。
- 非字符串入参抛 `TypeError`；编辑器未就绪时透传 `EditorNotReadyError`。

## 验证

- tsc：通过（两处需 `as unknown as` 跨过全局 `Window.editor`（DocEditor）类型）
- oxlint / prettier：通过
- 单测：118 通过（+14）；`lib/agent-plugin` 覆盖率 96% 语句 / 100% 行
- 已加入 `vitest.config.ts` 的 coverage include：`lib/agent-plugin/**/*.ts`

## 下一步

Phase 1 续：补 `get_selection` / `get_document_text`（只读工具，封装 `pluginMethod_GetSelectedText` / `GetSelectionType`）、`replace_selection`、`add_comment`、`set_review_mode`。随后 Phase 1.2 LLM 接入层。
