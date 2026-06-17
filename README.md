# Talos Loop

Autonomous GitHub Issue processing agent — 监控 GitHub Projects 看板，自动调度 Claude Code 完成编码任务、创建 Pull Request，并按看板状态推进工作流。

把 **GitHub Projects 看板当作 workflow 引擎**：看板上符合条件的 issue 被自动派发给 Claude Code，agent 在隔离的 git worktree 中编码、推送分支、提交 PR，看板随之推进到 `In review`。

> 架构设计、状态机、模块职责等内部细节见 [CLAUDE.md](./CLAUDE.md)。

---

## GitHub 场景使用

### 前置依赖

| 依赖 | 用途 |
|------|------|
| Node.js 18+ | 运行时 |
| [tmux](https://github.com/tmux/tmux) | 隔离 agent 会话（启动时检查） |
| [gh](https://cli.github.com/) | GitHub CLI，需已认证；token 需含 `project` scope（`gh auth refresh -s project`） |
| [claude](https://claude.ai/code) | Claude Code CLI，需在 PATH 中 |
| git | agent 在 worktree 中执行版本操作 |

```bash
git clone <repo-url> && cd talos-loop
npm install
```

### 1. 配置 Project 与 Repo

两个配置文件都不纳入版本控制，仓库各提供一份模板：

```bash
cp config.example.json    config.json     # 运行参数
cp projects.example.json  projects.json   # Projects + 仓库
```

**`projects.json`** 是 GitHub 接入的核心：一个数组，每项是一个 Project（可跨多个仓库）：

```jsonc
[
  {
    "projectId": "owner/1",            // "owner/number"，与 GitHub Projects URL 一致
    "projectType": "github",           // 内置插件 "github"，或外部插件包名/本地路径
    "enabled": true,
    "repos": [                         // 该 project 涉及的代码仓库（Claude 运行的地方）
      { "path": "/abs/path/to/local/clone" },
      { "path": "/path/to/other-repo", "remote": "owner/other-repo" }, // remote 可选，缺省从 git remote 推断
      { "path": "/path/to/repo-on-master", "branch": "master" }        // branch 可选，基线分支，缺省 main
    ],
    "config": {}                       // 可选：插件特定配置，由插件自行解释
  }
]
```

- `repos[].name` 取 `path` 的 basename，既作为看板 issue 与本地仓库的映射键（`targetRepo`），也用于 dashboard 分组；**同一 project 内须唯一**。
- `repos[].branch` 为该仓库的**基线分支**（feat 分支从 `origin/<branch>` 切出，也是 PR 的目标分支），缺省 `main`；不同仓库使用 `master`/`develop` 等时需显式声明，否则 PR 可能创建失败。
- 看板上的 issue 若其仓库未在 `repos[]` 声明（配置漂移），会被告警并跳过。

**`config.json`**（运行参数，完整字段见模板）：常用项为 `port`、`pollInterval`、`maxParallel`、`claudeTimeout`，以及 `serverBaseUrl`（agent 回调本地 actions 接口的基址，默认 `http://127.0.0.1:${port}`）。

### 2. 为 Issue 设置 `ready-for-agent` 标签

`ready-for-agent` 是**永久资格标记**，由人工在需求就绪阶段设置（例如通过 `/prd` skill 编写完 PRD 后打上），**talos-loop 永不修改**。它作为质量门：只有带此标签的看板 issue 才会被执行。

`skipped` 标签由 talos-loop 在 agent 主动放弃任务时打上，移除前该 issue 不再触发。

> **触发条件：看板状态 == Ready + 有 `ready-for-agent` 标签 + 无 `skipped` 标签。**

### 3. 状态流转触发规则

```
Ready + ready-for-agent ──派发──► In progress ──提交 PR──► In review ──PR 合并──► Done
                                    │
                       exit 0 无 PR / 异常退出
                                    │
                       session 标记 done/failed，看板保持 In progress（人工介入 / 重试）

                 skip action ──► 加 skipped 标签 + 回 Ready（移除标签前不再触发）
```

具体触发规则：

| 时机 | 动作 |
|------|------|
| 进入 `Ready` + 带标签 | 进入派发队列，agent 开始时在 issue 评论 `🤖 Agent has started...` |
| agent 提交 PR（exit 0 + pr_url） | 推进到 `In review`，在 issue 评论 `✅ Agent completed. PR: <url>` |
| `In review` 后 | PR 合并由 GitHub 自带项目自动化推进到终态 `Done`，talos-loop 不参与 |
| agent 主动 `skip` | 打 `skipped` 标签 + 评论原因 + 回 `Ready` |
| 进程崩溃 / 非零退出 | session 标记 `failed`，issue **留在 In progress** 等待人工介入（不自动回退、不自动重试） |

> ⚠️ 命名陷阱：`In review` 对应核心内部的 `done` 状态（PR 已创建），不是终态 `Done`。

### 运行与 Dashboard

```bash
npm run dev          # 前后端热重载
# 或
npm run build && npm start   # 生产模式，监听 0.0.0.0:3100
```

浏览器访问 `http://localhost:3100`，可查看所有仓库的 Issue（按仓库分组）、看板状态、每条 issue 最新会话的结果指示（基础设施失败 / agent 跳过）、PR 链接，以及手动「立即轮询」按钮。

---

## 生态接入（Plugin 契约）

talos-loop 通过 **Issue Source 插件** 与具体 issue 源解耦。核心只与插件交换抽象的标准状态，绝不读取具体源的配置（如看板列名）。`projectType` 决定使用哪个插件：`"github"` 为内置插件，其他字符串按包名 / 本地路径加载（如 `"@acme/source-jira"`）。

### 契约定义

**标准状态**：核心与插件之间只有三个抽象状态，插件在它们与自身机制（看板列、Jira 转换……）之间双向翻译。`queued(Ready)` → `processing(In progress)` → `done(In review)`；`done` 对应 GitHub 的 "In review" 列，不是终态 "Done"。

**`IssueSourcePlugin` 接口**（per-issue 方法都带 `targetRepo`，因为一个 project 可跨多仓库）。**必填**方法：

| 方法 | 职责 |
|------|------|
| `name` | 插件显示名 / 别名（日志、UI 使用） |
| `init(ctx)` | 初始化（如创建 `skipped` 标签、缓存 per-project 元数据） |
| `discover(ctx)` | 返回可派发的 issue（每个携带标准 `state`，恒为 `queued`） |
| `listBoard(ctx)` | 列出看板上全部 item（含列名），用于 dashboard 展示；读取失败需抛错 |
| `getStatus(ctx, sourceId, targetRepo)` | 单个 issue 当前状态（派发前新鲜度复查）；不可派发时返回 `null` |
| `transition(ctx, sourceId, {from,to}, targetRepo)` | 按状态机迁移 issue（核心只发起合法迁移） |
| `test(ctx)` | 连通性自检 |
| `skip(ctx, sourceId, targetRepo, reason)` | agent 主动放弃：打 skip 标记 + 评论 + 回 `queued`（阻止再次触发） |

**可选**方法（声明即支持）：

| 方法 | 职责 |
|------|------|
| `capabilities?()` | 自描述暴露给 agent 的 actions，驱动 Prompt 渲染（见下） |
| `submitPr?(ctx, sourceId, branch, targetRepo)` | 创建 PR 并返回其 URL（单一职责，不做看板 / DB 副作用） |
| `onComment?(ctx, sourceId, comment, targetRepo)` | 在 issue 留言 |
| `listUnresolvedThreads?` / `resolveThread?` | 枚举 / 解决 PR 评审线程（驱动 review-fix 流程） |
| `checkQuota?(ctx)` | 探测限流配额（如 GraphQL 预算），供轮询方保守跳过 |

完整类型定义见 [`server/src/types/plugin.ts`](./server/src/types/plugin.ts)。

**上下文 `ProjectContext`**：核心注入给每个方法的上下文，含 `config`（该 project 的插件配置）、`logger`、`repos: RepoRef[]`（`{ name, path, remote?, branch? }`，`name` 即 `targetRepo` 键，`branch` 为基线分支）、`projectId`（"owner/number"）。

**Actions 入口**：agent 的一切信号统一走 `POST /api/projects/:projectId/issues/:sourceId/actions/:action`（body 带 `targetRepo`）。`:action` 与参数由插件 `capabilities()` 自描述，`buildPrompt` 据此动态渲染 agent 可用的 API 块——**新增 action 无需改 dispatcher 或加路由**，只需插件声明 `capabilities()` + 实现对应方法。

**编写第三方插件**：`export default` 一个 class（推荐）或现成实例均可，loader 自动识别 class 并实例化；loader 按 `projectType` 缓存单例，per-project 元数据需插件自行按 `projectId` 缓存；需 Node ≥ 22.12 且**禁止 top-level await**（loader 用 `require()` 加载）。

## License

Private
