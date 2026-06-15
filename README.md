# Talos Loop

Autonomous GitHub Issue processing agent — 监控 GitHub Issues，自动调度 Claude Code 完成编码任务，创建 Pull Request。

## 工作流程

```
Issue (queued)
        │
        ▼
   ┌──────────┐   60s 轮询
   │  Poller   │ ◄── discover()
   └────┬─────┘
        │ 发现新 Issue（带标准状态）
        ▼
   ┌────────────┐  并发控制 (maxParallel)
   │ Dispatcher  │ ── 状态校验 ── 生成 Prompt
   └────┬───────┘
        │
        ▼
   ┌──────────────────────┐
   │ tmux 隔离会话          │
   │ claude -p <prompt>    │ ── worktree 隔离 ── 编码 ── 推送分支 ── 创建 PR
   └────┬─────────────────┘
        │ 完成后解析 PR URL
        ▼
  ┌──────────────────────────────────┐
  │ 成功 → done    + 评论 PR 链接     │
  │ 失败 → failed  + 评论日志摘要     │
  └──────────────────────────────────┘
```

## 前置依赖

| 依赖 | 用途 |
|------|------|
| Node.js 18+ | 运行时 |
| [tmux](https://github.com/tmux/tmux) | 隔离会话管理（启动时检查） |
| [gh](https://cli.github.com/) | GitHub CLI，需已认证且有仓库访问权限 |
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
cp config.example.json config.json   # 运行参数 + sources
cp repos.example.json   repos.json   # 代码仓库（Claude 运行的地方）
```

### `config.json` — 运行参数 + Issue 来源

```jsonc
{
  "sources": [                        // Issue 来源 —— 每个 source 绑定一个 repo
    {
      "type": "github",               // 内置插件 "github"；外部插件填 npm 包名或本地路径
      "enabled": true,
      "repo": "talos-deploy",         // 引用 repos.json 中的 repo（取 path 的 basename）
      "config": {                     // 可选：插件特定覆盖（默认无需配置，见下）
        "repo": "owner/repo",         //   可选：覆盖该 source 的 GitHub owner/repo
        "triggerLabel": "ready-for-agent",
        "processingLabel": "agent-processing",
        "doneLabel": "agent-done",
        "failedLabel": "agent-failed"
      }
    }
  ],
  "port": 3100,                       // 服务监听端口
  "pollInterval": 60000,              // 轮询间隔（毫秒）
  "maxParallel": 1,                   // 最大并发数
  "claudeTimeout": 600                // Claude 会话超时（秒）
}
```

**顶层可选字段**（有默认值，可不配置）：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3100` | 服务监听端口 |
| `pollInterval` | `60000` | 轮询间隔（毫秒） |
| `maxParallel` | `1` | 最大并发处理数 |
| `claudeTimeout` | `600` | Claude 会话超时（秒） |
| `dbPath` | `<root>/server/data/talos-loop.db` | SQLite 数据库路径 |

**`source.config`（GitHub 插件，全部可选）**：默认即可，无需声明。内置四态标签 `ready-for-agent` / `agent-processing` / `agent-done` / `agent-failed` 是默认值；GitHub 的 `owner/repo` 默认取该 source 绑定 repo 的 `remote`。只有想覆盖标签名、或把一个 source 指向另一个 GitHub 仓库时，才需要填写对应字段。

### `repos.json` — 代码仓库

一个数组，每项只需本地路径（`name` 取路径 basename，`remote` 从该路径的 `git remote` 自动推断为 `owner/repo`）：

```jsonc
[
  { "path": "/abs/path/to/local/clone" },
  { "path": "/path/to/other-repo", "remote": "owner/other-repo" }   // remote 可选覆盖
]
```

`source.repo` 用 basename 引用此处的仓库；启动时若引用了未声明的 repo，该 source 会被跳过并告警。

> **迁移（旧版 → 新版）**：把旧的 `config.json` 中 `repos` 数组整体搬到 `repos.json`（每项去掉 `name`，只保留 `path`，`remote` 可选）；把每个 `source.config.repo`（GitHub owner/repo）与 `source.config.targetRepo`（旧字段，已废弃）去掉，改为顶层 `source.repo` = basename；标签字段若与默认值一致可直接删除。数据库无需迁移（`target_repo` 仍存 basename）。

### 插件（Issue Source）

`source.type` 决定使用哪个插件：

- `"github"` —— 内置插件，随 talos-loop 一起发布，开箱即用。
- 其他字符串 —— 按包名/本地路径直接加载（`require(type)`），例如 `"@acme/source-jira"` 或 `"./plugins/my-source"`。

`type`（包名）仅用于加载/注册；每个插件在自身声明 `name`（alias），日志输出和 Dashboard 展示都使用这个 `name`。例如 `@acme/source-jira` 包加载后，日志与界面会显示 `jira`。

插件还负责 Issue 状态的双向翻译——把源机制（GitHub 标签、Jira 状态等）映射到 talos-loop 的四个标准状态（见下文「Issue 状态生命周期」）。核心代码只读 `type`/`enabled`/`repo` 这类基础字段，其余插件配置完全由插件自身解释。

## 运行

### 开发模式

前后端热重载：

```bash
npm run dev
```

也可单独运行：

```bash
npm run dev:server   # 后端 tsx watch
npm run dev:web      # 前端 Vite dev server (端口 5174，代理 API 到 :3100)
```

### 生产模式

```bash
npm run build        # 构建 web (Vite) → server (tsc)
npm start            # 启动服务，监听 0.0.0.0:3100
```

生产模式下，Fastify 同时提供 API 和构建后的 Web Dashboard 静态文件。

## Web Dashboard

浏览器访问 `http://localhost:3100`，可查看：

- 所有仓库的 Issue 列表（按仓库分组）
- 状态标签（排队 / 处理中 / 完成 / 失败）
- PR 链接（成功时显示）
- 手动「立即轮询」按钮
- 失败 Issue 的「重试」按钮
- 每 10 秒自动刷新

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 系统状态（运行中会话数等） |
| GET | `/api/repos` | 仓库列表 |
| GET | `/api/repos/:name/issues` | 指定仓库的 Issue 列表 |
| GET | `/api/issues` | 所有 Issue |
| GET | `/api/issues/:id/sessions` | Issue 的会话记录 |
| POST | `/api/issues/:id/retry` | 重试失败的 Issue |
| POST | `/api/poll` | 手动触发轮询 |
| POST | `/api/webhook` | Webhook 入口 |

## 项目结构

```
talos-loop/
├── config.example.json          # 运行参数 + sources 模板（config.json 不纳入版本控制）
├── repos.example.json           # 代码仓库模板（repos.json 不纳入版本控制）
├── package.json                 # 根 workspace（concurrently）
├── server/
│   ├── package.json
│   └── src/
│       ├── index.ts             # 入口：初始化配置、DB、Fastify，启动轮询
│       ├── config.ts            # 配置加载与校验
│       ├── db/
│       │   └── index.ts         # SQLite（WAL 模式），issues + sessions 表
│       ├── routes/
│       │   └── api.ts           # REST API 路由
│       └── services/
│           ├── poller.ts        # 定期调用 gh issue list 发现 Issue
│           ├── dispatcher.ts    # 核心调度：并发控制、Prompt 生成、PR 检测
│           ├── tmux.ts          # tmux 会话管理（创建/监控/销毁）
│           └── logger.ts        # 结构化日志（控制台 + 文件）
└── web/
    ├── package.json
    └── src/
        ├── App.tsx              # Dashboard 主组件
        ├── main.tsx             # React 入口
        └── index.css            # Tailwind CSS
```

## 技术栈

**后端：** Fastify 5 · better-sqlite3 · TypeScript

**前端：** React 19 · Vite 8 · Tailwind CSS 4 · Lucide Icons

**基础设施：** tmux · GitHub CLI · Claude Code CLI

## Issue 状态生命周期

talos-loop 用四个标准状态驱动整个流程，核心代码只与插件交流这些状态，不依赖任何源特定的标识（如 GitHub 标签名）。每个插件负责在自己的源机制与这四个状态之间双向翻译。

```
queued ──► processing ──┬──► done     (PR 创建成功)
                         └──► failed  (超时或无 PR)
   ▲                        │
   └──────── 重试 ──────────┘
```

- `discover()` 发现 Issue 时即返回其标准状态，Poller 据此分桶（`queued` 待派发、`processing` 进行中）。
- 派发前 Dispatcher 会实时复查 Issue 状态，只对仍处于 `queued` 的 Issue 派发，防止过期数据触发重复处理。
- 状态迁移通过插件的 `transition({ from, to })` 由核心发起、插件执行；`getStatus()` 用于派发前的实时复查，返回 `null` 表示该 Issue 已不在管线任一状态。

对 GitHub 插件，这四个状态默认由 `ready-for-agent` / `agent-processing` / `agent-done` / `agent-failed` 标签承载（无需声明，需要时可在 `source.config` 中按需覆盖，核心不读取）。

## 日志

结构化日志输出到两处：

- **控制台：** 彩色 `[LEVEL] [module] message` 格式
- **文件：** `~/.talos/logs/talos-loop.log`

Claude Code 的执行记录可通过 `claude -r` 查看。

## License

Private
