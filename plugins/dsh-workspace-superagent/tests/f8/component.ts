import type { InstallationOperation } from '../../src/sessions/installation.js';
/** 仅 lifecycle 组件夹具：明确提供合法 paused capsule，不冒称原生 origin。 */
export async function componentInstallation(operation: InstallationOperation) {
  if (operation.snapshot.bindingState === 'none') {
    operation.reserve('component-session', 'component-workspace', 'workspace-superagent-router');
    operation.beginCreate();
    operation.bind({ sessionId: 'component-session', workspaceId: 'component-workspace', preset: 'workspace-superagent-router', nativeLogRef: 'component-fixture-only' });
  }
  return operation.stage({ ready: false }, () => {});
}
