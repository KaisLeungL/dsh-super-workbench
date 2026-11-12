# DSH 工作区上下文协议 v1

`@local/dsh-workspace-context` 是独立的 Cordis Host bundle。包含 `workspaceContext` 注册服务，以及任务看板、原生自动化两个适配入口。通过现有插件管理器或 profile 安装。未加载某个业务组件时，其适配入口等待依赖就绪。

## 大肥鱼部署

大肥鱼已绑定工作区的只读授权用于上下文查询。`task-board.list` 默认映射到本 bundle 的看板适配器。读取自动化任务时，在大肥鱼的 `deployment` 配置中明确登记来源。配置修改随部署重新加载生效。

```yaml
contextSources:
  schedule.upcoming: '@local/dsh-workspace-context/schedule'
boardReadScope: all-projects
```

`dsh_context_catalog` 返回当前获准的能力、筛选字段和可用状态。`dsh_context_query` 接收 `capability`、可选 `filter`、`limit`、`cursor`。返回工作区、读取时间、来源修订、摘要和 `ref`。分页使用相同筛选和 `nextCursor`。查询成功且为空时返回 `status: ok` 和空数组。不可用、超时、参数错误、越权和游标失效有各自状态。

默认按已绑定工作区查询。桌面部署可设置 `boardReadScope: all-projects`，让前台主理读取看板全部项目及未归属卡片的列表和描述。普通列表默认排除归档。执行报告继续按原有执行归属授权。自动化以原生目标会话的唯一工作区归属或新会话目标的明确 `cwd` 为依据，返回任务标题和时间。

## 第三方原生接入

`register` 接收注册段自己的 Cordis 上下文和能力声明。外层插件原有依赖继续服务原有功能。用局部 `inject` 让上下文接入独立启动和停止。

```js
export function apply(ctx) {
  ctx.inject(['workspaceContext', 'myNotes'], scoped => {
    scoped.effect(() => scoped.workspaceContext.register(scoped, {
      protocol: 1,
      id: 'my-notes.list',
      source: '工作区笔记',
      description: '读取当前工作区的笔记标题。',
      scope: 'workspace',
      filters: {},
      async read({ scope, offset, limit, signal }) {
        const page = await scoped.myNotes.listTitles(scope.workspaceId, { offset, limit, signal });
        return {
          revision: String(page.revision),
          more: page.more,
          items: page.items.map(note => ({
            workspaceId: scope.workspaceId,
            ref: { kind: 'my-notes.note', id: note.id },
            title: note.title,
          })),
        };
      },
    }));
  });
}
```

部署配置把 `my-notes.list` 映射到该 Cordis 入口的模块名。注册身份取自 profile 加载条目。TypeScript 可从包入口导入 `ContextCapability` 类型。筛选支持 `string`、`boolean`、`integer`，字符串可声明枚举。返回项应按稳定顺序分页，每项须带可核对的工作区，项目级能力还需提供项目 ID。授权、查询、来源代次或来源修订变化时，旧游标需要重新起读。

## 已有插件适配

把上面的注册段放进独立 Cordis bundle，依赖原插件的公开服务。`task-board.js` 是扩展示例，利用看板公开扩展的 `start` 和 `stop` 跟踪看板主开关。`schedule.js` 是原生服务适配示例。适配包用自己的模块身份登记，部署方按能力和提供方授予读取。接口不可用时目录显示该能力不可用。

提供方代码作为已安装 Host 插件运行，应在自己的业务服务内按传入范围查询，投影最少必要字段，并响应取消信号。Host 对工作区、项目、数量、响应大小和授权代次做二次检查。

## 验证

在本包目录运行 `npm test`，覆盖能力授权、工作区和项目隔离、分页以及在途结果撤销。在大肥鱼包目录构建后运行 `node scripts/context-e2e.mjs`，用隔离 DSH 实例、真实看板和原生自动化服务验证注册与查询。测试模型按固定顺序调用工具，测试数据仅写入独立的 DSH profile。
