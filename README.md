# Talos Loop

Autonomous GitHub Issue processing agent — 监控 GitHub Projects 看板，自动调度 Claude Code 完成编码任务、创建 Pull Request，并按看板状态推进工作流。

把 **GitHub Projects 看板当作 workflow 引擎**：看板上处于 `Ready` 且带 `ready-for-agent` 资格标签的 issue 会被自动派发给 Claude Code，agent 在隔离的 git worktree 中编码、推送分支、提交 PR，看板随之推进到 `In review`。

> 架构设计、状态机、模块职责等内部细节见 [CLAUDE.md](./CLAUDE.md)。

---

## Quick Start

### 前置依赖

| 依赖 | 用途 |
|------|------|
| Node.js 18+ | 运行时 |
| [tmux](https://github.com/tmux/tmux) | 隔离 agent 会话（启动时检查） |
| [gh](https://cli.github.com/) | GitHub CLI，需已认证；token 需含 `project` scope（`gh auth refresh -s project`） |
| [claude](https://claude.ai/code) | Claude Code CLI，需在 PATH 中 |
| git | agent 在 worktree 中执行版本操作 |

### 安装

```bash
git clone <repo-url> && cd talos-loop
npm install
```

### 配置

两个配置文件都不纳入版本控制，仓库各提供一份 `*.example.json` 模板：

```bash
cp config.example.json    config.json     # 运行参数
cp projects.example.json  projects.json   # Projects + 仓库
```

**`config.json` — 运行参数**（完整字段见模板，常用项：`port`、`pollInterval`、`maxParallel`、`claudeTimeout`、`serverBaseUrl`）：

```jsonc
{
  "port": 3100,
  "pollInterval": 60000,
  "maxParallel": 1,
  "claudeTimeout": 600,
  "serverBaseUrl": "http://127.0.0.1:3100"  // agent 回调本地 actions 接口的基址
}
```

**`projects.json` — Projects 与仓库**：一个数组，每项是一个 Project（可跨多个仓库）：

```jsonc
[
  {
    "projectId": "owner/1",            // "owner/number"，与 GitHub URL 一致
    "projectType": "github",           // 内置插件 "github"，或外部插件包名/本地路径
    "enabled": true,
    "repos": [                         // 该 project 涉及的代码仓库（Claude 运行的地方）
      { "path": "/abs/path/to/local/clone" },
      { "path": "/path/to/other-repo", "remote": "owner/other-repo" }  // remote 可选，缺省从 git remote 推断
    ],
    "config": {}                       // 可选：插件特定配置，由插件自身解释
  }
]
```

`repos[].name` 取 `path` 的 basename，既作为看板 issue 与本地仓库的映射键（`targetRepo`），也用于 dashboard 分组；同一 project 内须唯一。

### 运行

```bash
npm run dev          # 前后端热重载
# 或
npm run build && npm start   # 生产模式，监听 0.0.0.0:3100
```

### Web Dashboard

浏览器访问 `http://localhost:3100`，可查看所有仓库的 Issue（按仓库分组）、看板状态、每条 issue 最新会话的结果指示（基础设施失败 / agent 跳过）、PR 链接，以及手动「立即轮询」按钮。

> 触发条件：**看板状态 == Ready + 有 `ready-for-agent` 标签 + 无 `skipped` 标签**。`ready-for-agent` 是人工设置的质量门（talos-loop 永不修改）；`skipped` 由 agent 主动放弃任务时打上，移除前不再触发。

---

## 生态接入（Plugin Contract）

talos-loop 通过 **Issue Source 插件** 与具体 issue 源解耦。核心只与插件交换抽象的标准状态，绝不读取具体源的配置（如看板列名）。`projectType` 决定使用哪个插件：

- `"github"` —— 内置插件，开箱即用。
- 其他字符串 —— 按包名 / 本地路径加载（`require(type)`），例如 `"@acme/source-jira"`。

### 标准状态契约

核心与插件之间只通过三个抽象状态交流，插件负责在它们与自身机制（GitHub 看板列、Jira 转换……）之间双向翻译：

```
queued(Ready) ──► processing(In progress) ──► done(In review)
```

> ⚠️ 命名陷阱：`done` 对应 GitHub 的 **"In review"** 列（PR 已创建），不是终态 "Done"。终态由 GitHub 自带的 PR 合并自动化推进，talos-loop 不参与。

### `IssueSourcePlugin` 接口

插件需实现以下接口（per-issue 方法都带 `targetRepo`，因为一个 project 可跨多仓库）。**必填**方法：

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
| `submitPr?(ctx, sourceId, branch, targetRepo)` | 创建 PR 并返回其 URL（单一职责，不做看板/DB 副作用） |
| `onComment?(ctx, sourceId, comment, targetRepo)` | 在 issue 留言 |
| `listUnresolvedThreads?` / `resolveThread?` | 枚举 / 解决 PR 评审线程（驱动 review-fix 流程） |
| `checkQuota?(ctx)` | 探测限流配额（如 GraphQL 预算），供轮询方保守跳过 |

完整类型定义见 [`server/src/types/plugin.ts`](./server/src/types/plugin.ts)。

### 上下文 `ProjectContext`

核心注入给每个插件方法的上下文：

```ts
interface ProjectContext {
  config: Record<string, unknown>;  // 来自 projects.json 该 project 的 config（插件自行解释）
  logger: Logger;
  repos: RepoRef[];                 // { name, path, remote? }，name 即 targetRepo 键
  projectId: string;                // "owner/number"，用于查询看板、键控 per-project 缓存
}
```

### Actions 与能力声明

agent 对外的一切信号（提交 PR、留言、跳过……）统一走一个入口：

```
POST /api/projects/:projectId/issues/:sourceId/actions/:action
```

`:action` 的取值与参数由插件的 `capabilities()` 自描述，`buildPrompt` 据此动态渲染 agent 可用的 API 块——**新增 action 无需改动 dispatcher 或新增路由**，只需：① 插件在 `capabilities()` 声明；② 插件实现对应方法；③ （非标准 action）路由里的 `switch` 增加一个 case。

内置 github 插件声明的 actions：`submit-pr`（params: `branch`）、`comment`（`message`）、`skip`（`reason`）、`resolve-thread`（`threadId`, `prUrl`）。请求 body 始终携带共享的 `targetRepo`。

### 编写第三方插件

- **导出形态**：`export default` 一个 class（推荐，与内置 github 插件一致）或一个现成实例均可——loader 会自动识别 class 并实例化。
- **单例**：loader 按 `projectType` 缓存单例；若服务于多个同类型 project，需在实例内按 `projectId` 缓存 per-project 元数据。
- **运行时**：需 Node ≥ 22.12，且插件**不能含 top-level await**——loader 用 `require()` 加载。

## License

Private
