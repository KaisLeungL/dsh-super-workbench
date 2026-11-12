import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// 打开真实隔离宿主并填好可截图的个人面板数据；脚本常驻，直到收到 SIGTERM。
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokenHeader = 'x-workspace-superagent-control-token';
const previewDir = resolve(plugin, '../../output/dafeiyu-personal-panel-v3');
await mkdir(previewDir, { recursive: true });

const cookieOf = response => (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
async function request(origin, path, { cookie, token, method = 'GET', body } = {}) {
  const headers = { cookie, accept: 'application/json' };
  if (token) headers[tokenHeader] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  if (!response.ok) throw Error(path + ' → ' + response.status + ' ' + text.slice(0, 300));
  return { value, token: response.headers.get(tokenHeader) ?? token };
}
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(400);
  }
  throw Error('超时：' + label + (last ? '（' + last.message + '）' : ''));
}
function newestProposal(root) {
  const db = new DatabaseSync(root + '/private/manager.sqlite.actions.sqlite', { readOnly: true });
  try { return db.prepare('SELECT id, turn, revision, state, body FROM proposal ORDER BY rowid DESC LIMIT 1').get(); }
  finally { db.close(); }
}
function proposalRow(root, id) {
  const db = new DatabaseSync(root + '/private/manager.sqlite.actions.sqlite', { readOnly: true });
  try { return db.prepare('SELECT id, revision, state, result FROM proposal WHERE id = ?').get(id); }
  finally { db.close(); }
}

const lab = spawn(process.execPath, [resolve(plugin, 'scripts/actions-lab.mjs')], { cwd: plugin, stdio: ['ignore', 'pipe', 'pipe'] });
let labLog = '';
const ready = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(Error('隔离宿主启动超时：' + labLog.slice(-1500))), 240_000);
  lab.stdout.on('data', chunk => {
    labLog += chunk;
    const line = labLog.split('\n').find(item => item.startsWith('{'));
    if (line && lab.pid) { clearTimeout(timer); resolveReady(JSON.parse(line)); }
  });
  lab.stderr.on('data', chunk => { labLog += chunk; });
  lab.on('exit', code => { clearTimeout(timer); reject(Error('隔离宿主提前退出 ' + code + '：' + labLog.slice(-1500))); });
});

const summary = { steps: [] };
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  lab.kill('SIGTERM');
  await writeFile(resolve(previewDir, 'preview-result.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

try {
  const { root, origin } = await ready;
  summary.root = root;
  summary.origin = origin;
  const login = await fetch((await readFile(root + '/login-url', 'utf8')).trim(), { redirect: 'manual' });
  const cookie = cookieOf(login);
  if (!cookie) throw Error('登录链接未返回浏览器凭证');
  summary.loginUrl = (await readFile(root + '/login-url', 'utf8')).trim();
  let { value: health, token } = await request(origin, '/api/workspace-superagent/health', { cookie });
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

  // 今日待办：数量与状态覆盖概览的多种行。
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const titles = ['确认自动化任务验收范围', '看 Worker 的调度检查报告', '整理本周优先事项', '补充个人面板的窄窗验收'];
  for (const title of titles) {
    await request(origin, '/api/workspace-superagent/personal', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'create', requestId: randomUUID(), title, localDate: day } } });
  }
  const { value: personal } = await request(origin, '/api/workspace-superagent/personal', { cookie, token });
  const doneTodo = personal.todos.items.find(item => item.title === '整理本周优先事项');
  if (doneTodo) {
    await request(origin, '/api/workspace-superagent/personal', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'update', requestId: randomUUID(), id: doneTodo.id, revision: doneTodo.revision, done: true } } });
  }
  summary.steps.push({ step: 'todos', count: titles.length });

  // 定时任务：走真实提案 → 确认链路。
  await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { sessionId, requestId: randomUUID(), text: '每天早上九点帮我整理隔离日报。' } });
  const proposal = await waitFor(() => { const row = newestProposal(root); return row && JSON.parse(row.body).actionId === 'dsh.schedule.create' && row.state === 'draft' ? row : undefined; }, 30_000, '定时任务提案');
  const candidate = JSON.parse(proposal.body);
  await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'save', id: proposal.id, revision: proposal.revision, proposal: candidate } } });
  const scheduleView = (await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'read', turn: proposal.turn } } })).value?.proposal;
  if (scheduleView?.status === 'ready') {
    await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'confirm', id: proposal.id, revision: scheduleView.revision, expectedNextRunAt: scheduleView.nextRunAt } } });
    await waitFor(() => proposalRow(root, proposal.id)?.state === 'succeeded', 30_000, '定时任务确认').catch(() => undefined);
  }
  summary.steps.push({ step: 'schedule', state: proposalRow(root, proposal.id)?.state });

  // 派工活动：真实建卡 → Worker 检查，为详情弹窗提供时间线。
  try {
    await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { sessionId, requestId: randomUUID(), text: '在看板帮我创建一张任务卡片。' } });
    const cardProposal = await waitFor(() => {
      const row = newestProposal(root);
      return row && JSON.parse(row.body).actionId === 'dsh.taskBoard.create' && row.state === 'draft' ? row : undefined;
    }, 30_000, '建卡提案');
    const cardCandidate = JSON.parse(cardProposal.body);
    const filled = { ...cardCandidate, params: { ...cardCandidate.params, title: '检查自动化任务可用性', description: '检查调度入口与投递状态', column: 'todo' } };
    await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'save', id: cardProposal.id, revision: cardProposal.revision, proposal: filled } } });
    const cardView = (await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'read', turn: cardProposal.turn } } })).value?.proposal;
    await request(origin, '/api/workspace-superagent/actions', { cookie, token, method: 'POST', body: { sessionId, request: { op: 'confirm', id: cardProposal.id, revision: cardView.revision } } });
    const created = await waitFor(() => { const row = proposalRow(root, cardProposal.id); return row?.state === 'succeeded' ? row : undefined; }, 30_000, '建卡确认');
    await writeFile(root + '/delegate-task.txt', created.id + '\n');
    await request(origin, '/api/workspace-superagent/chat', { cookie, token, method: 'POST', body: { sessionId, requestId: randomUUID(), text: '让 Worker 检查这张卡片。' } });
    const withActivity = await waitFor(async () => {
      const { value } = await request(origin, '/api/workspace-superagent/personal', { cookie, token });
      return value.activities?.available && value.activities.items?.length ? value : undefined;
    }, 120_000, '派工活动投影');
    summary.steps.push({ step: 'activity', count: withActivity.activities.items.length });
  } catch (error) {
    summary.steps.push({ step: 'activity', skipped: error instanceof Error ? error.message : String(error) });
  }

  const final = await request(origin, '/api/workspace-superagent/personal', { cookie, token });
  summary.todos = final.value.todos;
  summary.schedules = final.value.schedules;
  summary.activities = final.value.activities;
  summary.ok = true;
  summary.checkedAt = new Date().toISOString();
  await writeFile(resolve(previewDir, 'preview-ready.json'), JSON.stringify({ root, origin, loginUrl: summary.loginUrl, checkedAt: summary.checkedAt }, null, 2) + '\n');
  console.error('PREVIEW_READY ' + summary.loginUrl);
  await new Promise(resolveHold => { process.once('SIGTERM', resolveHold); process.once('SIGINT', resolveHold); });
  await stop();
} catch (error) {
  summary.ok = false;
  summary.error = error instanceof Error ? error.message : String(error);
  summary.labLogTail = labLog.slice(-2000);
  await stop();
}
