# Talos Loop

Autonomous GitHub Issue processing agent — 监控 GitHub Projects 看板，自动调度 Claude Code 完成编码任务，创建 Pull Request，并按看板状态推进工作流。

## 工作流程

以 **GitHub Projects** 作为 workflow 引擎。单个 Project 跨多个仓库，talos-loop 轮询看板上处于 `Ready` 且带 `ready-for-agent` 资格标签（且无 `skipped` 标签）的 issue，派发 agent，并推进看板状态：

```
Ready(queued) ──派发──► In progress(processing) ──┬──PR 创建──► In review(done) ──PR 合并──► Done
                                                    │
                                              无 PR/异常退出
                                                    │
                                              回到 Ready（基础设施失败，下次自动重试，错误仅记在 dashboard）

agent 主动放弃（skip API）──► 加 skipped 标签 + 评论 + 回 Ready（block，直到手动移除标签）
```

```
Issue (Ready + ready-for-agent)
        │
        ▼
   ┌──────────┐   60s 轮询
   │  Poller   │ ◄── gh project item-list --query "label:ready-for-agent -label:skipped"
   └────┬─────┘
        │ 发现可派发 Issue
        ▼
   ┌────────────┐  并发控制 (maxParallel)
   │ Dispatcher │ ── 状态校验 ── 生成 Prompt（注入 skip/comment 接口）
   └────┬───────┘
        │
        ▼
   ┌──────────────────────┐
   │ tmux 隔离会话         │
   │ claude -p <prompt>    │ ── worktree 隔离 ── 编码 ── 推送分支 ── 创建 PR
   └────┬─────────────────┘
        │ 会话结束后解析结果
        ▼
  ┌─────────────────────────────────────┐
  │ PR 命中 → In review + 评论 PR 链接   │
  │ 否则   → 回 Ready（infra 失败，静默） │
  │ skip API → plugin 已处理（标签+评论） │
  └─────────────────────────────────────┘
```

## 前置依赖

| 依赖 | 用途 |
|------|------|
| Node.js 18+ | 运行时 |
| [tmux](https://github.com/tmux/tmux) | 隔离会话管理（启动时检查） |
| [gh](https://cli.github.com/) | GitHub CLI，需已认证；token 需含 `project` scope（`gh auth refresh -s project`） |
| [claude](https://claude.ai/code) | Claude Code CLI，需在 PATH 中 |
| git | Claude 在 worktree 中执行版本操作 |

## 安装

```bash
git clone <repo-url> && cd talos-loop
npm install
```

## 配置

配置拆成两个文件，都不纳入版本控制（含本地路径等环境相关信息），仓库各提供一份 `*.example.json` 模板：

```bash
cp config.example.json    config.json     # 运行参数
cp projects.example.json  projects.json   # Projects + 仓库（取代旧版 repos.json + config.sources）
```

### `config.json` — 运行参数

```jsonc
{
  "port": 3100,                       // 服务监听端口
  "pollInterval": 60000,              // 轮询间隔（毫秒）
  "maxParallel": 1,                   // 最大并发数
  "claudeTimeout": 600,               // Claude 会话超时（秒）
  "serverBaseUrl": "http://127.0.0.1:3100"  // agent 回调 talos-loop 本地 API 的基址（skip/comment 接口）
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3100` | 服务监听端口 |
| `pollInterval` | `60000` | 轮询间隔（毫秒） |
| `maxParallel` | `1` | 最大并发处理数 |
| `claudeTimeout` | `600` | Claude 会话超时（秒） |
| `serverBaseUrl` | `http://127.0.0.1:${port}` | agent 调用 skip/comment 接口的基址 |
| `dbPath` | `<root>/server/data/talos-loop.db` | SQLite 数据库路径 |

### `projects.json` — Projects 与仓库

一个数组，每项是一个 Project（可跨多个仓库）：

```jsonc
[
  {
    "projectId": "qiaolei1973/1",        // "owner/number"，人类可读，与 GitHub URL 一致
    "projectType": "github",              // 内置插件 "github"；外部插件填 npm 包名或本地路径
    "enabled": true,
    "repos": [                            // 该 project 涉及的代码仓库（Claude 运行的地方）
      { "path": "/abs/path/to/local/clone" },
      { "path": "/path/to/other-repo", "remote": "owner/other-repo" }   // remote 可选，缺省从 git remote 推断
    ],
    "config": {}                          // 可选：插件特定覆盖（见下）
  }
]
```

- `repos[].name` 取 `path` 的 basename，既作为看板 issue 与本地仓库的映射键（`target_repo`），也用于 dashboard 分组。
- 同一 project 内 basename 须唯一，否则告警。
- 看板上的 issue 若其仓库未在 `repos[]` 声明（配置漂移），talos-loop 会记录告警并在该 issue 留一条一次性评论。

### `ready-for-agent` 与 `skipped` 标签

- `ready-for-agent` 是**永久资格标记**，在 PRD 编写阶段（如 `/prd` skill）设置，talos-loop 永不修改。它作为质量门：只有带此标签的看板 issue 才会被执行。
- `skipped` 标签由 talos-loop 的 `init()` 创建（颜色 `BFD4F2`），用于 agent 主动放弃某任务时持久化标记。
- 三段式触发条件：**看板状态 == Ready + 有 `ready-for-agent` + 无 `skipped`**。`skipped` 的 issue 会被排除出触发条件，直到手动移除标签。

### 插件（Issue Source）

`projectType` 决定使用哪个插件：

- `"github"` —— 内置插件，随 talos-loop 一起发布，开箱即用。
- 其他字符串 —— 按包名/本地路径直接加载（`require(type)`），例如 `"@acme/source-jira"`。

插件负责把 GitHub Projects 看板状态与 talos-loop 的标准状态双向翻译（见下文「Issue 状态生命周期」）。核心代码只读 `projectType`/`enabled`/`projectId` 这类基础字段，其余插件配置完全由插件自身解释。

插件接口（`IssueSourcePlugin`）的 per-issue 方法都带 `targetRepo` 参数（一个 project 可跨多仓库）：

```ts
getStatus(ctx, sourceId, targetRepo)
transition(ctx, sourceId, transition, targetRepo)
onComment?(ctx, sourceId, comment, targetRepo)
skip(ctx, sourceId, targetRepo, reason)   // 新增：加 skipped 标签 + 评论 + 回 Ready
```

`ProjectContext` 暴露 `repos: RepoRef[]`（多仓库）与 `projectId`（"owner/number"）。

**编写/发布第三方插件时的约束：**

- **导出形态**：`export default` 一个 class（推荐，与内置 github 插件一致）或一个现成实例均可——loader 会自动识别 class 并实例化。
- **单例**：loader 按 `projectType` 缓存单例；若服务于多个同类型 project，需在实例内按 `projectId` 缓存 per-project 元数据。
- **运行时**：需 Node ≥ 22.12，且插件**不能含 top-level await**——loader 用 `require()` 加载。

## 运行

### 开发模式

```bash
npm run dev          # 前后端热重载
npm run dev:server   # 后端 tsx watch
npm run dev:web      # 前端 Vite dev server（端口 5174，代理 API 到 :3100）
```

### 生产模式

```bash
npm run build        # 构建 web (Vite) → server (tsc)
npm start            # 启动服务，监听 0.0.0.0:3100
```

## Web Dashboard

浏览器访问 `http://localhost:3100`，可查看：

- 所有仓库的 Issue 列表（按 `target_repo` 分组）
- 看板状态标签（Ready / In progress / In review）
- 每条 issue 最新会话的结果指示：基础设施失败（infra error，红）或 agent 跳过（skipped，紫）
- PR 链接（成功时显示）
- 手动「立即轮询」按钮
- 每 10 秒自动刷新

> 基础设施失败（LLM token 耗尽、网络错误）会静默把 issue 退回 `Ready` 并在下次轮询自动重试，错误只在本 dashboard 可见（不发 issue 评论）。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 系统状态（运行中会话数、projects） |
| GET | `/api/projects` | Projects 列表及其 repos |
| GET | `/api/repos` | 所有 project 仓库的并集 |
| GET | `/api/repos/:name/issues` | 指定仓库的 Issue 列表 |
| GET | `/api/issues` | 所有 Issue（含 sessions） |
| GET | `/api/issues/:id/sessions` | Issue 的会话记录 |
| POST | `/api/projects/:projectId/issues/:sourceId/skip` | agent 信号：放弃任务（写 skipped 标签 + 评论 + 回 Ready） |
| POST | `/api/projects/:projectId/issues/:sourceId/comment` | agent 信号：在 issue 留言 |
| POST | `/api/poll` | 手动触发轮询 |
| POST | `/api/webhook` | Webhook 入口（触发一次轮询） |

## 项目结构

```
talos-loop/
├── config.example.json          # 运行参数模板（config.json 不纳入版本控制）
├── projects.example.json        # Projects + 仓库模板（projects.json 不纳入版本控制）
├── package.json                 # 根 workspace（concurrently）
├── server/
│   ├── package.json
│   └── src/
│       ├── index.ts             # 入口：初始化配置、DB、Fastify，启动轮询
│       ├── config.ts            # 配置加载（config.json + projects.json）
│       ├── db/
│       │   └── index.ts         # SQLite（WAL），issues + sessions 表
│       ├── routes/
│       │   └── api.ts           # REST API 路由（含 skip/comment）
│       ├── plugins/
│       │   ├── loader.ts        # 插件按 type 解析与缓存
│       │   └── github/          # 内置 GitHub Projects 插件
│       └── services/
│           ├── poller.ts        # 轮询 gh project item-list 发现 Ready issue
│           ├── dispatcher.ts    # 核心调度：并发控制、Prompt 生成、结果分类
│           ├── tmux.ts          # tmux 会话管理
│           └── logger.ts        # 结构化日志（控制台 + 文件）
└── web/
    └── src/App.tsx              # Dashboard 主组件
```

## 技术栈

**后端：** Fastify 5 · better-sqlite3 · TypeScript

**前端：** React 19 · Vite 8 · Tailwind CSS 4 · Lucide Icons

**基础设施：** tmux · GitHub CLI（Projects）· Claude Code CLI

## Issue 状态生命周期

talos-loop 用三个标准状态驱动流程，核心代码只与插件交流这些状态：

```
queued(Ready) ──► processing(In progress) ──► done(In review)
   ▲                       │
   └── infra 失败回退 ─────┘
```

- `discover()` 返回的 issue 携带其标准状态（恒为 `queued`，即看板 Ready）。进行中的 issue 由 sessions 表跟踪，不再被重新发现。
- 派发前 Dispatcher 会实时复查 `getStatus()`，只对仍可派发的 issue 派发。
- 状态迁移通过插件的 `transition({ from, to })` 由核心发起、插件执行（调用 `gh project item-edit`）。
- `done`（In review）之后，PR 合并由 **GitHub 自带的项目自动化**推进到终态 `Done`，talos-loop 不参与。
- 基础设施失败与 agent skip 都把状态退回 `queued`（Ready）：前者静默自动重试，后者附加 `skipped` 标签以阻止再次触发，直到人工移除标签。

## 日志

结构化日志输出到两处：

- **控制台：** 彩色 `[LEVEL] [module] message` 格式
- **文件：** `~/.talos/logs/talos-loop.log`

Claude Code 的执行记录可通过 `claude -r` 查看。

## License

Private
