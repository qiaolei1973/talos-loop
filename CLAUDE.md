# Talos Loop — 架构设计

本文记录 talos-loop 的设计意图与架构约定，是面向维护者的「为什么这么做」文档。具体配置项、快速上手见 [README.md](./README.md)。

> 写作原则：描述稳定的设计与数据流，避免罗列会快速过时的细节（精确字段、issue 编号、端口号）。如需精确签名，以代码（`server/src/`）为准。

---

## 一句话

把 **GitHub Projects 看板当作 workflow 引擎**：talos-loop 轮询看板，把 `Ready` + `ready-for-agent` 的 issue 派发给 Claude Code，agent 在隔离环境编码、提交 PR，看板随之推进。核心通过与 issue 源解耦的插件对话，自身只维护抽象的标准状态机。

## 核心数据流

```
Issue (Ready + ready-for-agent + 无 skipped)
        │
        ▼
   ┌──────────┐   定时轮询
   │  Poller   │ ◄── 插件 discover() / listBoard()
   └────┬─────┘
        │ 发现可派发 Issue
        ▼
   ┌────────────┐  并发控制 (maxParallel) ── 派发前 getStatus() 新鲜度复查
   │ Dispatcher │ ── 生成 Prompt（按 capabilities() 动态渲染 actions API 块）
   └────┬───────┘
        ▼
   ┌──────────────────────┐
   │ tmux 隔离会话         │  worktree 隔离 ── 编码 ── 推送分支 ── 调用 submit-pr
   │ claude -p <prompt>    │
   └────┬─────────────────┘
        │ 启动脚本写 exit code 到 sentinel；会话结束后按退出码 + 是否有 pr_url 判定
        ▼
   ┌──────────────────────────────────────┐
   │ exit 0 + pr_url → 推进到 done(In review) + 评论 PR │
   │ exit 0 无 pr_url → session 完成，看板不动           │
   │ 异常退出 / 无 sentinel → session failed，看板不动   │
   │ skip action → 插件处理（标签 + 评论 + 回 queued）    │
   └──────────────────────────────────────┘
```

关键点：agent 通过**唯一一个 HTTP 入口**（`/actions/:action`）回传信号，dispatcher/poller 侧不直接执行版本操作，仅读 sentinel 判定结果。

## 标准状态机

核心与插件之间只有三个抽象状态，插件负责在它们与源机制之间双向翻译：

```
queued(Ready) ──派发──► processing(In progress) ──exit 0 + pr_url──► done(In review) ──PR 合并──► Done
                                                    │                        │  ↺ review-fix
                                       exit 0 无 pr_url / 异常退出      自循环（未解决评审线程）
                                                    │                  → 修复 → resolve-thread
                                       session 标记 done/failed，
                                       看板保持 In progress（人工介入 / 重试）

                       skip action ──► 加 skipped 标签 + 回 queued（block，直到人工移除标签）
```

> ⚠️ 命名陷阱：`done` = GitHub **"In review"** 列（PR 已建），不是终态 "Done"。终态由 GitHub 的 PR 合并自动化推进，核心从不驱动。

设计约束：

- **没有 `failed` 状态。** 会话退出（无论正常或崩溃）本身不触发任何看板迁移。
- **看板只由显式 agent 动作推进**：`submit-pr`（推进到 `done`）、`skip`（退回 `queued`）。
- 基础设施失败（进程崩溃 / 非零退出）→ session 标记 `failed`，issue 留在 `In progress` 等待人工；错误只记在 session 行 + dashboard，不发 issue 评论。agent 已完成的提交 / worktree 状态被保留，便于原地重试。
- `discover()` 返回的 issue 恒为 `queued`；进行中的 issue 由 sessions 表跟踪，不会被重新发现。

## 关键设计决策

### 1. 看板是 workflow 真相源（board as source of truth）
轮询每个周期通过 `listBoard()` 读**整张看板**到内存快照，展示层据此派生显示状态。而非依赖核心自己维护一份并行状态。读取失败必须抛错（不能返回空数组），否则会把「看板读取失败」误判成「看板为空」。

### 2. 退出后不自动回退 / 不自动重试
早期版本会在失败时自动回退看板、自动重试，结果掩盖问题、产生重复派发。当前约定：失败只暴露在 dashboard，issue 停在 `In progress`，由人决定重试或手动移动卡片。保留 worktree 让「原地重试」可行。

### 3. exit code + sentinel 判定
agent 在 tmux 会话里跑一个启动脚本，把退出码写到一个 sentinel 文件；会话结束后 dispatcher 读 sentinel（而非靠 tmux 退出码），据此 + 是否拿到 `pr_url` 分类结果。这样 agent 的「业务成功（建了 PR）」与「进程正常退出」可被独立判别。

### 4. capabilities 驱动的 Prompt 渲染
agent 可用的 actions 由插件 `capabilities()` 自描述，`buildPrompt` 据此动态生成 API 块。新增 action 不需要改 dispatcher 或加路由——**插件自描述能力，核心被动渲染**。所有 agent 信号走同一个 `/actions/:action` 入口，body 统一带 `targetRepo`。

### 5. worktree + tmux 双重隔离
每个 session 一个 git worktree（独立分支，便于 PR + 原地重试）+ 一个 tmux 窗口（隔离进程、可人工 attach 查看）。成功会话默认自动清理 tmux 窗口，失败会话保留以便排查（可配置）。

### 6. 插件单例 + per-project 缓存
loader 按 `projectType` 缓存单例插件。一个插件实例可能服务于多个同类型 project，因此 per-project 元数据必须由插件自己按 `projectId` 缓存，不能放实例字段。加载用 `require()`，故插件禁止 top-level await、需 Node ≥ 22.12。

### 7. 配额探测
核心与派发的 agent 共享同一个 GitHub token（及其 GraphQL 预算）。轮询前插件可选地 `checkQuota()` 探测剩余额度，额度低时保守跳过本次调用，避免硬撞 rate limit。探测失败时回退为「照常轮询」而非阻塞。

### 8. review-fix 是 done 状态上的常驻 worker
`done`（In review）不是被动等待合并的死状态：dispatcher 在慢节奏计数器（`reviewDispatchEvery`，每 N 个派发周期）上扫描所有「有 PR 且看板仍 In review」的 issue，经插件 `listUnresolvedThreads(prUrl)` 探测 GitHub 评审线程，发现未解决线程即派发 review-fix 会话。agent 自驱动「拉线程 → 修复 → 推回原分支 → `resolve-thread` → 复查」循环，直到全解决或 PR 合并。

三个关键约束：

- **不碰看板**：review 会话不发 `transition`、不发完成评论，issue 恒 In review。它与 coding 会话通过 session `type` 区分，在 `checkRunningSessions` 里**先于**按 `pr_url` 分类的成功路径分流（review 也带 `pr_url`，否则会被误判为 coding 成功而推进看板）。
- **失败隐式重试**：review 会话崩溃 / 非零退出不回退看板，下一个节奏点重新探测，未解决线程自然再次触发——所以 review 阶段天然重试，无需像 coding 那样的显式 retry 入口。
- **线程真相源是 GitHub review thread**：触发与终止都以 GitHub 原生 `reviewThreads` 的 `isResolved` 为准（`resolve-thread` action 直接调用 `resolveReviewThread` mutation）。普通 PR 评论不产生 review thread、不触发——文档需据此澄清，避免用户误以为任意评论即可。

## 模块职责（`server/src/`）

| 模块 | 职责 |
|------|------|
| `index.ts` | 入口：加载配置 → 初始化 DB → 起 Fastify → 启动轮询 |
| `config.ts` | 加载 `config.json` + `projects.json`，校验 |
| `db/` | SQLite（WAL）：`issues` + `sessions` 表 |
| `routes/api.ts` | REST API 路由，含统一 `/actions/:action` 入口 |
| `plugins/loader.ts` | 按 `projectType` 解析、实例化、缓存插件单例 |
| `plugins/github/` | 内置 GitHub Projects 插件 |
| `services/poller.ts` | 定时轮询，发现可派发 issue；刷新看板快照 |
| `services/dispatcher.ts` | 核心：并发控制、Prompt 生成、exit code 判定、结果分类、review 派发 |
| `services/tmux.ts` | tmux 会话生命周期管理 |
| `services/worktree.ts` | git worktree 创建 / 清理 |
| `services/boardSnapshot.ts` | 看板内存快照 |
| `services/displayState.ts` | 看板列名 → 标准显示状态派生 |
| `services/logger.ts` | 结构化日志（控制台 + 文件） |

## 数据模型（概览）

- **`issues`**：每个被发现的 issue 一行，键含 `projectId` + `sourceId` + `targetRepo`；记录标准状态等。
- **`sessions`**：每个 agent 会话一行，关联 issue；记录 tmux 会话名、worktree 路径、分支、退出码、`pr_url`、结果状态（`done`/`failed`/`skipped`）、失败原因等。

进行中的 issue 由 sessions 表跟踪，`discover()` 不会重复返回它们。

## 内部 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 系统状态（运行中会话数、projects） |
| GET | `/api/projects` | Projects 列表及其 repos |
| GET | `/api/repos` | 所有 project 仓库的并集 |
| GET | `/api/repos/:name/issues` | 指定仓库的 Issue 列表 |
| GET | `/api/issues` | 所有 Issue（含 sessions） |
| GET | `/api/issues/:id/sessions` | Issue 的会话记录 |
| POST | `/api/projects/:projectId/issues/:sourceId/actions/:action` | **agent 信号统一入口**（`:action` 由插件 capabilities 决定，body 带 `targetRepo`） |
| POST | `/api/sessions/:id/kill` | 终止运行中的会话 |
| POST | `/api/poll` | 手动触发轮询 |
| POST | `/api/webhook` | Webhook 入口（触发一次轮询） |

## 技术栈

- **后端**：Fastify · better-sqlite3 · TypeScript
- **前端**：React · Vite · Tailwind CSS · Lucide Icons
- **基础设施**：tmux · GitHub CLI（Projects）· Claude Code CLI

## 日志

结构化日志输出到控制台（彩色 `[LEVEL] [module] message`）与文件（`~/.talos/logs/talos-loop.log`）。Claude Code 自身的执行记录可通过 `claude -r` 查看。
