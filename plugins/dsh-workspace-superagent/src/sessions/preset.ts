import type { RuntimeContext, NativeAgent } from './runtime.js';
export const inject = ['tools', 'systemPrompt'];
/** 稳定外层不依赖可撤回 runtime；缺当前 attachment 时一直默认拒绝。 */
export function apply(ctx: RuntimeContext & { inject(names: string[], callback: (scope: RuntimeContext) => void): unknown }, config: { scheduleOnly?: boolean } = {}): void {
  if (config.scheduleOnly === true) { scheduled(ctx); return; }
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(exec => {
    const runtime = ctx.get('workspaceSuperagentRuntime') as { isPublished(agent: NativeAgent): boolean } | undefined;
    return exec.agent && runtime?.isPublished(exec.agent) ? undefined : '当前安装已关闭，拒绝调用。';
  });
  ctx.on('agent/created', raw => {
    const agent = (raw as { agent: NativeAgent }).agent;
    if (agent.inputAdmissionVersion !== 4 || typeof agent.requireInputAdmission !== 'function') throw Error('PRECLAIM_CAPABILITY_REQUIRED');
    agent.requireInputAdmission();
  });
  // 内层 provider/consumer 在同一 realm；只追踪当前 runtime，不重 mount published Agent。
  ctx.inject(['workspaceSuperagentRuntime'], scope => {
    const runtime = scope.get('workspaceSuperagentRuntime') as { installWorkerScope(scope: RuntimeContext): void };
    runtime.installWorkerScope(scope);
  });
}

/** The first schedule action only delivers text; it cannot grant future tool permissions. */
export function scheduled(ctx: RuntimeContext): void {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '此专用定时会话未授予工具权限。');
  ctx.systemPrompt.section({ name: 'workspace-superagent-scheduled', order: 50,
    text: '处理用户确认的定时任务，在当前会话输出结果。只依据当前会话可见的信息，不访问文件、网络，不对外发送，不编造缺失数据。' });
}
