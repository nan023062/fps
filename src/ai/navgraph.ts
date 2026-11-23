import { distanceXZ, type Vec3 } from '../core/math';
import type { Team } from '../game/types';
import { navNeighbours, type LevelDefinition, type NavNode } from '../world/level';

/**
 * 注入式导航图。
 *
 * Bot 只依赖这个接口，不再 import 任何一张地图的模块级常量：
 * 关卡数据由 Match 从 LevelDefinition 派生后注入，换关卡不需要改 Bot 或战斗代码。
 */
export interface NavGraph {
  readonly nodes: readonly NavNode[];
  /** 距离给定位置最近的节点下标（图为空时返回 -1）。 */
  nearest(pos: Vec3): number;
  /** 沿导航图做 BFS 寻路，返回含起点与终点的下标序列；不可达返回空数组。 */
  findPath(from: number, to: number): number[];
  /** 该队伍的推进目标节点池（朝敌方出生点一侧），供 Bot 随机巡点。 */
  patrolNodes(team: Team): number[];
  nodePosition(index: number): Vec3;
}

interface Point2 {
  x: number;
  z: number;
}

function centroid(points: Point2[]): Point2 {
  if (points.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const point of points) {
    x += point.x;
    z += point.z;
  }
  return { x: x / points.length, z: z / points.length };
}

function nearestIndex(nodes: readonly NavNode[], pos: Vec3): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const dx = nodes[i].pos.x - pos.x;
    const dz = nodes[i].pos.z - pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * 巡逻池不写下标常量：按“离敌方出生点更近”筛出推进方向的节点，
 * 这样 dust（25 节点）与 redoubt（25 节点但布局不同）都能得到合理的目标集。
 */
function buildPatrolPool(
  nodes: readonly NavNode[],
  own: Point2,
  enemy: Point2,
): number[] {
  const pool: number[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const pos = nodes[i].pos;
    const toEnemy = Math.hypot(pos.x - enemy.x, pos.z - enemy.z);
    const toOwn = Math.hypot(pos.x - own.x, pos.z - own.z);
    if (toEnemy < toOwn) pool.push(i);
  }
  if (pool.length === 0) return nodes.map((_, index) => index);
  return pool;
}

export function createNavGraph(level: LevelDefinition): NavGraph {
  const nodes = level.navNodes;
  const links = navNeighbours(nodes);
  const ctAnchor = centroid(level.spawns.ct.map((spawn) => ({ x: spawn.pos.x, z: spawn.pos.z })));
  const tAnchor = centroid(level.spawns.t.map((spawn) => ({ x: spawn.pos.x, z: spawn.pos.z })));
  const patrol: Record<Team, number[]> = {
    ct: buildPatrolPool(nodes, ctAnchor, tAnchor),
    t: buildPatrolPool(nodes, tAnchor, ctAnchor),
  };

  return {
    nodes,
    nearest(pos: Vec3): number {
      return nearestIndex(nodes, pos);
    },
    findPath(from: number, to: number): number[] {
      if (from === to) return from >= 0 && from < nodes.length ? [to] : [];
      if (from < 0 || to < 0 || from >= nodes.length || to >= nodes.length) return [];
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
    },
    patrolNodes(team: Team): number[] {
      return patrol[team];
    },
    nodePosition(index: number): Vec3 {
      return nodes[index].pos;
    },
  };
}

/** 关卡出生点到最近节点的大致距离，用于调试与测试。 */
export function spawnNavDistance(level: LevelDefinition, team: Team): number {
  const graph = createNavGraph(level);
  let worst = 0;
  for (const spawn of level.spawns[team]) {
    const index = graph.nearest(spawn.pos);
    if (index < 0) return Infinity;
    worst = Math.max(worst, distanceXZ(spawn.pos, graph.nodePosition(index)));
  }
  return worst;
}
