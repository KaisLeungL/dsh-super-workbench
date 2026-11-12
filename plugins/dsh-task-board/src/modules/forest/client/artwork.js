import assets from './assets/manifest.json' with { type: 'json' };

export const ISLAND_WIDTH = 1536;
export const ISLAND_HEIGHT = 1024;
export const TREE_ASSETS = assets.trees;

// 坐标包含岛屿 PNG 的透明留白；顺序由后向前，同深度由左向右。
export const PLANTING_SLOTS = Array.from({ length: 16 }, (_, index) => {
  const row = Math.floor(index / 4), column = index % 4;
  return { row, column, x: 768 + (column - row) * 164, y: 148 + (row + column + 1) * 82 };
}).sort((a, b) => a.y - b.y || a.x - b.x);

// 树种列表只追加；全局种植序号让所有展示面保持同一树种，无须改写奖励账本。
export function treeAssetFor(island = 1, position = 1) {
  return TREE_ASSETS[((island - 1) * 16 + position - 1) % TREE_ASSETS.length];
}

export function treePlacement(island, position) {
  const slot = PLANTING_SLOTS[position - 1];
  const asset = treeAssetFor(island, position);
  const width = ISLAND_WIDTH * 0.17;
  const height = width * asset.height / asset.width;
  return {
    ...slot, asset, position, width, height,
    left: slot.x - width * asset.rootAnchor.x,
    top: slot.y - height * asset.rootAnchor.y,
  };
}

export function forestPlacements(count, island = 1, positions) {
  return (positions ?? Array.from({ length: Math.max(0, Math.min(16, count)) }, (_, i) => i + 1))
    .map(position => treePlacement(island, position))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
