# Talos Loop — 架构设计

本文记录 talos-loop 的设计意图与架构约定，是面向维护者的「为什么这么做」文档。具体配置项、快速上手见 [README.md](./README.md)。

> 写作原则：描述稳定的设计与数据流，避免罗列会快速过时的细节（精确字段、issue 编号、端口号）。如需精确签名，以代码（`server/src/`）为准。

---

## 一句话

把 **GitHub Projects 看板当作 workflow 引擎**：talos-loop 轮询看板，把 `Ready` + `ready-for-agent` 的 issue 派发给一个**自包含的 Claude Code skill**，skill 在隔离环境编码、提交 PR，看板随之推进。

## 三层分层（issue #32）

系统拆成职责严格分离的三层：

- **Source plugin**（issue 来源，`server/src/plugins/`）：只做「发现 issue」+「推进 stage」。接口收敛到 4 个方法：`list` / `writeLabel`（必填）+ `getItem` / `writeComment`（可选）。内置 `github` 插件对接 GitHub Projects。
- **Skill**（action 执行）：`github-code` / `github-review` 是独立、完全自包含的 Claude Code skill。server 通过 `/<skill>` 调用后由 skill 自驱完成全部工作（编码、建 PR、修评审线程、留言……），**不依赖任何 server HTTP 回调**——所有上下文从 `TALOS_*` 环境变量读取。
- **Server**（纯调度层，`server/src/services/`）：只管 worktree/tmux 会话生命周期、读 sentinel 判定退出码后调用 `writeLabel()` 推进 stage、以及崩溃时 `claude -r` 自动重试。**不再感知 PR/branch/review thread 等业务概念**。

`projects.json` 的 **`stages`** 把「stage → skill」映射起来（如 `{ "ready": "github-code", "in-review": "github-review" }`）。server 派发某 stage 的 issue 时，按该映射决定调用哪个 skill。

## 核心数据流

```
Issue (Ready + ready-for-agent)
        │
        ▼
   ┌──────────┐   定时轮询：插件 list()（唯一看板读，读失败抛错）
   │  Poller   │ ── 返回所有 active issue，每个带标准 state + 可选 subIssues
   └────┬─────┘
        │ discovered
        ▼
   ┌────────────┐  并发控制 (maxParallel) ── 派发前 getItem() 新鲜度复查
   │ Dispatcher │ ── state==queued → 调 ready skill
   │            │ ── state==done + 未解决 review subIssue → 调 in-review skill
   └────┬───────┘
        ▼
   ┌──────────────────────┐  worktree 隔离 ── 注入 TALOS_* env ── 调用 claude -p "/<skill> ..."
   │ tmux 隔离会话         │  管道：claude | tee <raw>.jsonl | node stream-formatter
   └────┬─────────────────┘
        │ 启动脚本写 exit code 到 sentinel；formatter 在 init 事件把 claude session_id 写到 sidecar
        ▼
   ┌──────────────────────────────────────┐
   │ coding exit 0  → writeLabel(processing→done) + 清 worktree        │
   │ coding 崩溃     → retry_count<maxRetry 且有 session_id → claude -r 重试 │
   │                  否则 failed + writeComment + 留 In progress       │
   │ review exit 0  → done + 清 worktree（不动看板）                    │
   │ review 崩溃    → failed + 清 worktree（下周期按 subIssue 重派）     │
   └──────────────────────────────────────┘
```

关键点：agent 通过 **skill 自驱**完成一切业务动作，**不回调 server**。dispatcher/poller 侧不执行任何版本操作，只读 sentinel 判定结果、据此调用 `writeLabel()` 推进 stage。

## 标准状态机

核心与插件之间只有三个抽象状态，插件负责在它们与源机制之间双向翻译：

```
queued(Ready) ──派发（调 ready skill）──► processing(In progress) ──exit 0──► done(In review) ──PR 合并──► Done
                                                    │
                                       崩溃 / 非零退出：预算内 + 有 session_id → claude -r 重试 ↺
                                       否则 session 标记 failed，看板保持 In progress（人工介入）

                       done(In review) + 未解决 review subIssue ──► 每周期派发 review skill（不动看板）
```

> ⚠️ 命名陷阱：`done` = GitHub **"In review"** 列（PR 已建），不是终态 "Done"。终态由 GitHub 的 PR 合并自动化推进，核心从不驱动。

设计约束：

- **没有 `failed` 状态、没有 `skipped` 动作。** 会话退出（无论正常或崩溃）本身不触发任何看板迁移；skip 概念已移除。
- **看板只由显式事件推进**：派发时 `queued→processing`（`writeLabel`）、clean exit 时 `processing→done`（`writeLabel`）。除此之外看板不动。
- 基础设施失败（进程崩溃 / 非零退出）→ 在 `maxRetry` 预算内自动 `claude -r` 重试；用尽则 session 标记 `failed`，issue 留在 `In progress` 等待人工，错误只记 session 行 + dashboard（可选 `writeComment` 留言）。agent 已完成的提交 / worktree 状态被保留，便于原地重试。
- `list()` 返回的 issue 恒为 active（queued/processing/done，非终态）；进行中的 issue 由 sessions 表跟踪，不会被重复派发。

## 关键设计决策

### 1. 看板是 workflow 真相源（board as source of truth）
轮询每个周期通过插件 `list()` 读**整张 active 看板**到内存快照（key=sourceId → 标准状态），展示层据此派生显示状态。而非依赖核心自己维护一份并行状态。读取失败必须抛错（不能返回空数组），否则会把「看板读取失败」误判成「看板为空」。

### 2. 退出后不自动回退；自动 retry 只在预算内
早期版本会在失败时自动回退看板，结果掩盖问题、产生重复派发。当前约定：失败只暴露在 dashboard，issue 停在 `In progress`。**唯一的自动重试**是崩溃的 coding 会话在 `maxRetry` 预算内通过 `claude -r` 原地续跑（复用 worktree + 分支）；超出预算即停，由人决定下一步。

### 3. exit code + sentinel 判定
agent 在 tmux 会话里跑一个启动脚本，把退出码写到一个 sentinel 文件；会话结束后 dispatcher 读 sentinel（而非靠 tmux 退出码），据此分类结果。这样 agent 的「业务成功（exit 0）」与「进程正常退出」可被独立判别。

> claude 以 `-p` 打印模式 + stream-json 触发：进程在任务完成后**确定性退出**，sentinel 才会被可靠写入——交互模式不自动退出会让完成判定彻底失效。server 调用的是 **skill**（`claude -p "/<skill> 处理 issue：<url>"`），上下文经 `TALOS_*` 环境变量注入。stdout/stderr 经启动脚本管道 `tee <raw>.jsonl | node stream-formatter`，formatter 向 pane 渲染【思考】/【工具】/文本（attach 可观测 + 失败取证），并在流的 `init` 事件把 claude 的 session_id 写到 sidecar——dispatcher 每周期读取入库，故运行中即可 `claude -r <id>` 恢复。因引入管道，退出码用 `${PIPESTATUS[0]}`（取 claude 段），不用 `set -o pipefail`（会污染 sentinel）。同一周期还有一道墙上时钟看门狗：运行中会话超 `claudeTimeout` 即 `killSession` → 无 sentinel → 归类 failed（session_id 已捕获则仍可 resume / 自动重试）。

### 4. skill 驱动，插件只管「发现 + 推进」
agent 可做的全部业务动作（建 PR、留言、修评审线程……）都封装在**独立的 Claude Code skill** 里，由 agent 通过 `/<skill>` 自驱完成，**不回调 server**。server 只在派发时按 `stages` 映射决定调用哪个 skill，并把 issue 上下文以 `TALOS_ISSUE_URL` / `TALOS_SOURCE_ID` / `TALOS_PROJECT_ID` / `TALOS_REPO_PATH` / `TALOS_TARGET_REPO` / `TALOS_BRANCH` 环境变量注入。插件接口因此收敛到 `list` / `writeLabel` + 两个可选方法——新增业务能力改 skill，不动 server 或插件。

### 5. worktree + tmux 双重隔离
每个 session 一个 git worktree（独立分支，便于 PR + 原地重试）+ 一个 tmux 窗口（隔离进程、可人工 attach 查看）。成功会话默认自动清理 tmux 窗口 + worktree，失败 coding 会话保留 worktree 以便 `claude -r` 原地重试。

### 6. 插件单例 + per-project 缓存
loader 按 `projectType` 缓存单例插件。一个插件实例可能服务于多个同类型 project，因此 per-project 元数据必须由插件自己按 `projectId` 缓存（惰性解析，接口无 `init`），不能放实例字段。加载用 `require()`，故插件禁止 top-level await、需 Node ≥ 22.12。

### 7. review 是 done 状态上的常驻 worker，按 subIssue 信号驱动
`done`（In review）不是被动等待合并的死状态：插件在 `list()` 中对 in-review 项探查关联 PR 的评审线程，发现未解决线程即在 issue 上携带 `review` subIssue；dispatcher 每个周期据此派发 `in-review` skill 会话。agent 自驱动「拉线程 → 修复 → 推回原分支 → 复查」循环，直到全解决或 PR 合并。

三个关键约束：

- **不碰看板**：review 会话不发 `writeLabel`，issue 恒 In review。它与 coding 会话通过 session `type` 区分，在 `checkRunningSessions` 里**先于**成功路径分流。
- **失败隐式重试**：review 会话崩溃 / 非零退出不回退看板，下一个周期 `list()` 仍会探出未解决线程，自然重新派发——所以 review 阶段天然重试，**不走 `claude -r`**（与 coding 不同）。
- **线程真相源是 GitHub review thread**：触发与终止都以 GitHub 原生 `reviewThreads` 的 `isResolved` 为准。普通 PR 评论不产生 review thread、不触发。

## 模块职责（`server/src/`）

| 模块 | 职责 |
|------|------|
| `index.ts` | 入口：加载配置 → 初始化 DB → 起 Fastify → 启动轮询 |
| `config.ts` | 加载 `config.json` + `projects.json`（含 `stages` 映射），校验 |
| `db/` | SQLite（WAL）：`issues` + `sessions` 表 |
| `routes/api.ts` | REST API 路由（读侧 + kill / resume-command / poll / webhook） |
| `plugins/loader.ts` | 按 `projectType` 解析、实例化、缓存插件单例 |
| `plugins/github/` | 内置 GitHub source 插件（4 方法） |
| `services/poller.ts` | 定时轮询：调 `list()` 取 active issue，重建看板快照 |
| `services/dispatcher.ts` | 核心：并发控制、skill 调用、exit code 判定、结果分类、`claude -r` 重试、review 派发 |
| `services/tmux.ts` | tmux 会话生命周期管理 |
| `services/worktree.ts` | git worktree 创建 / 复用 / 清理 |
| `services/boardSnapshot.ts` | 看板内存快照（标准状态） |
| `services/displayState.ts` | 看板标准状态 → 标准显示状态派生 |
| `services/logger.ts` | 结构化日志（控制台 + 文件） |

> skill（`github-code` / `github-review`）不属于本仓库的 server 代码——它们是 Claude Code skill，由 agent 在运行时加载。server 只按名字调用。

## 数据模型（概览）

- **`issues`**：每个被发现的 issue 一行，键含 `projectId` + `sourceId` + `targetRepo`；记录身份 / 显示缓存。
- **`sessions`**：每个 agent 会话一行，关联 issue；记录 tmux 会话名、worktree 路径、分支、退出码、`type`（coding/review）、`claude_session_id`（支撑 `claude -r`）、`retry_count`、结果状态（`done`/`failed`/`killed`）、失败原因等。

进行中的 issue 由 sessions 表跟踪，`list()` 不会重复返回它们。

## 内部 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 系统状态（运行中会话数、projects） |
| GET | `/api/projects` | Projects 列表及其 repos |
| GET | `/api/repos` | 所有 project 仓库的并集 |
| GET | `/api/repos/:name/issues` | 指定仓库的 Issue 列表 |
| GET | `/api/issues` | 所有 Issue（含 sessions，状态由快照 + sessions 派生） |
| GET | `/api/issues/:id/sessions` | Issue 的会话记录 |
| POST | `/api/sessions/:id/kill` | 终止运行中的会话 |
| GET | `/api/sessions/:id/resume-command` | 组装 `claude -r <id>` 恢复命令（供操作者在自己的终端执行） |
| POST | `/api/poll` | 手动触发轮询 |
| POST | `/api/webhook` | Webhook 入口（触发一次轮询） |

> agent **不再回调 server**——曾经的 `POST /api/.../actions/:action` 统一入口已在 issue #32 移除。所有 agent 信号都由 skill 自身直接对 GitHub 操作产生。

## 技术栈

- **后端**：Fastify · better-sqlite3 · TypeScript
- **前端**：React · Vite · Tailwind CSS · Lucide Icons
- **基础设施**：tmux · GitHub CLI（Projects）· Claude Code CLI（skill）

## 日志

结构化日志输出到控制台（彩色 `[LEVEL] [module] message`）与文件（`~/.talos/logs/talos-loop.log`）。Claude Code 自身的执行记录可通过 `claude -r` 查看。
