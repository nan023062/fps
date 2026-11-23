import { vec3 } from '../core/math';
import type { LevelBox, LevelDefinition, NavNode, SurfaceKind } from './level';

function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  kind: SurfaceKind,
  role: LevelBox['role'],
  tone = 1,
  label?: string,
): LevelBox {
  return { min: vec3(minX, minY, minZ), max: vec3(maxX, maxY, maxZ), kind, role, tone, label };
}

function node(x: number, z: number, links: number[]): NavNode {
  return { pos: vec3(x, 0, z), links };
}

/**
 * 示例关卡：红岩要塞。
 *
 * 这张图只提供数据（盒体 / 出生点 / 导航图 / 主题 / 光照），
 * 战斗代码（碰撞、射线、命中、回合）不区分关卡，因此接入新关卡不需要修改 src/game、src/combat、src/ai。
 */
export const REDOUBT_LEVEL: LevelDefinition = {
  id: 'redoubt',
  name: '红岩要塞',
  subtitle: '示例关卡 · 黄昏红岩与拱门庭院',
  boxes: [
    box(-30, -1, -30, 30, 0, 30, 'sand', 'ground', 0.96, '红岩沙地'),

    box(-23, 0, -24, 23, 8, -22, 'wall', 'wall', 1.0, '北墙'),
    box(-23, 0, 22, 23, 8, 24, 'wall', 'wall', 1.04, '南墙'),
    box(-24, 0, -22, -22, 8, 22, 'wall', 'wall', 0.98, '西墙'),
    box(22, 0, -22, 24, 8, 22, 'wall', 'wall', 1.02, '东墙'),

    // 中央拱门（立柱 + 过梁，可从下方通过）
    box(-4, 0, -1, -2.5, 5, 1, 'stone', 'pillar', 1.06, '拱门柱'),
    box(2.5, 0, -1, 4, 5, 1, 'stone', 'pillar', 1.06, '拱门柱'),
    box(-4, 5, -1, 4, 6.2, 1, 'stone', 'lintel', 1.0, '拱门过梁'),

    // 侧翼高台
    box(-21, 0, -10, -16, 1.8, -2, 'stone', 'block', 1.02, '西高台'),
    box(16, 0, 2, 21, 1.8, 10, 'stone', 'block', 1.0, '东高台'),

    // 角落木箱堆
    box(14, 0, 14, 17, 2, 17, 'crate', 'crate', 1.04, '木箱堆'),
    box(-17, 0, 14, -14, 2, 17, 'crate', 'crate', 0.98, '木箱堆'),
    box(-17, 0, -17, -14, 2, -14, 'crate', 'crate', 1.0, '木箱堆'),
    box(14, 0, -17, 17, 2, -14, 'crate', 'crate', 1.02, '木箱堆'),

    // 中路沙袋与残骸
    box(-10, 0, 6, -4, 1, 7, 'sandbag', 'sandbag', 1.0, '沙袋'),
    box(4, 0, -7, 10, 1, -6, 'sandbag', 'sandbag', 1.0, '沙袋'),
    box(6, 0, 10, 10, 1.7, 12.5, 'metal', 'wreck', 1.0, '残骸'),

    // 西侧围栏
    box(-21.5, 0, -14, -21.2, 1.4, -6, 'metal', 'fence', 1.0, '围栏'),

    // 立柱
    box(-8, 0, -3, -7, 4, -2, 'stone', 'pillar', 1.04, '立柱'),
    box(7, 0, 2, 8, 4, 3, 'stone', 'pillar', 1.04, '立柱'),
  ],
  spawns: {
    ct: [
      { pos: vec3(-12, 0, 18), yaw: 0 },
      { pos: vec3(0, 0, 18), yaw: 0 },
      { pos: vec3(12, 0, 18), yaw: 0 },
    ],
    t: [
      { pos: vec3(-12, 0, -18), yaw: Math.PI },
      { pos: vec3(0, 0, -18), yaw: Math.PI },
      { pos: vec3(12, 0, -18), yaw: Math.PI },
    ],
  },
  navNodes: [
    node(-18, 17, [1]),
    node(-4, 16, [0, 2, 5]),
    node(4, 16, [1, 3, 7]),
    node(10, 17, [2]),
    node(18, 14, [3, 8]),
    node(-6, 10, [1, 6, 9]),
    node(0, 8, [5, 7, 9, 11]),
    node(4, 11, [2, 6, 13]),
    node(18, -2, [4, 13]),
    node(-12, 2, [5, 10, 11, 14]),
    node(-5, 0, [9, 11]),
    node(0, 2, [6, 9, 10, 12]),
    node(5, 0, [11, 13]),
    node(12, 2, [7, 8, 12, 15]),
    node(-18, -14, [9, 15, 19]),
    node(-6, -10, [14, 16, 19]),
    node(0, -10, [15, 17, 20]),
    node(6, -10, [16, 18, 21]),
    node(18, -8, [17, 22]),
    node(-14, -18, [14, 15, 20]),
    node(-4, -18, [16, 19, 21]),
    node(4, -18, [17, 20, 22]),
    node(14, -18, [18, 21]),
    // CT 左侧出生点专用节点（与最近的两个节点双向相连，避免出生点离开导航图）
    node(-12, 18, [0, 1]),
  ],
  theme: {
    name: 'red-rock-dusk',
    surfaces: {
      sand: { color: 0xc9a27a, roughness: 1, metalness: 0, pattern: 'sand' },
      stone: { color: 0xa57856, roughness: 0.92, metalness: 0.02, pattern: 'stone' },
      wall: { color: 0x9c6f50, roughness: 0.93, metalness: 0.01, pattern: 'stone' },
      crate: { color: 0x7b5738, roughness: 0.86, metalness: 0.03, pattern: 'wood' },
      metal: { color: 0x64584e, roughness: 0.6, metalness: 0.5, pattern: 'metal' },
      roof: { color: 0x7d6047, roughness: 0.9, metalness: 0.02, pattern: 'concrete' },
      plaster: { color: 0xb28e6c, roughness: 0.94, metalness: 0, pattern: 'concrete' },
      sandbag: { color: 0x9c8564, roughness: 0.95, metalness: 0, pattern: 'cloth' },
      wood: { color: 0x60402a, roughness: 0.9, metalness: 0.02, pattern: 'wood' },
      rubble: { color: 0x8b7357, roughness: 0.96, metalness: 0, pattern: 'concrete' },
    },
    horizon: {
      ground: 0xbf9268,
      dune: 0xb2805c,
      ridge: 0x8e6146,
      haze: 0xe0b58c,
    },
    accent: {
      ct: 0x35506f,
      t: 0x8a5a32,
    },
  },
  lighting: {
    preset: 'redoubt-dusk',
    sun: { azimuth: 250, elevation: 17, color: 0xffb46a, intensity: 2.3 },
    sky: {
      turbidity: 8,
      rayleigh: 3.1,
      mieCoefficient: 0.008,
      mieDirectionalG: 0.86,
      skyIntensity: 0.3,
      cloudCoverage: 0.42,
      cloudDensity: 0.42,
      cloudElevation: 0.42,
    },
    ambient: {
      skyColor: 0xa8bcd8,
      groundColor: 0x6d4f38,
      intensity: 0.32,
      envIntensity: 0.68,
    },
    fog: { color: 0xd9ab84, near: 40, far: 185 },
    exposure: 0.92,
    shadow: { radius: 4, bias: -0.0005, normalBias: 0.035 },
  },
  decor: { dunes: 11, mesas: 16, banners: 3 },
};

export default REDOUBT_LEVEL;
