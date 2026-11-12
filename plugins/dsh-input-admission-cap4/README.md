# 受管输入准入 cap4

此本地组合包使用官方 Harness 源码构建的 AgentLoop，补齐输入认领前准入及实际模型请求发送前核权。仅适配 DSH 0.2.2-rc.1；它不是官方上游发布版本。源码及构建文件身份见 [source-identity.json](source-identity.json)。

组合包禁用原 `agent-loop` 条目，注册同名 `agentLoop` 服务的新驱动，配置保持 `agents: []`、`maxParallelToolCalls: 10`。通过插件管理器安装或禁用本组合包，不直接编辑用户 Profile 文件。禁用本组合包后原驱动恢复；切换驱动可能结束正在执行的会话。

可信拥有方先检查工厂和精确 Agent 的 `inputAdmissionVersion === 4`，再在 unpublished setup、idle 或独占维护期间调用 `requireInputAdmission()`。认领前缺少监听器、拒绝、取消或输入变化均保留待处理输入；获准步骤提供同步 `validate`，按每次请求及重试复核。授权失败不会发送模型请求，已提交的历史保留。未启用准入的普通会话保持原行为。

SDK 包声明为 peerDependencies，由正式 Profile 的模块解析器提供同一运行时实例；不要把 ASAR 路径链接到本目录的 node_modules，也不要另装一份 Cordis。普通外部 Node 直接导入不能替代正式 `dsh --profile` 验证。

已验证源码专门回归、构建与聚合类型、TypeScript 录制会话回放、Python SDK 请求记录及桌面 CLI 的正式隔离 Profile。隔离模型使用确定性适配器，不代表外部模型 API 或 Super Agent F8 全链路已通过。实际安装生效状态以当前 Profile 的插件管理回执为准。

图标为原创 SVG；官方 AgentLoop 构建代码遵循附带 MIT [许可证](LICENSE)。
