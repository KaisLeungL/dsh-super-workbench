import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
test('operator 一个客户端产物装配看板和全部内置界面模块', async () => {
  // Given: 使用真实构建产物与包元数据。
  // When: 解析统一包并检查加载器工厂和导出。
  // Then: 所有功能可达且只有一个客户端所有者。
  const registrations = [];
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: value => registrations.push(value) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@linxin666/dsh-client-ui-task-board');
  const plugin = registrations[0].factory(name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    assert.equal(name, '@deepseek-ai/dsh-client-store');
    return {};
  });
  const children = [];
  plugin.apply({ plugin: child => children.push(child) });
  assert.equal(children.length, 5);
  assert.ok(children.every(child => typeof child.apply === 'function'));
  assert.equal(children[2].NS, 'task-board-github');
  assert.equal(children[3].NS, 'task-board-team');
  assert.deepEqual(Array.from(children[4].inject), ['taskBoard', 'slots', 'locale']);
});

const features = ['inspection', 'github', 'remote', 'team', 'forest'];
test('operator 每个Host子路径可独立解析且不重复声明客户端', async () => {
  // Given: 使用真实构建产物与包元数据。
  // When: 解析统一包并检查加载器工厂和导出。
  // Then: 所有功能可达且只有一个客户端所有者。
  for (const feature of features) {
    const plugin = await import(`@linxin666/dsh-client-ui-task-board/${feature}`);
    assert.equal(typeof plugin.apply, 'function', feature);
    const marker = JSON.parse(await readFile(new URL(`../lib/modules/${feature}/package.json`, import.meta.url), 'utf8'));
    assert.equal(marker.type, 'module');
    assert.equal(marker.dsh, undefined, feature);
    for (const lang of ['zh', 'en']) {
      const metadata = JSON.parse(await readFile(new URL(`../locale/${feature}/${lang}.json`, import.meta.url), 'utf8'));
      assert.ok(metadata.meta.title, `${feature}/${lang}`);
    }
  }
});

test('operator 发行包不依赖旧看板扩展并包含扫描隔离标记', async () => {
  // Given: 使用真实构建产物与包元数据。
  // When: 解析统一包并检查加载器工厂和导出。
  // Then: 所有功能可达且只有一个客户端所有者。
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const old = ['@linxin666/dsh-task-board-inspection', '@linxin666/dsh-client-ui-task-board-github', '@linxin666/dsh-task-board-remote', '@linxin666/dsh-client-ui-task-board-team', '@local/dsh-task-forest'];
  for (const name of old) {
    assert.equal(pkg.dependencies?.[name], undefined);
    assert.equal(pkg.peerDependencies?.[name], undefined);
  }
  assert.ok(pkg.files.includes('lib/modules/*/package.json'));
  assert.equal(pkg.exports['./client'].default, './lib/client.js');
});
