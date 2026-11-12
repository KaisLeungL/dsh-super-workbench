import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./actions-lab.mjs', import.meta.url));

async function waitFor(read, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw Error('验收超时：' + label);
}

async function run(root, disabledSource, allBoardProjects = false) {
  const disableBoard = disabledSource === 'board', disableSchedule = disabledSource === 'schedule';
  const lab = spawn(process.execPath, [launcher, ...(root ? [root] : [])], {
    env: { ...process.env, WSA_CONTEXT_LAB: '1', WSA_CONTEXT_DISABLED_SOURCE: disabledSource, WSA_CONTEXT_ALL_BOARD: allBoardProjects ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(lab, 'close');
  let stdout = '', stderr = '';
  lab.stdout.on('data', data => { stdout += data; });
  lab.stderr.on('data', data => { stderr += data; });
  try {
    const ready = await waitFor(() => {
      if (lab.exitCode !== null) throw Error('隔离宿主提前退出：' + stderr.slice(-1600));
      const line = stdout.split('\n').slice(0, -1).find(value => value.startsWith('{'));
      return line && JSON.parse(line);
    }, '启动隔离宿主', 150_000);
    root = ready.root;
    if (!disabledSource) await waitFor(() => readFile(root + '/context-data-ready', 'utf8').catch(() => undefined), '写入两个工作区的原生测试数据');
    const login = await fetch((await readFile(root + '/login-url', 'utf8')).trim(), { redirect: 'manual' });
    const cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    assert.ok(cookie);
    let token;
    const call = async (route, body) => {
      const headers = { cookie, accept: 'application/json' };
      if (token) headers['x-workspace-superagent-control-token'] = token;
      if (body) headers['content-type'] = 'application/json';
      const response = await fetch(ready.origin + '/api/workspace-superagent/' + route, {
        method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
      });
      token = response.headers.get('x-workspace-superagent-control-token') ?? token;
      const result = await response.json();
      assert.ok(response.ok, route + ' → ' + JSON.stringify(result));
      return result;
    };
    let health = await waitFor(async () => { const value = await call('health'); return value.chat && value; }, '主理装配');
    if (!health.chat.ready) {
      await call('chat', { revision: health.summary.manager.revision });
      health = await waitFor(async () => { const value = await call('health'); return value.chat?.ready && value; }, '主理会话连接');
    }
    assert.deepEqual(Object.fromEntries(health.contextSources.map(({ id, available }) => [id, available])), {
      'task-board.list': !disableBoard, 'schedule.upcoming': !disableSchedule,
    });
    const resultsFile = root + '/context-results.jsonl';
    const readResults = async () => (await readFile(resultsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    const before = (await readResults()).length;
    await call('chat', { sessionId: health.chat.sessionId, requestId: randomUUID(), text: '工作区上下文验收' });
    const results = await waitFor(async () => {
      const lines = await readResults();
      return lines.length > before && JSON.parse(lines[before]);
    }, '大肥鱼的原生工具结果');
    assert.equal(results.length, allBoardProjects ? 6 : 3);
    const [catalog, board, schedule, legacy, detail, archive] = results.map(result => {
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content.find(part => part.type === 'text').text);
    });
    assert.equal(catalog.status, 'ok');
    assert.deepEqual(catalog.capabilities.map(({ id, status }) => [id, status]), [
      ['schedule.upcoming', disableSchedule ? 'unavailable' : 'available'], ['task-board.list', disableBoard ? 'unavailable' : 'available'],
    ]);
    assert.equal(board.status, disableBoard ? 'unavailable' : 'ok');
    if (!disableBoard) assert.deepEqual(board.items.map(item => item.title).sort(),
      allBoardProjects ? ['看板-local', '看板-other', '看板-unassigned'] : ['看板-local']);
    assert.equal(schedule.status, disableSchedule ? 'unavailable' : 'ok');
    if (!disableSchedule) {
      assert.deepEqual(schedule.items.map(item => item.title), ['自动化-local']);
      assert.ok(schedule.items[0].nextRunAt);
      assert.ok(!('prompt' in schedule.items[0]));
    }
    if (allBoardProjects) {
      assert.equal(board.readScope, 'all-board-projects');
      assert.equal(legacy.readScope, 'all-board-projects');
      assert.deepEqual(legacy.items.map(item => item.title.text).sort(), ['看板-local', '看板-other', '看板-unassigned']);
      assert.equal(detail.task.title.text, '看板-other');
      assert.equal(detail.text.text, '仅用于验收');
      assert.deepEqual(archive.items.map(item => item.title), ['看板-archived']);
    }
    console.log(allBoardProjects ? '两条看板工具链均读取全部项目和未归属卡片，自动化仍按工作区过滤' : disableBoard ? '看板停用后，大肥鱼仍能读取本工作区自动化' : disableSchedule
      ? '自动化适配器停用后，大肥鱼仍能读取本工作区看板' : '大肥鱼查到看板和自动化，两个来源均排除了另一工作区数据');
    return root;
  } catch (error) {
    if (root) console.error('隔离运行目录 ' + root);
    throw error;
  } finally {
    lab.kill('SIGTERM');
    await closed;
  }
}

const root = await run(undefined, '');
await run(root, 'board');
await run(root, 'schedule');
await run(undefined, '', true);
