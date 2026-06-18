# Talos Loop

Autonomous GitHub Issue processing agent — 监控 GitHub Projects 看板，自动调度 Claude Code 完成编码任务、提交 Pull Request，并按看板状态推进工作流。

把 **GitHub Projects 看板当作 workflow 引擎**：看板上符合条件的 issue 被自动派发给一个**自包含的 Claude Code skill**，skill 在隔离的 git worktree 中编码、推送分支、提交 PR，看板随之推进到 `In review`。

> 架构设计、三层分层、状态机、模块职责等内部细节见 [CLAUDE.md](./CLAUDE.md)。

---

## 三层架构（issue #32）

talos-loop 拆成清晰三层，职责严格分离：

- **Source plugin**（issue 来源）：只做「发现 issue」+「推进 stage」。接口收敛到 4 个方法（`list` / `writeLabel` + 可选 `getItem` / `writeComment`）。内置 `github` 插件对接 GitHub Projects。
- **Skill**（action 执行）：`github-code` / `github-review` 是独立、完全自包含的 Claude Code skill。server 通过 `/<skill>` 调用后由 skill 自驱完成全部工作（编码、建 PR、修评审线程……），**不依赖任何 server HTTP 回调**——所有上下文从环境变量读取。
- **Server**（纯调度层）：只管 worktree/tmux 会话生命周期、读 sentinel 判定退出码后调用 `writeLabel()` 推进 stage、以及崩溃时 `claude -r` 自动重试。**不再感知 PR/branch/review thread 等业务概念**。

配置里用 **`stages`** 把「stage → skill」映射起来：`{ "ready": "github-code", "in-review": "github-review" }`。

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
    "repos": [                         // 该 project 涉及的代码仓库（skill 运行的地方）
      { "path": "/abs/path/to/local/clone" },
      { "path": "/path/to/other-repo", "remote": "owner/other-repo" }, // remote 可选，缺省从 git remote 推断
      { "path": "/path/to/repo-on-master", "branch": "master" }        // branch 可选，基线分支，缺省 main
    ],
    "stages": {                        // stage → skill 映射（issue #32）
      "ready": "github-code",          //   queued issue → 编码 skill
      "in-review": "github-review"     //   done issue + 未解决评审线程 → 评审 skill
    },
    "config": {}                       // 可选：插件特定配置，由插件自行解释
  }
]
```

- `repos[].name` 取 `path` 的 basename，既作为看板 issue 与本地仓库的映射键（`targetRepo`），也用于 dashboard 分组；**同一 project 内须唯一**。
- `repos[].branch` 为该仓库的**基线分支**（feat 分支从 `origin/<branch>` 切出，也是 PR 的目标分支），缺省 `main`；不同仓库使用 `master`/`develop` 等时需显式声明。
- `stages` 把标准 stage 映射到要调用的 skill；缺省 `{}`（该项目不派发任何 stage）。两个核心 stage：`ready`（queued issue）与 `in-review`（done issue 带未解决评审线程）。
- 看板上的 issue 若其仓库未在 `repos[]` 声明（配置漂移），会被告警并跳过。

**`config.json`**（运行参数，完整字段见模板）：常用项为 `port`、`pollInterval`、`maxParallel`、`claudeTimeout`，以及 `maxRetry`（崩溃的编码会话自动 `claude -r` 重试的次数上限，默认 1）、`keepSessionOnSuccess`（成功会话是否保留 tmux 窗口供排查，默认 false）。

### 2. 为 Issue 设置 `ready-for-agent` 标签

`ready-for-agent` 是**永久资格标记**，由人工在需求就绪阶段设置（例如通过 `/prd` skill 编写完 PRD 后打上），**talos-loop 永不修改**。它作为质量门：只有带此标签的看板 issue 才会被执行。

> **触发条件：看板状态 == Ready + 有 `ready-for-agent` 标签。**

### 3. 状态流转触发规则

```
Ready + ready-for-agent ──派发（调用 ready skill）──► In progress ──skill 正常退出（exit 0）──► In review ──PR 合并──► Done
                                                         │
                                            崩溃 / 非零退出：retry_count < maxRetry
                                            且已捕获 claude 会话 id → 自动 claude -r 重试 ↺
                                            否则 session 标记 failed，看板保持 In progress（人工介入）
```

具体触发规则：

| 时机 | 动作 |
|------|------|
| 进入 `Ready` + 带标签 | 进入派发队列：建 worktree、`writeLabel` 推进到 `In progress`、调用 `ready` skill |
| skill 正常退出（exit 0） | server 读 sentinel 判定成功 → `writeLabel` 推进到 `In review` + 清理 worktree（**PR 由 skill 自行创建，server 不感知**） |
| `In review` + 有未解决评审线程 | 每个轮询周期派发 **review skill**：agent 修复代码、推回原 PR 分支、复查，循环至全部解决；看板不迁移（详见「评审修复循环」） |
| `In review` 的 PR 被合并 | 由 GitHub 自带项目自动化推进到终态 `Done`，talos-loop 不参与 |
| 进程崩溃 / 非零退出 | 在 `maxRetry` 预算内自动 `claude -r` 原地重试；用尽预算则 session 标记 `failed`、issue **留在 In progress** 等待人工介入 |

> ⚠️ 命名陷阱：`In review` 对应核心内部的 `done` 状态（PR 已创建），不是终态 `Done`。

#### 评审修复循环（review-fix）

PR 进入 `In review` 后并非被动等待合并。每个轮询周期，插件在 `list()` 中对 in-review 项探查关联 PR 的评审线程；一旦发现**未解决的评审线程**，就在 issue 上携带一个 `review` subIssue 信号，server 据此派发 review skill 会话：

- agent 拉取 PR 上所有未解决线程 → 逐个修复 → 推送到**原 PR 分支**（不新建分支，保持 PR 历史连续）→ 复查 → 循环至全部解决。
- review 会话**绝不迁移看板**：issue 始终停在 `In review`，直到 PR 合并进 `Done`。同一 issue 同一时刻最多一个 review 会话。
- 失败（崩溃 / 非零退出）不回退看板——下一个周期 `list()` 仍会探出未解决线程，自然重新派发（review 阶段天然重试，不走 `claude -r`）。

> ⚠️ **如何触发评审修复**：触发源是 GitHub 的 **review thread**——即对 PR 代码行的 **inline 评审评论**（在 PR 的 "Files changed" 里点行号 `+` 发起的评论，或带 "Request changes" 的评审）。**PR 底部的普通评论不会创建 review thread，也不会触发 review-fix。**

### 运行与 Dashboard

```bash
npm run dev          # 前后端热重载
# 或
npm run build && npm start   # 生产模式，监听 0.0.0.0:3100
```

浏览器访问 `http://localhost:3100`，可查看所有仓库的 Issue（按仓库分组）、看板状态、每条 issue 的会话历史与状态指示（基础设施失败 / 运行中 / 已完成），以及手动「立即轮询」按钮。失败/被 kill 的会话若已捕获 claude 会话 id，可一键复制 `claude -r` 恢复命令在你的终端里继续。

---

## 生态接入（Source Plugin 契约）

talos-loop 通过 **Source 插件** 与具体 issue 源解耦。核心只与插件交换抽象的标准状态，绝不读取具体源的配置（如看板列名）。`projectType` 决定使用哪个插件：`"github"` 为内置插件，其他字符串按包名 / 本地路径加载（如 `"@acme/source-jira"`）。

### 契约定义

**标准状态**：核心与插件之间只有三个抽象状态，插件在它们与自身机制（看板列、Jira 转换……）之间双向翻译。`queued(Ready)` → `processing(In progress)` → `done(In review)`；`done` 对应 GitHub 的 "In review" 列，不是终态 "Done"。

**`IssueSourcePlugin` 接口**（per-issue 方法都带 `targetRepo`，因为一个 project 可跨多仓库）。**必填**方法：

| 方法 | 职责 |
|------|------|
| `name` | 插件显示名 / 别名（日志、UI 使用） |
| `list(ctx)` | **唯一的看板读**：返回所有 active issue，每个携带标准 `state`（`queued`/`processing`/`done`）+ 可选 `subIssues`（下游注意力信号，如未解决评审线程）；读取失败需**抛错**（不能返回空数组） |
| `writeLabel(ctx, sourceId, {from,to}, targetRepo)` | 按 stage 迁移 issue（核心只发起 `queued→processing` 与 `processing→done`） |

**可选**方法（声明即支持）：

| 方法 | 职责 |
|------|------|
| `getItem?(ctx, sourceId, targetRepo)` | 单个 issue 新鲜度复查（派发前）；不可派发时返回 `{ state: null }` |
| `writeComment?(ctx, sourceId, comment, targetRepo)` | 在 issue 留言（如重试预算耗尽时的告警） |

**`SubIssue` 信号**：`list()` 对 done 项可返回 `{ type: "review", resolved: false }`，server 据此派发 `in-review` stage 的 skill。信号只有 `type` + `resolved`——不带 body/id，skill 自行从平台拉取详情。

完整类型定义见 [`server/src/types/plugin.ts`](./server/src/types/plugin.ts)。

**上下文 `ProjectContext`**：核心注入给每个方法的上下文，含 `config`（该 project 的插件配置）、`logger`、`repos: RepoRef[]`（`{ name, path, remote?, branch? }`，`name` 即 `targetRepo` 键，`branch` 为基线分支）、`projectId`（"owner/number"）。

> **注意**：action 执行（建 PR、留评论、解决评审线程……）不再在插件里，也不通过 server HTTP 回调——全部由**独立的 Claude Code skill** 完成。插件只负责「发现 issue + 推进 stage」这一窄职责。

**编写第三方插件**：`export default` 一个 class（推荐）或现成实例均可，loader 自动识别 class 并实例化；loader 按 `projectType` 缓存单例，per-project 元数据需插件自行按 `projectId` 缓存（惰性解析，接口无 `init`）；需 Node ≥ 22.12 且**禁止 top-level await**（loader 用 `require()` 加载）。

## License

Private
