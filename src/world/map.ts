import { vec3, type Vec3 } from '../core/math';
import type { LevelBox, LevelDefinition, NavNode, SurfaceKind } from './level';

export type { SurfaceKind, BoxRole, NavNode, LevelDefinition } from './level';
export type MapBox = LevelBox;

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
 * DUST STRIKE 默认关卡：原创沙漠竞技场。
 * 所有可见几何与碰撞体都来自这一份盒体定义，避免“看得见打不中”。
 * 外圈新增拱门、残骸、围栏、沙袋与掩体，内圈保留原有对枪结构。
 */
export const DUST_LEVEL: LevelDefinition = {
  id: 'dust',
  name: '尘埃竞技场',
  subtitle: '原创沙漠竞技场 · 3v3 回合歼灭',
  boxes: [
    box(-40, -1, -40, 40, 0, 40, 'sand', 'ground', 1, '沙地'),

    // 外围高墙（带倒角与压顶）
    box(-32, 0, -32, 32, 7, -30.4, 'wall', 'wall', 1.0, '北墙'),
    box(-32, 0, 30.4, 32, 7, 32, 'wall', 'wall', 1.02, '南墙'),
    box(-32, 0, -30.4, -30.4, 7, 30.4, 'wall', 'wall', 0.98, '西墙'),
    box(30.4, 0, -30.4, 32, 7, 30.4, 'wall', 'wall', 1.04, '东墙'),

    // 中路矮墙，两端可绕行
    box(-6, 0, -1, 6, 2.2, 1, 'stone', 'cover', 1.0, '中路矮墙'),

    // 四角板条箱
    box(9, 0, 9, 11, 2, 11, 'crate', 'crate', 1.05, '木箱'),
    box(9.25, 2, 9.25, 10.75, 3.4, 10.75, 'crate', 'crate', 0.96, '木箱'),
    box(-11, 0, 9, -9, 2, 11, 'crate', 'crate', 1.0, '木箱'),
    box(9, 0, -11, 11, 2, -9, 'crate', 'crate', 1.02, '木箱'),
    box(-11, 0, -11, -9, 2, -9, 'crate', 'crate', 0.98, '木箱'),

    // 西侧长墙
    box(-19, 0, -11, -17.5, 3.2, 11, 'wall', 'wall', 0.96, '西长墙'),

    // 东侧高台与台阶
    box(16.2, 0, -7, 23, 1.35, 7, 'stone', 'block', 1.04, '东高台'),
    box(14.4, 0, -2, 15, 0.45, 2, 'stone', 'block', 1.0, '台阶'),
    box(15, 0, -2, 15.6, 0.9, 2, 'stone', 'block', 1.0, '台阶'),
    box(15.6, 0, -2, 16.2, 1.35, 2, 'stone', 'block', 1.0, '台阶'),

    // 立柱
    box(-14.5, 0, -4.5, -13.5, 4, -3.5, 'stone', 'pillar', 1.06, '立柱'),
    box(12.5, 0, -4.5, 13.5, 4, -3.5, 'stone', 'pillar', 1.06, '立柱'),

    // 中场掩体
    box(-12, 0, 2, -10, 1.8, 4, 'crate', 'crate', 1.0, '掩体箱'),
    box(10, 0, -4, 12, 1.8, -2, 'crate', 'crate', 1.0, '掩体箱'),

    // 南侧沙袋
    box(-4, 0, 13, 4, 0.9, 14, 'sandbag', 'sandbag', 1.0, '沙袋'),

    // —— 外圈 AAA 装饰与掩体（不在既有导航节点上） ——
    // 北侧拱门：两根立柱 + 过梁，可从中间穿过
    box(-2.4, 0, -27.4, -1.4, 4.2, -26.4, 'stone', 'pillar', 1.08, '拱门柱'),
    box(1.4, 0, -27.4, 2.4, 4.2, -26.4, 'stone', 'pillar', 1.08, '拱门柱'),
    box(-2.4, 4.2, -27.4, 2.4, 5.4, -26.4, 'stone', 'lintel', 1.02, '拱门过梁'),

    // 东侧车辆残骸
    box(26, 0, -14, 29.4, 1.7, -11.4, 'metal', 'wreck', 1.0, '残骸'),

    // 东侧铁丝围栏
    box(29, 0, -24, 29.3, 1.5, -6, 'metal', 'fence', 1.0, '围栏'),

    // 西侧沙袋掩体
    box(-29, 0, -12, -25, 0.95, -9.6, 'sandbag', 'sandbag', 0.98, '沙袋工事'),
    box(-29, 0, 10, -25, 0.95, 12.4, 'sandbag', 'sandbag', 1.02, '沙袋工事'),

    // 东南木箱堆
    box(22, 0, 20, 24, 2, 22, 'crate', 'crate', 1.04, '木箱堆'),
    box(24.05, 0, 20.2, 26, 1.6, 21.8, 'crate', 'crate', 0.98, '木箱堆'),
    box(22.4, 2, 20.4, 23.8, 3.2, 21.6, 'crate', 'crate', 1.02, '木箱堆'),

    // 边缘石制掩体
    box(-29, 0, 22, -25, 1.7, 25, 'stone', 'cover', 1.0, '石掩体'),
    box(12, 0, 26, 16, 1.4, 28, 'stone', 'cover', 0.98, '石掩体'),
  ],
  spawns: {
    ct: [
      { pos: vec3(0, 0, 20), yaw: 0 },
      { pos: vec3(4, 0, 19), yaw: 0 },
      { pos: vec3(-4, 0, 19), yaw: 0 },
    ],
    t: [
      { pos: vec3(0, 0, -20), yaw: Math.PI },
      { pos: vec3(4, 0, -19), yaw: Math.PI },
      { pos: vec3(-4, 0, -19), yaw: Math.PI },
    ],
  },
  navNodes: [
    node(0, 18, [1, 2]),
    node(-8, 14, [0, 3, 5, 6]),
    node(8, 14, [0, 4, 5, 7]),
    node(-14, 14, [1, 8]),
    node(14, 14, [2, 9]),
    node(0, 7, [1, 2, 6, 7, 10]),
    node(-8, 7, [1, 5, 8, 10, 11]),
    node(8, 7, [2, 5, 9, 10, 12]),
    node(-14, 7, [3, 6, 19]),
    node(14, 7, [4, 7, 20]),
    node(0, 3, [5, 6, 7, 11, 12]),
    node(-8, 3, [6, 10, 13, 14]),
    node(8, 3, [7, 10, 13, 15]),
    node(0, -3, [11, 12, 14, 15, 16]),
    node(-8, -3, [11, 13, 16, 17]),
    node(8, -3, [12, 13, 16, 18]),
    node(0, -7, [13, 14, 15, 17, 18]),
    node(-8, -7, [14, 16, 19, 22]),
    node(8, -7, [15, 16, 20, 23]),
    node(-14, -7, [8, 17]),
    node(14, -7, [9, 18]),
    node(0, -14, [22, 23, 24]),
    node(-8, -14, [17, 21]),
    node(8, -14, [18, 21]),
    node(0, -18, [21]),
  ],
  theme: {
    name: 'sunbleached-dust',
    surfaces: {
      sand: { color: 0xd8c08c, roughness: 1, metalness: 0, pattern: 'sand' },
      stone: { color: 0xb6a075, roughness: 0.9, metalness: 0.02, pattern: 'stone' },
      wall: { color: 0xb09a72, roughness: 0.92, metalness: 0.01, pattern: 'stone' },
      crate: { color: 0x8a6234, roughness: 0.85, metalness: 0.03, pattern: 'wood' },
      metal: { color: 0x6f767c, roughness: 0.55, metalness: 0.55, pattern: 'metal' },
      roof: { color: 0x8d7752, roughness: 0.9, metalness: 0.02, pattern: 'concrete' },
      plaster: { color: 0xcfbb96, roughness: 0.93, metalness: 0, pattern: 'concrete' },
      sandbag: { color: 0xb3a077, roughness: 0.95, metalness: 0, pattern: 'cloth' },
      wood: { color: 0x6f4f30, roughness: 0.88, metalness: 0.02, pattern: 'wood' },
      rubble: { color: 0x9c8b6d, roughness: 0.95, metalness: 0, pattern: 'concrete' },
    },
    horizon: {
      ground: 0xd6c49c,
      dune: 0xc9b184,
      ridge: 0xb59d78,
      haze: 0xd7d2c2,
    },
    accent: {
      ct: 0x3f5f86,
      t: 0x8a6a3c,
    },
  },
  lighting: {
    preset: 'dust-noon',
    sun: { azimuth: 138, elevation: 44, color: 0xffeccd, intensity: 2.15 },
    sky: {
      turbidity: 5.2,
      rayleigh: 2.1,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.82,
      skyIntensity: 0.34,
      cloudCoverage: 0.32,
      cloudDensity: 0.35,
      cloudElevation: 0.5,
    },
    ambient: {
      skyColor: 0xbfd6f2,
      groundColor: 0xa48a5f,
      intensity: 0.34,
      envIntensity: 0.75,
    },
    fog: { color: 0xd6c8ab, near: 55, far: 230 },
    exposure: 0.85,
    shadow: { radius: 3, bias: -0.0004, normalBias: 0.03 },
  },
  decor: { dunes: 16, mesas: 12, banners: 4 },
};

/** 兼容旧接口：碰撞层仍然只认这一份盒体。 */
export const MAP_BOXES: MapBox[] = DUST_LEVEL.boxes;
export const CT_SPAWNS: Vec3[] = DUST_LEVEL.spawns.ct.map((spawn) => ({ ...spawn.pos }));
export const T_SPAWNS: Vec3[] = DUST_LEVEL.spawns.t.map((spawn) => ({ ...spawn.pos }));
export const NAV_NODES: NavNode[] = DUST_LEVEL.navNodes;

export const NAV_LINKS: number[][] = NAV_NODES.map((n) => n.links.slice());

for (let i = 0; i < NAV_LINKS.length; i += 1) {
  for (const j of NAV_LINKS[i]) {
    if (!NAV_LINKS[j].includes(i)) {
      NAV_LINKS[j].push(i);
    }
  }
}

export function nearestNavNode(pos: Vec3): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < NAV_NODES.length; i += 1) {
    const n = NAV_NODES[i].pos;
    const dx = n.x - pos.x;
    const dz = n.z - pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export function findPath(from: number, to: number): number[] {
  if (from === to) return [to];
  const prev = new Array<number>(NAV_NODES.length).fill(-1);
  const seen = new Array<boolean>(NAV_NODES.length).fill(false);
  const queue: number[] = [from];
  seen[from] = true;
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (current === to) break;
    for (const next of NAV_LINKS[current]) {
      if (!seen[next]) {
        seen[next] = true;
        prev[next] = current;
        queue.push(next);
      }
    }
  }
  if (!seen[to]) return [];
  const path: number[] = [to];
  let cursor = to;
  while (cursor !== from) {
    cursor = prev[cursor];
    if (cursor < 0) return [];
    path.push(cursor);
  }
  path.reverse();
  return path;
}
