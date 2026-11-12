# DSH Super Workbench · DeepSeek Harness 智能体工作台

DSH Super Workbench 是一组面向 DeepSeek Harness（DSH）的插件。用任务看板管理项目工作，用 Super Agent 汇总待办和发起委派，通过 Agent Provider 接入外部智能体。定时任务和番茄钟分别服务于自动化安排和个人专注。

[是什么](#是什么) · [功能插件](#功能插件) · [快速上手](#快速上手) · [兼容性与已知限制](#兼容性与已知限制) · [项目来源](#项目来源)

## 是什么

工作台通过 DSH 的 profile 机制装配八个独立插件。任务看板负责记录任务和状态，Super Agent 提供个人面板和协调入口，ACP Adapter 管理外部智能体接入及会话。可以按场景选择插件，涉及定时任务时配套安装 Host 和 UI。

| 使用场景 | 从哪里开始 |
| --- | --- |
| 整理项目任务、查看执行进度 | 打开任务看板 |
| 汇总待办、安排工作或跟进委派 | 打开 Super Agent 个人面板 |
| 接入外部 ACP 智能体 | 在 DSH 设置中配置 Agent Provider |
| 查看或管理定时任务 | 打开自动化任务面板 |
| 开始一段专注时间 | 点击侧栏底部的番茄钟 |

## 功能插件

| 插件 | 包名 | 功能 |
| --- | --- | --- |
| [Super Agent](plugins/dsh-workspace-superagent) | `@local/dsh-workspace-superagent` | 个人待办、工作区概览与委派入口 |
| [任务看板](plugins/dsh-task-board/README.zh.md) | `@linxin666/dsh-client-ui-task-board` | 管理任务、调度与执行记录，内含巡检、森林、GitHub、团队和远程模块 |
| [Agent Provider](plugins/dsh-acp-adapter/README.md) | `@zaimokuza/dsh-acp-adapter` | 外部 ACP 智能体的配置、接入和会话管理 |
| [定时任务 Host](plugins/dsh-quick-actions-schedule-host) | `@local/dsh-quick-actions-schedule-host` | 定时任务的宿主服务 |
| [定时任务 UI](plugins/dsh-quick-actions-schedule-ui) | `@local/dsh-quick-actions-schedule-ui` | 自动化任务面板 |
| [番茄钟](plugins/dsh-pomodoro/README.md) | `@local/dsh-pomodoro-clock` | 专注、休息计时和完成提醒 |
| [工作区上下文](plugins/dsh-workspace-context) | `@local/dsh-workspace-context` | 为工作区、看板和定时任务提供上下文 |
| [受管输入准入](plugins/dsh-input-admission-cap4/README.md) | `@local/dsh-input-admission-cap4` | 为受管会话提供输入提交前的授权检查 |

## 快速上手

### 获取源码与构建

使用 pnpm 10.28.0。ACP Adapter 的开发工具链固定为 Node.js 24.21.0。

```sh
git clone https://github.com/KaisLeungL/dsh-super-workbench.git
cd dsh-super-workbench
pnpm install --frozen-lockfile
pnpm -r --if-present run build
```

### 在 DSH 桌面客户端安装

每个插件保留自己的 `cordis.patch.yml`。进入桌面客户端的插件管理，按包安装本地插件产物，再重启客户端。以下以番茄钟为例，在仓库根目录执行：

```sh
pnpm --filter @local/dsh-pomodoro-clock pack --pack-destination "$PWD"
```

将生成的 `local-dsh-pomodoro-clock-1.1.0.tgz` 作为本地安装包。现有桌面环境升级时，先核对已装版本和本地包路径，尤其是使用定制版看板或 ACP Adapter 的环境。

## 兼容性与已知限制

- 当前依赖基线为 DSH `0.2.2-rc.1`。Super Agent 的受管运行依赖宿主提供 Cap4 输入准入能力。
- 输入准入配置会替换默认 Agent Loop，Quick Actions 的 Host 和 UI 会替换内置定时服务和面板。首次联调宜使用独立 profile。
- Quick Actions Host `0.1.1` 和 UI `0.1.0` 随仓库提供构建产物。两包的上游源码和构建链待补齐。
- 当前按插件包构建和安装。八包在同一桌面 profile 中重启后的联合验收待完成。

## 项目来源

任务看板来自 [dsh-web](https://github.com/zhu1090093659/dsh-web)，本文档参考其[项目介绍与安装指南](https://github.com/zhu1090093659/dsh-web/blob/main/README.md)的组织方式。ACP Adapter 源自 `dsh-agent-manager`，其余插件来自本地 DSH 工作台开发项目及桌面安装产物。各插件的说明和许可信息见对应目录。
