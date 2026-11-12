import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TREE_ASSETS, PLANTING_SLOTS, forestPlacements, treeAssetFor, treePlacement } from '../../../src/modules/forest/client/artwork.js';

test('member 4×4 PNG 网格按素材坐标从后向前种植，树根对齐每格中心', () => {
  // Given: 素材定义的四个地面顶点和 4×4 等分网格。
  const corners = [[768, 230], [276, 476], [1260, 476], [768, 722]];
  // When: 取满岛的格子中心与树木定位。
  const trees = forestPlacements(16);
  // Then: 四角、等分间距与树根锚点均落在实际素材中心。
  assert.deepEqual([trees[0], trees[6], trees[9], trees[15]].map(p => [p.x, p.y]), corners);
  assert.equal(new Set(trees.map(p => `${p.x},${p.y}`)).size, 16);
  for (const p of trees) {
    assert.equal(p.x, 768 + (p.column - p.row) * 164);
    assert.equal(p.y, 148 + (p.row + p.column + 1) * 82);
    assert.ok(Math.abs(p.left + p.width * p.asset.rootAnchor.x - p.x) < 1e-8);
    assert.ok(Math.abs(p.top + p.height * p.asset.rootAnchor.y - p.y) < 1e-8);
  }
});

test('member 空岛、两棵和满岛共用稳定种植位置，增加奖励不重排已有树', () => {
  // Given: 同一座岛从空岛逐步收到 16 个奖励。
  const full = forestPlacements(16, 2);
  // When: 逐个增加已种植数量。
  for (let count = 0; count <= 16; count++) {
    // Then: 每棵已种树保持原位置、树种与深度顺序。
    assert.deepEqual(forestPlacements(count, 2), full.slice(0, count));
  }
  assert.deepEqual(forestPlacements(2).map(p => [p.x, p.y]), [[768, 230], [604, 312]]);
  assert.deepEqual(forestPlacements(24, 2), full);
  assert.equal(PLANTING_SLOTS.length, 16);
});

test('member 跨岛展示使用固定的 20 种树，奖励详情按记录位置取回同一棵树', () => {
  // Given: 原有两种与新增 18 种树，以及第二座岛第 4 个奖励。
  const kinds = Array.from({ length: 20 }, (_, i) => treeAssetFor(Math.floor(i / 16) + 1, i % 16 + 1).id);
  // When: 主岛、缩略图和奖励详情分别取该记录。
  const onIsland = forestPlacements(16, 2).find(p => p.position === 4);
  const inRecord = forestPlacements(1, 2, [4])[0];
  // Then: 新增款全部可达，重读与展示面之间不换树。
  assert.equal(TREE_ASSETS.length, 20);
  assert.equal(new Set(kinds).size, 20);
  assert.equal(treeAssetFor(1, 1).id, 'broadleaf');
  assert.equal(treeAssetFor(1, 2).id, 'conifer');
  assert.equal(treeAssetFor(2, 4).id, 'dragonblood');
  assert.deepEqual(inRecord, onIsland);
  assert.deepEqual(treePlacement(2, 4), onIsland);
  assert.equal(treeAssetFor(2, 5).id, 'broadleaf');
});

test('member 岛屿、网格与全部树种交付真实 RGBA PNG，尺寸与素材清单一致', async () => {
  // Given: 随插件交付的 PNG 与生产素材清单。
  const root = new URL('../../../src/modules/forest/client/assets/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const assets = [manifest.island, manifest.grid, ...manifest.trees];
  const images = [];
  // When: 读取每个实际图片的 PNG 文件头。
  for (const asset of assets) {
    const bytes = await readFile(new URL(asset.file, root));
    images.push(bytes.toString('base64'));
    // Then: 图片存在，含 alpha，尺寸与布局元数据相符。
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), asset.width);
    assert.equal(bytes.readUInt32BE(20), asset.height);
    assert.equal(bytes[25], 6);
  }
  assert.equal(new Set(images).size, 22);
});
