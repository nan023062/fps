import { vec3, type Aabb, type Vec3 } from '../core/math';
import { Arena } from './arena';
import { DEFAULT_QUALITY, type QualityLevel } from './quality';

/**
 * 关卡契约。
 *
 * 一张地图 = 一份 LevelDefinition：盒体（可见几何与碰撞体共用）、出生点、导航图、
 * 材质主题与光照预设。战斗层只依赖 WorldCollider 的 AABB/射线接口，因此新增关卡
 * 不需要改动 src/game、src/combat、src/ai。
 */

export type SurfaceKind =
  | 'sand'
  | 'stone'
  | 'wall'
  | 'crate'
  | 'metal'
  | 'roof'
  | 'plaster'
  | 'sandbag'
  | 'wood'
  | 'rubble';

/** 盒体的视觉角色；渲染层据此选择程序化造型，碰撞体仍然只是这个 AABB。 */
export type BoxRole =
  | 'ground'
  | 'wall'
  | 'block'
  | 'pillar'
  | 'lintel'
  | 'crate'
  | 'cover'
  | 'sandbag'
  | 'fence'
  | 'wreck';

export interface LevelBox extends Aabb {
  kind: SurfaceKind;
  role?: BoxRole;
  /** 0.85–1.15 的亮度微调，让成组的墙体/箱子不显得复制粘贴。 */
  tone?: number;
  label?: string;
}

export interface NavNode {
  pos: Vec3;
  links: number[];
}

export interface LevelSpawn {
  pos: Vec3;
  yaw: number;
}

export type SurfacePattern = 'sand' | 'stone' | 'concrete' | 'wood' | 'metal' | 'cloth' | 'none';

export interface SurfaceStyle {
  color: number;
  roughness: number;
  metalness: number;
  pattern: SurfacePattern;
}

export interface LevelTheme {
  name: string;
  surfaces: Record<SurfaceKind, SurfaceStyle>;
  horizon: {
    ground: number;
    dune: number;
    ridge: number;
    haze: number;
  };
  accent: {
    ct: number;
    t: number;
  };
}

export interface LevelLighting {
  /** 预设名，只用于调试与报告，不参与渲染逻辑。 */
  preset: string;
  sun: {
    /** 方位角（度），0 = 北（-Z）。 */
    azimuth: number;
    /** 高度角（度）。 */
    elevation: number;
    color: number;
    intensity: number;
  };
  sky: {
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
    /** 天空整体亮度缩放：Sky 着色器输出为物理 HDR，需要压到与场景曝光匹配。 */
    skyIntensity?: number;
    cloudCoverage?: number;
    cloudDensity?: number;
    cloudElevation?: number;
  };
  ambient: {
    skyColor: number;
    groundColor: number;
    intensity: number;
    /** scene.environment（PMREM 天空）强度。 */
    envIntensity: number;
  };
  fog: {
    color: number;
    near: number;
    far: number;
  };
  exposure: number;
  shadow: {
    radius: number;
    bias: number;
    normalBias: number;
  };
}

export interface LevelDecor {
  /** 视角外沙丘数量（非碰撞装饰）。 */
  dunes: number;
  /** 远景岩台数量。 */
  mesas: number;
  /** 旗帜/布幔数量。 */
  banners: number;
}

export interface LevelDefinition {
  id: string;
  name: string;
  subtitle: string;
  boxes: LevelBox[];
  spawns: {
    ct: LevelSpawn[];
    t: LevelSpawn[];
  };
  navNodes: NavNode[];
  theme: LevelTheme;
  lighting: LevelLighting;
  decor: LevelDecor;
}

export interface ArenaOptions {
  container?: HTMLElement;
  quality?: QualityLevel;
  /** 关闭后处理，用于自动化验证或极弱设备。 */
  disablePost?: boolean;
}

/** 盒体中心与尺寸，渲染层用它生成可见几何（与碰撞体严格同源）。 */
export function boxCenter(box: Aabb): Vec3 {
  return {
    x: (box.min.x + box.max.x) * 0.5,
    y: (box.min.y + box.max.y) * 0.5,
    z: (box.min.z + box.max.z) * 0.5,
  };
}

export function boxSize(box: Aabb): Vec3 {
  return {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z,
  };
}

export function levelBoxes(level: LevelDefinition): LevelBox[] {
  return level.boxes;
}

/** 碰撞体与可见几何来自同一份盒体数组，这里只是把它交给 WorldCollider。 */
export function colliderBoxes(level: LevelDefinition): Aabb[] {
  return level.boxes;
}

export function levelBounds(level: LevelDefinition): Aabb {
  const min = vec3(Infinity, Infinity, Infinity);
  const max = vec3(-Infinity, -Infinity, -Infinity);
  for (const box of level.boxes) {
    min.x = Math.min(min.x, box.min.x);
    min.y = Math.min(min.y, box.min.y);
    min.z = Math.min(min.z, box.min.z);
    max.x = Math.max(max.x, box.max.x);
    max.y = Math.max(max.y, box.max.y);
    max.z = Math.max(max.z, box.max.z);
  }
  if (!Number.isFinite(min.x)) {
    return { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
  }
  return { min, max };
}

export function defaultSpawn(level: LevelDefinition, team: 'ct' | 't'): LevelSpawn {
  const list = level.spawns[team];
  return list[0] ?? { pos: vec3(0, 0, 0), yaw: 0 };
}

/** 导航图边默认双向：关卡数据只写一侧，查询时补齐。 */
export function navNeighbours(nodes: NavNode[]): number[][] {
  const links: number[][] = nodes.map((node) => node.links.filter((i) => i >= 0 && i < nodes.length));
  for (let i = 0; i < links.length; i += 1) {
    for (const j of links[i]) {
      if (j !== i && !links[j].includes(i)) links[j].push(i);
    }
  }
  return links;
}

export function nearestNavNodeIn(nodes: NavNode[], pos: Vec3): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i].pos;
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

export function findPathIn(nodes: NavNode[], from: number, to: number): number[] {
  if (from === to) return [to];
  if (from < 0 || to < 0 || from >= nodes.length || to >= nodes.length) return [];
  const links = navNeighbours(nodes);
  const prev = new Array<number>(nodes.length).fill(-1);
  const seen = new Array<boolean>(nodes.length).fill(false);
  const queue: number[] = [from];
  seen[from] = true;
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (current === to) break;
    for (const next of links[current]) {
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

function overlapsSolid(boxes: LevelBox[], point: Vec3, radius: number, feet: number, head: number): boolean {
  for (const box of boxes) {
    if (
      point.x + radius > box.min.x &&
      point.x - radius < box.max.x &&
      point.z + radius > box.min.z &&
      point.z - radius < box.max.z &&
      feet + head > box.min.y &&
      feet < box.max.y
    ) {
      return true;
    }
  }
  return false;
}

/** 某个 XZ 位置下方可站立的地面高度（只看顶面不高于脚底的盒体）。 */
function supportHeight(boxes: LevelBox[], point: Vec3, radius: number): number {
  let floor = -Infinity;
  for (const box of boxes) {
    if (
      point.x + radius > box.min.x &&
      point.x - radius < box.max.x &&
      point.z + radius > box.min.z &&
      point.z - radius < box.max.z &&
      box.max.y <= point.y + 0.25 &&
      box.max.y > floor
    ) {
      floor = box.max.y;
    }
  }
  return floor;
}

function insideBounds(bounds: Aabb, point: Vec3, margin = 0): boolean {
  return (
    point.x >= bounds.min.x + margin &&
    point.x <= bounds.max.x - margin &&
    point.z >= bounds.min.z + margin &&
    point.z <= bounds.max.z - margin
  );
}

function isFiniteVec(point: Vec3): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

/** 结构化校验：新增关卡接入前用同一份规则检查，避免“看得见打不中”。 */
export function validateLevel(level: LevelDefinition): string[] {
  const issues: string[] = [];
  if (!level.id.trim()) issues.push('id 不能为空');
  if (!level.name.trim()) issues.push('name 不能为空');
  if (level.boxes.length === 0) issues.push('boxes 不能为空');

  for (let i = 0; i < level.boxes.length; i += 1) {
    const box = level.boxes[i];
    if (box.max.x - box.min.x <= 0 || box.max.y - box.min.y <= 0 || box.max.z - box.min.z <= 0) {
      issues.push(`boxes[${i}] 尺寸必须为正`);
    }
    if (!isFiniteVec(box.min) || !isFiniteVec(box.max)) issues.push(`boxes[${i}] 坐标必须是有限值`);
    const style = level.theme.surfaces[box.kind];
    if (!style) issues.push(`boxes[${i}] 的 kind=${box.kind} 缺少主题材质`);
  }
  if (!level.theme.surfaces.sand) issues.push('主题缺少 sand 材质');

  const bounds = levelBounds(level);
  const seenSpawns = new Map<string, string>();
  for (const team of ['ct', 't'] as const) {
    const spawns = level.spawns[team];
    if (spawns.length === 0) issues.push(`${team} 出生点不能为空`);
    spawns.forEach((spawn, index) => {
      const tag = `${team} 出生点[${index}]`;
      if (!isFiniteVec(spawn.pos) || !Number.isFinite(spawn.yaw)) {
        issues.push(`${tag} 坐标或朝向非法`);
        return;
      }
      if (!insideBounds(bounds, spawn.pos)) issues.push(`${tag} 位于关卡范围外`);
      if (overlapsSolid(level.boxes, spawn.pos, 0.38, spawn.pos.y + 0.05, 1.75)) {
        issues.push(`${tag} 位于实体盒体内`);
      }
      const floor = supportHeight(level.boxes, spawn.pos, 0.38);
      if (!Number.isFinite(floor)) issues.push(`${tag} 下方没有地面`);
      else if (Math.abs(spawn.pos.y - floor) > 0.25) {
        issues.push(`${tag} 离地 ${(spawn.pos.y - floor).toFixed(2)}m（悬空或陷入地面）`);
      }
      const key = `${spawn.pos.x.toFixed(1)}:${spawn.pos.z.toFixed(1)}`;
      const other = seenSpawns.get(key);
      if (other) issues.push(`${tag} 与 ${other} 重叠`);
      else seenSpawns.set(key, tag);
    });
  }

  if (level.navNodes.length === 0) issues.push('navNodes 不能为空');
  level.navNodes.forEach((node, index) => {
    for (const link of node.links) {
      if (link === index) issues.push(`navNodes[${index}] 不能连接自身`);
      else if (link < 0 || link >= level.navNodes.length) {
        issues.push(`navNodes[${index}] 的链接 ${link} 越界`);
      }
    }
    if (!isFiniteVec(node.pos)) {
      issues.push(`navNodes[${index}] 坐标非法`);
      return;
    }
    if (!insideBounds(bounds, node.pos)) issues.push(`navNodes[${index}] 位于关卡范围外`);
    if (overlapsSolid(level.boxes, node.pos, 0.3, node.pos.y + 0.5, 1.3)) {
      issues.push(`navNodes[${index}] 位于实体盒体内`);
    }
    const floor = supportHeight(level.boxes, node.pos, 0.3);
    if (!Number.isFinite(floor)) issues.push(`navNodes[${index}] 下方没有地面`);
    else if (Math.abs(node.pos.y - floor) > 0.25) {
      issues.push(`navNodes[${index}] 离地 ${(node.pos.y - floor).toFixed(2)}m`);
    }
  });

  // 导航图连通性：Bot 只能沿图走，孤立节点会让寻路静默失败。
  if (level.navNodes.length > 0) {
    const links = navNeighbours(level.navNodes);
    const seen = new Array<boolean>(level.navNodes.length).fill(false);
    const queue = [0];
    seen[0] = true;
    while (queue.length > 0) {
      const current = queue.shift() as number;
      for (const next of links[current]) {
        if (!seen[next]) {
          seen[next] = true;
          queue.push(next);
        }
      }
    }
    const unreachable = seen.map((ok, index) => (ok ? -1 : index)).filter((index) => index >= 0);
    if (unreachable.length > 0) {
      issues.push(`navNodes 存在不可达节点：${unreachable.slice(0, 8).join(', ')}`);
    }

    // 出生点必须靠近导航图，否则 Bot 从出生点出发就会走盲区。
    for (const team of ['ct', 't'] as const) {
      level.spawns[team].forEach((spawn, index) => {
        const node = level.navNodes[nearestNavNodeIn(level.navNodes, spawn.pos)];
        const distance = Math.hypot(node.pos.x - spawn.pos.x, node.pos.z - spawn.pos.z);
        if (distance > 5) {
          issues.push(`${team} 出生点[${index}] 距离最近导航节点 ${distance.toFixed(1)}m（应 ≤ 5m）`);
        }
      });
    }
  }

  for (const [key, style] of Object.entries(level.theme.surfaces)) {
    if (!Number.isFinite(style.color) || !Number.isFinite(style.roughness)) {
      issues.push(`主题材质 ${key} 数值非法`);
    }
  }
  return issues;
}

function defaultContainer(): HTMLElement {
  const app = typeof document !== 'undefined' ? document.getElementById('app') : null;
  if (app) return app;
  if (typeof document !== 'undefined' && document.body) return document.body;
  throw new Error('createArena 需要可用的 DOM 容器');
}

/**
 * 关卡 → 竞技场。关卡只提供数据，战斗代码（命中判定、Bot 寻路、回合规则）保持原样。
 */
export function createArena(level: LevelDefinition, options: ArenaOptions = {}): Arena {
  return new Arena(options.container ?? defaultContainer(), level, {
    quality: options.quality ?? DEFAULT_QUALITY,
    disablePost: options.disablePost,
  });
}
