# dsh-task-board-inspection

[English](README.md) | 中文

为 DSH 任务看板提供只读工作区巡检和有证据的待规划推荐。

## 能力

- 复用 DSH 工作区，显式配置项目目标、根目录、授权相对路径、模型和巡检开关。
- 立即巡检；每日巡检通过看板提供的可选 Cron 适配能力运行，错过的出现不补跑。
- 严格结构化模型输出，可生成零条推荐；每条包含证据引用、理由、范围与验收标准。
- 候选先保存到插件独立域，再通过看板原子 upsert 写入 backlog/proposed；批次重试复用已保存候选与来源键。

## 安装

需要任务看板服务、DSH workspaceRegistry、storageDomain 和可调用的 LLM 服务。本包通过 Cordis bundle 挂载，不修改 DSH 源码。

```sh
dsh plugin --profile <name> add link:/absolute/path/to/packages/dsh-task-board-inspection
```

安装与 profile 行变化由用户在明确授权时执行；宿主需要重新加载或重启时遵循其安装提示。

## 配置

在任务看板设置的「项目巡检」区点击「配置巡检」，通过弹窗添加或编辑规则；关闭后保留原界面，取消不会保存草稿。选择已有工作区，填写目标、授权根目录、相对路径与 provider/model。Git 信息、会话摘要和巡检记录默认折叠；启用每日巡检后展示 Cron 与时区。保存成功后关闭弹窗，规则必须保存后才可立即巡检。新规则默认不授权扫描、不启用 Cron；插件 bundle 的 rules 默认为空。

```yaml
enabled: true
rules:
  - id: project-review
    workspaceId: existing-dsh-workspace-id
    enabled: false
    root: /absolute/project/path
    goal: 完成已约定目标，检查实际进度与验收缺口
    revision: 1
    paths:
      - README.md
      - docs/progress
    model: provider/model
    daily: false
    cron: '0 9 * * *'
    timeZone: Asia/Shanghai
    maxRecommendations: 3
    includeGit: false
```

每日巡检需要看板暴露 inspectionSchedule.register 能力；缺少该能力时设置明确禁用每日开关，并报告 schedule-adapter-unavailable。扩展不创建另一条原生 schedule。规则 id 与目标 revision、实际 occurrence 共同决定定时批次身份，手动巡检使用独立随机身份。

每项目最多 3 条推荐，每批最多扫描 5 个项目、生成 5 条推荐。文件预算为 24 个文件、256 个访问节点、每文件 16 KiB、总文件文本 96000 字节；每项目时长 90 秒，模型输出最多 4096 tokens 和 16000 字符。仅记录本次模型返回的 token usage，未返回时保持未知，不推断费用或把看板全局消耗当作巡检消耗。

## 安全模型

- 只有显式启用的规则可扫描；根目录必须 realpath 位于所选工作区内，授权路径不能越界。不跟随符号链接，打开文件时使用 O_NOFOLLOW，并核对 inode。
- 排除隐藏目录、依赖、构建产物、常见凭据文件、大文件、二进制和含私钥或凭据特征的文本。过滤是额外防线，授权范围应尽量窄。
- 不安装依赖、不执行项目脚本、不使用通用 Agent 工具。可选 Git 读取仅包含近期提交标题与暂存路径；固定命令禁用 hooks、fsmonitor、外部 diff、textconv、lazy fetch 和继承的 Git 配置变量，不读取未暂存差异。
- 模型仅收到目标、受限证据和有限历史卡片摘要。模型不能调用工具或写账本；Host 校验证据引用后才调用原子推荐接口。所有推荐必须由看板人工采纳后才能执行。

## 已知限制

未提供看板原子推荐能力时拒绝运行，不降级为普通建卡再移动。批次域和看板账本不是同一个事务；逐条提交与耐久候选支持重试，来源键去重仍由看板负责，覆盖活跃与归档卡片。

可选 sessionIds 最多显式选择 5 个会话，只读取本看板在同一执行工作区中已记录的结算摘要；不遍历任意 DSH 会话原始历史。远程 GitHub、商店、分析后台、Git 工作树未暂存差异和 worktree 外置 Git 元数据不在本版本采集范围。覆盖报告区分未请求、成功与不可用，不将未覆盖数据描述为已检查。

推荐有效期为 24 小时，采纳前重新核对目标 revision 与完整规则指纹。规则或工作区路径在分析期间变化会拒绝旧候选；部分提交重试复用持久化候选并继续钉住原规则工作区。重新巡检可刷新未采纳推荐的证据与受限输入，同时保留人工稍后决定。

此包的自动化验证使用临时目录、模型流与服务夹具；不能据此声称已对实际用户项目、真实模型 provider、真实定时 occurrence 或生产 GUI 完成验收。
