import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type { FoundationStatus } from './status';
import manifest from '../package.json';
import { installHealthHost } from './app/lifecycle/host.js';
import { mountDeployment, type DeploymentConfig } from './app/lifecycle/deployment.js';
export const inject = ['connection', 'workspaceRegistry', 'sessions'];
export async function apply(ctx: Context, config: { deployment?: DeploymentConfig } = {}): Promise<void> {
  if (config.deployment) await mountDeployment(ctx, config.deployment, installCore);
  else installCore(ctx);
}
function installCore(ctx: Context): void {
  installHealthHost(ctx);
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/workspace-superagent/status', methods: ['GET'], requestBody: 'buffered',
    async fetch() {
      const board = ctx.get('taskBoard') as { snapshot?: unknown } | undefined;
      const loop = ctx.get('agentLoop') as { inputAdmissionVersion?: unknown } | undefined;
      const status: FoundationStatus = { version: manifest.version, stage: 'b04', capabilities: {
        taskBoard: typeof board?.snapshot === 'function', inputAdmission: loop?.inputAdmissionVersion === 4,
      } };
      return Response.json(status, { headers: { 'cache-control': 'no-store' } });
    },
  }));
}
