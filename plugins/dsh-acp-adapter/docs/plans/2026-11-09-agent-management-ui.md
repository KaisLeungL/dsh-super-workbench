# Agent 管理一级页面实施计划

**目标：**按已确认的三张 UI 稿，将 ACP Agent 管理提升为 DSH 左侧一级入口，完成真实数据展示与当前 desktop profile 安装。

**架构：**复用 DSH Slots、工作区与会话投影、现有 ACP 活动流和配置控制器。新增独立主页面，保留原生聊天/审批；监控仅持有最多四个会话读取引用，不启动或停止 Agent。列表摘要由 Host 投影维护，避免为列表持续加载全部聊天。

**技术栈：**TypeScript、React createElement、CSS Modules、DSH 0.2.2-rc.1、Vitest、已有协议夹具浏览器 E2E。

## 修改边界

当前分支 codex/dsh-0.2.2-agent-manager 有大量既有改动，保留，不 reset/clean，不合入无关格式修改。原有本地工作台未跟踪文件也视为既有成果。构建、prepack、E2E 与安装全部由 Lead 串行执行。

## 任务一：会话摘要

新增 src/host/composition/monitor-summary.ts 和相应单测。先测试执行中/空闲/错误、真实时间与消息摘要，再实现纯投影 fold，注册 wire view；只读取实际事件，不把空闲当成功。客户端 data/agent-monitor.ts 解码投影，维持工作区隔离和读取上限。

验证：聚焦 vitest，检查异常清除、未知状态、无消息、已有历史、非相关事件保留对象身份。

## 任务二：一级主页面与总览/监控

修改 src/client/index.ts 注册 sidebar.panellist 和 main 对应同一个自有键，移除会话工作台页签。新增 AgentManager.ts/css，读取工作区列表并选择目录；独立页面不显示会话输入框。调整 AgentMonitor.ts/css 为可复用总览/监控组件，保留活动详情、四格/双栏/单栏、放大、移出、跟随和原生打开会话。列表与详情支持搜索、Agent/状态筛选，最多四项加入监控，窄屏不横向溢出。

验证：新增/调整协议夹具 E2E：从一级菜单进入、默认总览、选中详情、加入/移出、四格与实时更新、切换工作区、打开原生会话及资源释放。

## 任务三：接入管理

独立 worker 仅修改 AcpSection.ts/css 和专属测试。新增 presentation:'management'，平面列表加右侧编辑；复用既有校验、目录选择、保存、删除、检查与脱敏，不重写配置业务。最近检查时间使用 probe.at，保留未检查/失败/不可达状态。

验证：聚焦行为测试，再由 Lead 集成类型检查及配置页 E2E；旧插件配置页仍可使用。

## 任务四：评审、构建、安装

按功能范围做独立规格评审和代码质量评审；修复后串行 pnpm typecheck、focused tests、pnpm build、受影响 E2E。使用项目固定 Node 24.21.0，日志与候选包存 .local/。包版本升至 0.2.2-rc.1-local.3；核对 tarball 内容与版本后，通过当前 DSH plugin_manager 安装，检查 application/warnings，再核验实际一级入口与主页面。

验收：实际桌面页面对照稿图检查导航、主区、接入侧栏和布局；协议夹具与真实当前会话的证据分别报告。本轮不发布 npm/GitHub，不更改 Agent 登录或权限默认策略。
