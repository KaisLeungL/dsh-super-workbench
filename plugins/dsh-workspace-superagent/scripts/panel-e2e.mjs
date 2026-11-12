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
  try { return db.prepare('SELECT id, session, turn, revision, state, result, body FROM proposal WHERE id = ?').get(id); }
  finally { db.close(); }
}
function newestProposal(root) {
  const db = new DatabaseSync(root + '/private/manager.sqlite.actions.sqlite', { readOnly: true });
  try { return db.prepare('SELECT id, session, turn, revision, state, body FROM proposal ORDER BY rowid DESC LIMIT 1').get(); }
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
const ready = new Promise((resolveReady, reject) => {
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
  const { root, origin, pid } = await ready;
  Object.assign(summary, { root, origin, pid });
  const login = await fetch((await readFile(root + '/login-url', 'utf8')).trim(), { redirect: 'manual' });
  const cookie = cookieOf(login);
  if (!cookie) throw Error('登录链接未返回浏览器凭证');
  let { value: health, token } = await request(origin, '/api/workspace-superagent/health', { cookie });
  if (!token) throw Error('健康接口没有返回控制凭证');
  if (health.chat && !health.chat.ready) {
    await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { revision: health.summary.manager.revision } });
    health = await waitFor(async () => {
      const next = await request(origin, '/api/workspace-superagent/health', { cookie, token });
      token = next.token;
      return next.value.chat?.ready ? next.value : undefined;
    }, 30_000, '主理会话连接');
  }
  const sessionId = health.chat.sessionId;
  if (!sessionId) throw Error('主理会话尚未建立');
  summary.steps.push({ step: 'connect', sessionId });

  await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { sessionId, requestId: randomUUID(), text: '每天早上九点帮我整理隔离日报。' } });
  let proposal = await waitFor(() => { const row = newestProposal(root); return row && JSON.parse(row.body).actionId === 'dsh.schedule.create' ? row : undefined; }, 30_000, '定时任务提案');
  const candidate = JSON.parse(proposal.body);
  await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'save', id: proposal.id, revision: proposal.revision, proposal: candidate } } }).catch(() => undefined);
  const saved = proposalRow(root, proposal.id);
  const preview = await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'read', turn: saved.turn } } });
  const view = preview.value.proposal ?? preview.value;
  summary.steps.push({ step: 'preview', status: view.status, nextRunAt: view.nextRunAt });
  if (view.status !== 'ready') throw Error('定时提案未就绪：' + JSON.stringify(view));
  await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'confirm', id: proposal.id, revision: saved.revision, expectedNextRunAt: view.nextRunAt } } });
  const done = await waitFor(() => { const row = proposalRow(root, proposal.id); return row?.state === 'succeeded' ? row : undefined; }, 30_000, '定时任务确认');
  summary.steps.push({ step: 'schedule-confirm', state: done.state, result: done.result });

  const personal = await waitFor(async () => {
    const { value } = await request(origin, '/api/workspace-superagent/personal', { cookie, token });
    return value.schedules?.available && value.schedules.items?.length ? value : undefined;
  }, 30_000, '定时任务投影');
  summary.steps.push({ step: 'schedules', schedule: personal.schedules });

  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const created = await request(origin, '/api/workspace-superagent/personal', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'create', requestId: randomUUID(), title: '隔离待办验收', localDate: day } } });
  const todo = created.value.todos?.items?.find(item => item.title === '隔离待办验收');
  if (!todo) throw Error('待办写入后未读回');
  await request(origin, '/api/workspace-superagent/personal', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'update', requestId: randomUUID(), id: todo.id, revision: todo.revision, done: true } } });
  const after = await request(origin, '/api/workspace-superagent/personal', { cookie, token });
  summary.steps.push({ step: 'todos', todo: after.value.todos.items.find(item => item.id === todo.id) });

  summary.ok = true;
  summary.checkedAt = new Date().toISOString();
  summary.loginUrl = (await readFile(root + '/login-url', 'utf8')).trim();
} catch (error) {
  summary.ok = false;
  summary.error = error instanceof Error ? error.message : String(error);
  if (summary.root) summary.labLogTail = labLog.slice(-3000);
} finally {
  lab.kill('SIGTERM');
  console.log(JSON.stringify(summary, null, 2));
}
