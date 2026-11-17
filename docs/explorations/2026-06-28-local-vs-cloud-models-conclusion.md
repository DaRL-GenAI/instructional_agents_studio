# Agent 模型选型结论：本地小模型 vs 云端（2026-06-28）

> 结论沉淀。本次围绕 WebLLM 本地模型踩了一连串坑，统一记录，供后续选型/默认值/产品话术参考。

## 一句话结论

**本地小模型（7–8B）不适合当 agent 的"工具执行大脑"。** 纯聊天/问答/改写尚可用；但需要**稳定的结构化工具调用 + 多轮循环**时不靠谱。要可靠体验用**云端**（Claude / OpenAI / Gemini）。

不是"小模型没用"，是"**小模型不适合这个重度依赖 function calling 的场景**"。

## WebLLM 本地模型的硬约束（本次实测踩坑）

1. **只有 Hermes 系列支持 function calling**。Llama-3.2 / Qwen2.5 / Phi-3.5 等小模型**不支持 tools**，一带 tools 直接报错。可用：Hermes-2-Pro-Mistral-7B、Hermes-2-Pro-Llama-3-8B、Hermes-3-Llama-3.1-8B。
2. **工具能力模型最小 ~4GB**（7–8B，q4f16）。没有更小的工具模型——本地 agent 最低门槛就是 ~4GB 下载 + WebGPU。
3. **Hermes + tools 时禁止自定义 system prompt**（WebLLM 自注入工具系统提示）。我们的对策：把引导**折叠进首条 user 消息**。
4. **格式不稳**：8B 模型时常不按 `<tool_call>` 结构吐，而把 tool call 当 JSON 文本输出（界面就显示成 `[{"arguments":...,"name":...}]`），或退化重复。这是模型质量问题，代码难稳修。
5. **中断**：停止生成必须主动调 `engine.interruptGenerate()`，光在迭代间检查 abort signal 不够。

## 我们已做的"本地最佳化"（尽力而为）

- 默认模型用最强的 **Hermes-3-Llama-3.1-8B**。
- 引导折叠进首条 user 消息（绕过 system prompt 限制）。
- 生成参数 `temperature 0.3` + `max_tokens 1024`，抑制退化跑飞。
- Stop 贯穿 abort signal + `interruptGenerate`，可真正中断。
- 自动加载仅在模型已缓存时触发（避免惊吓式 4GB 下载）。

即便如此，本地工具调用仍不如云端稳。

## 推荐的产品取向

| 目标                                       | 选择                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| 可靠的文档编辑 / 工具调用                  | **云端**（默认推荐），⚙ 设置填 API Key                                 |
| 离线 / 隐私 + 能接受 ~4.7GB 与偶发格式错乱 | 本地 Hermes-3-8B                                                       |
| 进一步可选方案（未实现）                   | "本地=纯聊天（不挂工具）/ 云端=完整 agent"分档，避免本地因工具格式崩溃 |

## 相关排查记录

- [Hermes 工具模型 + system prompt 限制](2026-06-28-webllm-tool-capable-models.md)
- [Stop 中断 + 本地最佳化](2026-06-28-agent-stop-abort-midstream.md)
- [add_comment 跨编辑器构造器](2026-06-28-add-comment-spreadsheet-ctor.md)
