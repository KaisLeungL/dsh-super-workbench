import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokenHeader = 'x-workspace-superagent-control-token';
const cookieOf = response => (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');

async function request(origin, path, { cookie, token, method = 'GET', body } = {}) {
  const headers = { cookie, accept: 'application/json' };
  if (token) headers[tokenHeader] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  if (!response.ok) throw Error(path + ' → ' + response.status + ' ' + text.slice(0, 400));
  return { value, token: response.headers.get(tokenHeader) ?? token };
}

function proposalRow(root, id) {
  const db = new DatabaseSync(root + '/private/manager.sqlite.actions.sqlite', { readOnly: true });
  try { return db.prepare('SELECT id, session, revision, state, result FROM proposal WHERE id = ?').get(id); }
  finally { db.close(); }
}

function newestProposal(root) {
  const db = new DatabaseSync(root + '/private/manager.sqlite.actions.sqlite', { readOnly: true });
  try { return db.prepare('SELECT id, session, revision, state, body FROM proposal ORDER BY rowid DESC LIMIT 1').get(); }
  finally { db.close(); }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(300);
  }
  throw Error('超时：' + label + (last ? '（最后一次错误：' + last.message + '）' : ''));
}

const lab = spawn(process.execPath, [resolve(plugin, 'scripts/actions-lab.mjs')], { cwd: plugin, stdio: ['ignore', 'pipe', 'pipe'] });
let labLog = '';
const labReady = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(Error('隔离宿主启动超时：' + labLog.slice(-2000))), 180_000);
  lab.stdout.on('data', chunk => {
    labLog += chunk;
    const line = labLog.split('\n').find(item => item.startsWith('{'));
    if (line && lab.pid) { clearTimeout(timer); resolveReady(JSON.parse(line)); }
  });
  lab.stderr.on('data', chunk => { labLog += chunk; });
  lab.on('exit', code => { clearTimeout(timer); reject(Error('隔离宿主提前退出 ' + code + '：' + labLog.slice(-2000))); });
});

const summary = { steps: [] };
try {
  const { root, origin, pid } = await labReady;
  Object.assign(summary, { root, origin, pid });
  const login = await fetch(normalize(await readFile(root + '/login-url', 'utf8')).trim(), { redirect: 'manual' });
  const cookie = cookieOf(login);
  if (!cookie) throw Error('登录链接未返回浏览器凭证');
  let { value: health, token } = await request(origin, '/api/workspace-superagent/health', { cookie });
  summary.steps.push({ step: 'health', available: health.available, manager: health.summary?.manager?.bindingState, chat: health.chat });
  if (!token) throw Error('健康接口没有返回控制凭证');
  const managerRevision = () => health.summary.manager.revision;
  if (health.chat && !health.chat.ready) {
    await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { revision: managerRevision() } });
    health = await waitFor(async () => {
      const next = await request(origin, '/api/workspace-superagent/health', { cookie, token });
      token = next.token;
      return next.value.chat?.ready ? next.value : undefined;
    }, 30_000, '主理会话连接');
    summary.steps.push({ step: 'connect', chat: health.chat });
  }
  const sessionId = health.chat.sessionId;
  if (!sessionId) throw Error('主理会话尚未建立');

  const createText = '在看板帮我创建一张任务卡片。';
  await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { sessionId, requestId: randomUUID(), text: createText } });
  let proposal = await waitFor(() => newestProposal(root), 30_000, '建卡提案');
  const candidate = JSON.parse(proposal.body);
  if (candidate.actionId === 'dsh.taskBoard.create') {
    const filled = { ...candidate, params: { ...candidate.params, title: '检查自动化任务可用性', description: '检查调度入口与投递状态', column: 'todo' } };
    await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'save', id: proposal.id, revision: proposal.revision, proposal: filled } } });
    proposal = proposalRow(root, proposal.id);
  }
  await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'confirm', id: proposal.id, revision: proposal.revision } } });
  const created = await waitFor(() => { const row = proposalRow(root, proposal.id); return row?.state === 'succeeded' ? row : undefined; }, 30_000, '建卡确认');
  summary.steps.push({ step: 'create', taskId: created.id, state: created.state, result: created.result });

  const card = await request(origin, '/api/task-board/state', { cookie });
  const task = card.value.tasks.find(item => item.id === created.id);
  summary.steps.push({ step: 'card', task: task && { id: task.id, status: task.status, mode: task.mode, permission: task.permission, workspaceId: task.workspaceId } });
  if (!task) throw Error('看板没有读回刚创建的卡片');

  await (await import('node:fs/promises')).writeFile(root + '/delegate-task.txt', created.id + '\n');

  const delegateText = '让 Worker 检查这张卡片。';
  await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { sessionId, requestId: randomUUID(), text: delegateText } });
  const personal = await waitFor(async () => {
    const { value } = await request(origin, '/api/workspace-superagent/personal', { cookie, token });
    return value.activities?.available && value.activities.items?.length ? value : undefined;
  }, 90_000, '派工活动投影');
  summary.steps.push({ step: 'personal', activities: personal.activities });

  const settled = await waitFor(async () => {
    const board = await request(origin, '/api/task-board/state', { cookie });
    const item = board.value.tasks.find(entry => entry.id === created.id), run = item?.executions?.[0];
    return run && run.endedAt !== undefined ? { item, run } : undefined;
  }, 90_000, 'Worker 执行结算');
  summary.steps.push({ step: 'execution', status: settled.item.status, execution: {
    id: settled.run.id, sessionId: settled.run.sessionId, result: settled.run.result, endedAt: settled.run.endedAt,
    error: settled.run.error ?? settled.run.ownError, summary: settled.run.summary?.text ?? null,
  } });
  const finalPersonal = await request(origin, '/api/workspace-superagent/personal', { cookie, token });
  summary.steps.push({ step: 'activity', activity: finalPersonal.value.activities?.items?.[0] ?? null });

  summary.ok = true;
  summary.checkedAt = new Date().toISOString();
  summary.loginUrl = normalize(await readFile(root + '/login-url', 'utf8')).trim();
} catch (error) {
  summary.ok = false;
  summary.error = error instanceof Error ? error.message : String(error);
  if (summary.root) summary.labLogTail = labLog.slice(-3000);
} finally {
  lab.kill('SIGTERM');
  console.log(JSON.stringify(summary, null, 2));
}
function normalize(value) { return value.trim(); }
