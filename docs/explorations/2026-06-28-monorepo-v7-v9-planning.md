# 2026-06-28 monorepo v7/v9 规划 + 工作区清理

## 背景

在 `feat/agent-collab` 分支讨论"按功能拆包/monorepo"。先盘清现状，再定方向。

## 发现

1. **当前分支不是真 workspace**：`pnpm-workspace.yaml` 无 `packages:` 字段，只有 `allowBuilds` + `ranui` 本地 link override。源码是扁平结构（`lib/`、`store/`、`index.ts`）。
2. **孤儿目录**：`apps/`（2.0GB）与 `packages/`（8KB）未被 git 跟踪，仅含 main 分支构建残留（`dist` 2GB、`node_modules`、`coverage`、空 `public-v9`）。系在 main（v9 monorepo）build 后切回老分支留下的 gitignore 产物。
3. **版本拓扑**：`main`→v9、`release/v0.0.4`→v7（本分支合入处）、`upgrade/onlyoffice-9.3.0`→v9 升级。v7/v9 **两条线长期并行维护**。
4. **资源进 git**：`public/` 328 个跟踪文件，`.git` 423MB。

## 改动

- **删除孤儿目录** `apps/`、`packages/`（`rm -rf`，释放 2GB）。安全：本分支 git 未跟踪它们，无源码丢失。`git status` 仅余既有的 `pnpm-lock.yaml`/`pnpm-workspace.yaml` 工作改动。

## 决策

- **抽包可行性**：agent-core（LLM/runtime）最易抽、最通用；converter 次之（需注入 WASM + 去 `ranui/message`）；编辑器核心是"应用"非"库"，不对外发布。
- **关键矛盾**：同 repo 两分支是独立快照，跨分支无法"修一次两边生效"。
- **用户拍板**：**合并为单 monorepo，v7/v9 同树共享 `packages/*`**（放弃 npm 发布 / 独立 repo 两个备选）。
- 产出详细规划：[../superpowers/plans/2026-06-28-monorepo-v7-v9-split.md](../superpowers/plans/2026-06-28-monorepo-v7-v9-split.md)。

## 后续

- 按 plan 阶段 0→6 推进；最安全起点是抽 `agent-core` PoC。
- 重点风险：合并发散分支（R1）、资源体积翻倍需移出 git（R2）、Agent 工具 v7/v9 接口差异（R3）。
