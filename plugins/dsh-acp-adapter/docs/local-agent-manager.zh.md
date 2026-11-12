# Agent Provider 插件：本地实施版

本地版本：`0.2.2-rc.1-local.5`。宿主版本：DeepSeek Harness `0.2.2-rc.1`。

基于 [dsh-acp-adapter](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter) 的 MIT 源码扩展，基线 commit 为 `28ccc67`。保留原作者版权、原包名和许可；没有向 npm 或 GitHub 发布。

## 实现范围

- 手动使用：配置多个 ACP Agent，通过 DSH 原生模型选择器选择 Agent 和模型，分别保留会话历史。
- 统一分工：启用原生 Agent Teams 后，主 Agent 可以查询已配置的 Agent，再显式指定另一个 Agent 创建持续工作的团队成员。
- 原生团队管理：成员状态、消息、任务板、审批和取消沿用 DSH；插件补充不同 ACP Agent 的路由与成员模型选择。
- 新建成员使用独立上下文，和主会话共享项目目录。派单时需要明确文件责任范围。
- 会话总览：“设置 → Agent Provider”入口显示当前工作区的 ACP 会话列表，支持检索、实时消息和活动详情。首版支持 Codex、Claude 及其他已配置的 ACP Agent；展示协议上报的信息。

## Agent 工作台

从“设置 → Agent Provider”打开，默认展示接入管理，搜索与实例列表下方显示配置详情。切换到会话总览后可选择工作区，并通过列表和详情检索会话。工作台读取当前工作区最近 100 个会话的元数据，并额外包含所有正在运行的会话；不扫描其他工作区、不迁移历史、不为展示启动新的 Agent。

会话详情展示实际消息、工具活动、运行状态与最近一轮耗时。可展开活动读取输出及文件修改前后内容。“跟随最新”可以关闭，方便停留查看历史。详情最多展示最近 60 条消息与活动，ACP 活动覆盖已加载的最近三个轮次；完整记录、继续对话和审批使用“打开会话”返回原生界面。成员会话使用 DSH 原生侧栏。

切换所选会话或退出工作台会释放旧会话的读取引用，任务仍由 DSH 管理，不会被停止。此功能呈现结构化消息和活动，不镜像 CLI 的原生 TUI，也不推测 Agent 没有上报的执行细节。

设计约定：保留 DSH 原生导航、审批和主题；管理页不显示聊天输入框，继续对话和审批返回原生会话。总览复用宿主增量投影中的摘要，不把空闲当作任务成功；最近检查时间使用 probe.at，不展示虚构进度。沿用宿主字体、颜色和边框令牌，窄屏改为纵向排列列表与详情。

这是 ACP Agent 接入和原生团队能力的扩展。iDev 当前未提供已验证可用的 ACP 入口，且其内网认证链路尚未打通，因此本版没有宣称支持 iDev。

## 会话诊断

从“设置 → Agent Provider → 会话总览”选中会话，在右侧点击“ACP 诊断”。异常、操作记录、技术记录、搜索、记录详情与安全摘要导出沿用原有诊断数据；点击“返回活动详情”回到消息和工具活动。切换会话时关闭旧会话的诊断，避免混淆记录归属。聊天顶部不再显示“ACP 诊断”Tab。

## 安装

先完成当前 DSH 任务并完全退出桌面应用，再执行安装；重新打开后在插件页确认启用。安装命令只安装插件，不会安装或登录 Agent CLI。

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add \
  "/Users/kaisleung/EnginProjects/AI Coding/dsh-agent-manager/.local/diagnostics-relocation/zaimokuza-dsh-acp-adapter-0.2.2-rc.1-local.4.tgz"
```

本地验证使用独立 DSH profile，不会自动更改 `~/.dsh` 的现有配置。

## 连接 Codex 与 Claude Code

在插件设置中添加 Agent，命令尽量填写绝对路径，避免桌面应用的 PATH 与终端不同。Agent 的登录仍由各自 CLI 管理，插件不复制登录凭据。

此次验证的本地 ACP 可执行文件：

| Agent ID | 命令 | ACP 适配器版本 |
| --- | --- | --- |
| `codex` | `/Users/kaisleung/EnginProjects/AI Coding/dsh-agent-manager/.local/agent-runtimes/node_modules/.bin/codex-acp` | `2.5.0` |
| `claude` | `/Users/kaisleung/EnginProjects/AI Coding/dsh-agent-manager/.local/agent-runtimes/node_modules/.bin/claude-agent-acp` | `0.101.0` |

这两个路径属于本地开发环境。若移动或删除项目，需另行安装 ACP 适配器并更新命令。
本地 ACP 命令目录已连接到项目自带的 Node 24.21.0，避免桌面应用缺少终端 PATH 时无法找到 Node。

本机 Claude Code 使用现有团队网关。直接使用 `haiku` 会被网关拒绝；本次在该 Agent 的环境变量中设置：

```text
ANTHROPIC_DEFAULT_HAIKU_MODEL=gbu-azure-gpt-6-luna
```

因此测试中的 Claude Code 是 **Claude Code Agent 经团队网关运行，后台模型为 `gbu-azure-gpt-6-luna`**，不能据此认定 Anthropic Haiku 模型通过验证。没有修改用户原有 Claude settings 或复制密钥。

本机 Claude 的 Auto 分类器会直接拒绝部分 MCP 任务更新，且不会向 ACP 发出审批请求。需要让成员操作 DSH 任务板时，可在「成员管理 → Claude 成员 → 模式」选择 **Manual**（协议 ID 为 `default`）。本次真实团队测试使用该模式，已验证成员亲自领取和完成任务；DSH 的沙箱和工具检查继续生效。插件不会自动更改用户原有的 Claude 默认模式。

先在插件中检查连接并刷新模型目录，再在新会话选择 Agent。Codex 此次选用 `gpt-6-luna`。模型目录中的 ID 是派单参数的依据，不应自行拼接推理强度后缀。

## 手动持续对话

1. 创建新会话，在原生模型选择器中选择 Codex 或 Claude 对应模型。
2. 发送消息；后续追问保留在该原生会话中。
3. 切换到另一条会话即可与另一个 Agent 工作。不同 Agent 需要独立上下文时，使用不同会话。

插件复用原生聊天和会话历史，不另建一套聊天数据库。

DSH 0.2.2 在已有会话中换模型前，需要模型提供上下文容量。当前 ACP 目录没有统一提供这项信息，因此容量未知时，成员模型控件保持只读。首版请在创建会话／成员时选定模型；需要另一个模型时新建会话或成员，原会话仍可继续追问。插件不会伪造模型容量来绕过宿主检查。

## 统一派单与管理

在 DSH 中启用实验性 Agent Teams，并在主会话提出具体分工。例如：

> 先用 acp_list_agents 查询已配置的 Agent 和模型。主会话由 Codex 负责修改 src/parser.ts；用 acp_spawn_agent 创建 claude 成员 reviewer，选择目录中的 haiku，负责只读检查 src/parser.ts，不修改文件。你们不独占代码库，不要回退其他人的改动。完成后由主会话汇总结果。

新增工具：

| 工具 | 作用 |
| --- | --- |
| `acp_list_agents` | 返回配置的 Agent ID、名称及实际可选模型 ID。 |
| `acp_spawn_agent` | 主 Agent 使用 `agent_id`、`model`、`name`、`description`、`prompt` 创建原生团队成员。 |

`acp_spawn_agent` 仅向团队主 Agent 开放；非法 Agent 或模型会被拒绝。成员名称沿用 DSH 的 lower-kebab-case 规则。成员后续使用原生消息、任务板和取消能力；原有 `spawn_teammate` 继续保持其继承默认路由的语义。

## 版本迁移与验证边界

已适配 0.2.2-rc.1 的模型选择、投影句柄、批量工具执行和独立 Native/PTC 执行器。工具结果继续交给 DSH 原生执行链处理，包括附加上下文和结束回合信号。

开发验证命令（使用项目固定的 Node 24.21.0）：

```bash
pnpm typecheck
pnpm test
pnpm build
DSH_UPSTREAM_CHECKOUT="$PWD/reference/deepseek-harness" \
  DSH_E2E_BROWSER_CHANNEL=chrome \
  pnpm test:e2e test/e2e/managed-agents.e2e.ts
```

真实 Agent 验证需要另行显式设置测试开关和模型参数；默认测试不调用付费 Agent。完整验证结果与本地证据路径见交付时的验证报告。


## Provider 管理改造

接入管理现在使用左侧实例列表和右侧详情，按“类型 → 实例信息 → 配置与检查”添加。支持同类型多实例、实例开关和稳定只读 ID。停用后已接受的任务继续执行，后续调用被阻止，重新启用可继续原会话。认证继续使用 CLI 登录，协议成功不会显示成已登录。详细边界见 [Provider 实例管理](provider-management.zh.md)。
