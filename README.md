# Talos Loop

Autonomous GitHub Issue processing agent — 监控 GitHub Issues，自动调度 Claude Code 完成编码任务，创建 Pull Request。

## 工作流程

```
GitHub Issue (ready-for-agent)
        │
        ▼
   ┌──────────┐   60s 轮询
   │  Poller   │ ◄── gh issue list
   └────┬─────┘
        │ 发现新 Issue
        ▼
   ┌────────────┐  并发控制 (maxParallel)
   │ Dispatcher  │ ── 标签验证 ── 生成 Prompt
   └────┬───────┘
        │
        ▼
   ┌──────────────────────┐
   │ tmux 隔离会话          │
   │ claude -p <prompt>    │ ── worktree 隔离 ── 编码 ── 推送分支 ── 创建 PR
   └────┬─────────────────┘
        │ 完成后解析 PR URL
        ▼
  ┌───────────────────────────────────┐
  │ 成功 → agent-done  + 评论 PR 链接  │
  │ 失败 → agent-failed + 评论日志摘要 │
  └───────────────────────────────────┘
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

编辑项目根目录的 `config.json`：

```jsonc
{
  "port": 3100,                    // 服务监听端口
  "pollInterval": 60000,           // 轮询间隔（毫秒）
  "triggerLabel": "ready-for-agent",    // 触发处理的标签
  "processingLabel": "agent-processing", // 处理中标签
  "doneLabel": "agent-done",             // 完成标签
  "failedLabel": "agent-failed",         // 失败标签
  "maxParallel": 1,                // 最大并发数
  "claudeTimeout": 600,            // Claude 会话超时（秒）
  "repos": [
    {
      "name": "my-project",
      "github": "owner/repo",
      "path": "/absolute/path/to/local/clone",
      "enabled": true
    }
  ]
}
```

**可选字段**（有默认值，可不配置）：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `processingLabel` | `agent-processing` | 处理中自动添加的标签 |
| `doneLabel` | `agent-done` | 成功后添加的标签 |
| `failedLabel` | `agent-failed` | 失败后添加的标签 |
| `dbPath` | `<root>/server/data/talos-loop.db` | SQLite 数据库路径 |

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
├── config.json                  # 运行时配置
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

## 标签生命周期

```
ready-for-agent ──► agent-processing ──┬──► agent-done     (PR 创建成功)
                                        └──► agent-failed  (超时或无 PR)
```

Dispatcher 在调度前会实时验证 GitHub 标签，防止过期数据触发重复处理。

## 日志

结构化日志输出到两处：

- **控制台：** 彩色 `[LEVEL] [module] message` 格式
- **文件：** `~/.talos/logs/talos-loop.log`

Claude Code 的执行记录可通过 `claude -r` 查看。

## License

Private
