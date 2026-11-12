# DSH Super Workbench

本仓库统一维护 DSH 工作台的八个插件。每个包保留独立的包名、导出与 `cordis.patch.yml`，可按包构建和安装。

| 目录 | 模块 | 导入来源 |
| --- | --- | --- |
| `plugins/dsh-input-admission-cap4` | 受管输入准入 | dsh-make-it-best |
| `plugins/dsh-task-board` | 任务看板及内置扩展 | dsh-web 的 `packages/dsh-task-board` |
| `plugins/dsh-pomodoro` | 番茄钟 | dsh-make-it-best |
| `plugins/dsh-quick-actions-schedule-host` | 定时任务 Host | 本地桌面安装产物 0.1.1 |
| `plugins/dsh-quick-actions-schedule-ui` | 定时任务 UI | 本地桌面安装产物 0.1.0 |
| `plugins/dsh-workspace-context` | 工作区上下文 | dsh-make-it-best |
| `plugins/dsh-workspace-superagent` | Super Agent | dsh-make-it-best |
| `plugins/dsh-acp-adapter` | Agent Provider | dsh-agent-manager |

Quick Actions 两包保留已构建的 `lib/`。Host 采用已有的 Zod 兼容版本。两包的上游源码与构建链尚待补齐。

## 本地开发

使用 pnpm 10.28.0。ACP Adapter 的开发工具链固定在 Node.js 24.21.0。

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present run build
```

任务看板使用根目录 `shared/` 中的客户端构建配置。ACP 的宿主端到端测试可通过 `DSH_UPSTREAM_CHECKOUT` 指向外部宿主检出。

## DSH 安装

按各包的 Cordis 配置安装到目标 profile，先验证输入准入与宿主版本匹配。输入准入会替换原 Agent Loop，定时 Host 和 UI 会替换内置定时服务与面板，联调应使用独立 profile。现有桌面 profile、凭据、看板账本和 SQLite 数据均留在原位置。
