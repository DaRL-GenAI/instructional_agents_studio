# 2026-06-23 Agent Phase 2：UI 面板

把跑通的后端(工具 + LLM + 运行时)变成用户能点的入口。

## 结构:可测控制器 + 薄 DOM 视图

```
lib/agent-plugin/ui/
  controller.ts  # AgentChatController:对话状态 + 驱动 runAgent + 发出 turn(可测核心)
  panel.ts       # createAgentPanel():侧边栏 DOM 视图(薄)
styles/base.css  # .agent-panel 等样式
index.ts         # ?agent=1 时动态 import 面板
```

- **controller.ts**(可测):持有 `LLMMessage[]` 历史,`send(text)` 调 `runAgent`,把 `onEvent` 映射成 UI turn(user/agent/tool/error)。provider 注入,单测用 mock。覆盖:空输入忽略、user→agent、工具调用→tool turn、工具错误/步数上限/provider 抛错→error turn、历史累积、reset。
- **panel.ts**(DOM 视图):右侧栏 = 头部(标题+关闭)+ API Key 输入(存 localStorage)+ 对话列表 + 输入框(Enter 发送)。key 变化时重建 controller。DOM 重,不单测(同 CLAUDE.md 约定),靠 chrome-devtools 冒烟。
- **入口**:`?agent=1`(或 `=true`/裸 `?agent`)动态 import,默认不加载——零成本、不影响主应用。

## 冒烟验证(chrome-devtools)

`/?agent=1` 加载:面板正常挂载(确认 `@anthropic-ai/sdk` 动态 import 成功打包),标题「AI 助手」、Key 输入存在;无 key 点发送 → 错误 turn「请先填写 Claude API Key。」。截图确认外观,主应用功能不受影响。

## 验证

- tsc / oxlint / prettier:通过
- 单测:174 通过(controller 8);`controller.ts` 100% 行,`panel.ts` 为 DOM 视图未单测(已冒烟)

## 现状:功能可用

填入 Claude API Key + 一句指令,面板就能驱动 Claude 读写当前文档(经 Phase 1.3 运行时 + Phase 1 工具 + editor-bridge)。这是 agent 协同的最小可用闭环。

## 下一步(可选)

- WebLLM 离线 provider(同 `LLMProvider` 接口)+ provider 选择(检测 WebGPU)
- 真实 key 的端到端 e2e(让 Claude 实际插入/批注文档)
- 面板打磨:停止按钮、清空对话、修订模式状态提示(对应原计划阶段三)
