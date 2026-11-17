# Agent 下一阶段计划 + 拆包评估

> 分支：`feat/agent-collab`（扁平结构，OnlyOffice v7.5）。现状见
> `docs/explorations/2026-06-23-agent-*.md` 与
> `docs/changelogs/2026-06-23-agent-collab.md`。

## 一、拆包评估（结论：现在不拆，分层 + barrel 即可）

当前 agent 代码 ~1576 行 / 14 文件，已按功能分层，依赖方向干净无环：

```
ui/ (panel, controller)  →  runtime  →  tools + editor-bridge (OnlyOffice)
                                     →  llm/ (provider 无关、编辑器无关)
```

`llm/` 经实测确认 0 处编辑器依赖，是唯一有真实复用价值的边界。

**为什么现在不拆成 npm 包：**

- 规模小（1.5k 行），目录分层已足够维护。
- 只有一个 app 消费，没有第二个消费者 → 拆包是纯 ceremony。
- 本分支是扁平结构（v0.0.4 线），引 monorepo 与初衷矛盾。
- 过早固化边界，边界还没被真实复用验证。

**该做的（低成本拿到"组合"收益）：**

- [ ] 加 barrel：`lib/agent-plugin/llm/index.ts`、`ui/index.ts`、`lib/agent-plugin/index.ts`，各导出本层公共 API。
- [ ] 外部统一从 barrel 引入，内部文件移动不影响调用方。

**真正拆包的时机：** 合并进 `main`（已是 monorepo：packages/core、editor-v7/v9、apps/web）时，agent 自然成为 `packages/agent`；若届时 `llm/` 出现第二个消费者，再抽 `packages/agent-llm`。

## 二、新功能（都嵌入现有层，不改架构）

### 3. 更多 LLM Provider（验证 provider 抽象）

- [ ] **Ollama**（本地）：OpenAI 兼容，**直接复用 `llm/openai-format.ts`**，新 `llm/ollama.ts` 仅设 baseURL（默认 `http://localhost:11434/v1`）+ 无需 key。
- [ ] **Gemini**（云端）：自有 REST 格式，新 `llm/gemini.ts` + 独立转换；key 存 `agent_api_key_gemini`。
- [ ] `factory.ts` 的 `ProviderId` 加 `'ollama' | 'gemini'`，`createProvider` 分发。
- [ ] panel provider 选择器加两项 + i18n key。

### 4. 流式输出

- [ ] `LLMProvider` 接口加 `chatStream(messages, tools, onDelta): Promise<LLMResponse>`（可选；不支持的 provider 退化为非流式）。
- [ ] Anthropic/OpenAI/WebLLM 实现流式（SDK 都支持 stream）。
- [ ] `runtime.runAgent` 透传 delta 事件；`AgentEvent` 加 `assistant_delta`。
- [ ] `controller` → `panel`：assistant turn 增量更新（同一气泡追加文字）。

### 2. 对话持久化

- [ ] 新 `lib/agent-plugin/ui/storage.ts`：history 序列化存 localStorage（或 IndexedDB，若超限）。
- [ ] `controller` 在每轮结束后保存；构造时可选恢复。
- [ ] panel「清空对话」同时清存储；按文档/会话维度区分 key。

## 三、其它待办（原计划阶段三遗留，优先级低）

- [ ] 真实 API key 端到端 e2e（让 Claude 实际编辑文档跑一轮完整对话）。
- [ ] 撤销上次 agent 操作（`Api.Undo` / editor-bridge）。
- [ ] PPT Calibri 字体乱码（独立任务，见
      `docs/explorations/2026-06-27-pptx-calibri-font-garble.md`，需 allfontsgen 或随 9.x 升级）。

## 建议顺序

1. barrel（10 分钟，立即拿到"组合"清晰度）
2. Ollama provider（最快，复用 openai-format，验证抽象）
3. 流式（体验提升最大）
4. Gemini provider
5. 对话持久化
