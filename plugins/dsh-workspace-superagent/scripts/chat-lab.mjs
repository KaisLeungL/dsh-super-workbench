import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(plugin, '../..');
const lab = workspace + '/.superagent-product-lab/chat-web';
await mkdir(lab, { recursive: true, mode: 0o700 });
const supplied = process.argv[2];
const root = supplied ? await realpath(supplied) : await mkdtemp(lab + '/run-');
if (dirname(root) !== lab || !root.startsWith(lab + '/run-')) throw Error('只允许本脚本创建的隔离运行目录');
const profile = 'superagent-chat-lab';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^DSH_|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|^(DEEPSEEK|OPENAI|ANTHROPIC|AWS|AZURE|GOOGLE)_/i.test(key)));
Object.assign(env, { DSH_HOME: root + '/home', DSH_AGENTS_HOME: root + '/agents', DSH_TELEMETRY_DISABLED: '1', SUPERAGENT_CHAT_LAB: root });
const args = ['--profile', profile];
const redact = line => line.replace(/([?&]token=)[^\s&"']+/g, '$1[已脱敏]');
function command(commandArgs) {
  const run = spawnSync('dsh', commandArgs, { env, cwd: workspace, encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) throw Error(redact(run.stderr || run.stdout || String(run.error)));
}
async function boot(patch) {
  const child = spawn('dsh', [...args, '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { env, cwd: root + '/workspace', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', result;
  const closed = new Promise(ok => {
    child.on('error', error => { result = { error: error.message }; ok(result); });
    child.on('close', (code, signal) => { result = { code, signal }; ok(result); });
  });
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { output += chunk; });
  async function stop() {
    if (!result) child.kill('SIGTERM');
    const force = setTimeout(() => { if (!result) child.kill('SIGKILL'); }, 8000);
    try { return await closed; }
    finally { clearTimeout(force); await writeFile(root + '/host.log', redact(output), { mode: 0o600 }); }
  }
  for (let i = 0; i < 300 && !result; i++) {
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
    if (match) return { url: match[0], pid: child.pid, closed, stop };
    await delay(100);
  }
  await stop();
  throw Error('隔离 DSH 未就绪，日志：' + root + '/host.log');
}
if (!supplied) {
  await mkdir(root + '/workspace');
  await mkdir(root + '/private', { mode: 0o700 });
  command([...args, '--from-default-profile', 'web', '--help']);
  command(['plugin', ...args, 'add', workspace + '/plugins/dsh-input-admission-cap4', plugin, '--ignore-scripts']);
  await cp(workspace + '/.superagent-product-lab/e37/frozen-e37-v1/board-baseline', root + '/board',
    { recursive: true, dereference: false, verbatimSymlinks: true });
  await writeFile(root + '/owners.json', '{"version":1,"taskIds":[]}\n');
  await mkdir(root + '/home/task-board', { recursive: true });
  await writeFile(root + '/home/task-board/execution-inputs-v1.json', '[]\n');
  await writeFile(root + '/fixture.mjs', `
import { apply as applyBoard } from './board/lib/index.js';
import { writeFileSync } from 'node:fs';
export const inject = ['workspaceRegistry', 'llm'];
export async function apply(ctx) {
  const root = process.env.SUPERAGENT_CHAT_LAB;
  if (process.env.DSH_HOME !== root + '/home' || !root.includes('/.superagent-product-lab/chat-web/run-')) throw Error('ISOLATION_REQUIRED');
  if (!await ctx.workspaceRegistry.resolveByPath(root + '/workspace')) await ctx.workspaceRegistry.create(root + '/workspace', '隔离对话工作区');
  const provider = 'superagent-lab', model = { provider, id: 'controlled', name: '隔离验证模型', defaultMaxTokens: 1000, context: { contextWindow: 8192 } };
  const adapter = {
    providerInfo: () => ({ id: provider, name: '隔离验证模型' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [model], resolveModel: async () => model,
    async prepareCall() { return { model, stream: options => adapter.stream(options) }; },
    async *stream(options) {
      const user = options.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1);
      const input = user?.content?.find?.(part => part.type === 'text')?.text ?? '';
      const callId = 'board-read-' + user?.id;
      const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === callId);
      if (input === '看板只读验收' && !result) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: callId, name: 'steward_list_tasks', argumentsDelta: '{}' };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const reply = result ? (result.isError ? '只读看板查询失败。' : '已收到只读看板查询结果。') : '隔离模型收到：' + input;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  ctx.llm.registerAdapter([provider], adapter);
  writeFileSync(root + '/fixture-ready', 'ready\\n');
}
export function board(ctx) {
  const root = process.env.SUPERAGENT_CHAT_LAB;
  return applyBoard(ctx, { enabled: { get: () => true }, announceToAgent: false, preventIdleSleep: false,
    goalRunEnabled: false, goalVerification: false, sessionDefaultPermission: 'read-only', executionOwnershipFile: root + '/owners.json' });
}
`);
  await writeFile(root + '/board-entry.mjs', "export { board as apply } from './fixture.mjs'; export { inject } from './board/lib/index.js';\n");
  const disabled = ['agent-loop','headless-runner','session-title-llm','session-telemetry-otel','llm-pi-ai',
    'llm-deepseek','llm-deepseek-account','tool-web','web-search-deepseek','web-deepseek-api','tool-subagent',
    'tool-subagent-fork','tool-workflow','tool-goal','tool-bash','tool-pwsh','tool-fs','tool-jobs'];
  const base = disabled.map(id => '- id: ' + id + '\n  disabled: true').join('\n') + '\n- insert:\n';
  const entries = [
    { id: 'chat-lab-fixture', name: root + '/fixture.mjs' },
    { id: 'chat-lab-board', name: root + '/board-entry.mjs' },
    { id: 'input-admission-cap4', name: '@local/dsh-input-admission-cap4', config: { agents: [], maxParallelToolCalls: 10 } },
  ];
  const yaml = rows => base + rows.map(row => '    - ' + JSON.stringify(row)).join('\n') + '\n';
  await writeFile(root + '/setup.yml', yaml(entries));
  const setup = await boot(root + '/setup.yml');
  await readFile(root + '/fixture-ready');
  await setup.stop();
  const deployment = { databasePath: root + '/private/manager.sqlite', workspacePath: root + '/workspace',
    identity: { instanceId: randomUUID(), domainId: randomUUID() },
    model: { provider: 'superagent-lab', model: 'controlled' },
    firstInstall: { expiresAt: Date.now() + 24 * 60 * 60 * 1000, proofRef: 'isolated-chat-lab' } };
  await writeFile(root + '/app.yml', yaml([...entries,
    { id: 'workspace-superagent', name: '@local/dsh-workspace-superagent', config: { deployment } },
    { id: 'preset-workspace-superagent-router', name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'workspace-superagent-router', name: '主理 AgentBot', plugins: [
        { id: 'workspace-superagent-router-outer', name: '@local/dsh-workspace-superagent/preset' },
      ] } },
  ]));
}
const host = await boot(root + '/app.yml');
await writeFile(root + '/login-url', host.url, { mode: 0o600 });
console.log(JSON.stringify({ root, url: new URL(host.url).origin, pid: host.pid }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void host.stop(); });
await host.closed;
await rm(root + '/login-url', { force: true });
