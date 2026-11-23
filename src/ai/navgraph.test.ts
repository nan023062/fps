import { describe, expect, it } from 'vitest';
import { createNavGraph, spawnNavDistance } from './navgraph';
import { DUST_LEVEL } from '../world/map';
import { REDOUBT_LEVEL } from '../world/level_redoubt';
import type { LevelDefinition } from '../world/level';

const LEVELS: LevelDefinition[] = [DUST_LEVEL, REDOUBT_LEVEL];

describe.each(LEVELS)('NavGraph 注入（$id）', (level) => {
  it('builds one node per level nav node', () => {
    const graph = createNavGraph(level);
    expect(graph.nodes).toHaveLength(level.navNodes.length);
  });

  it('finds the nearest node to each spawn', () => {
    const graph = createNavGraph(level);
    for (const team of ['ct', 't'] as const) {
      for (const spawn of level.spawns[team]) {
        const index = graph.nearest(spawn.pos);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(level.navNodes.length);
        const node = graph.nodePosition(index);
        expect(Math.hypot(node.x - spawn.pos.x, node.z - spawn.pos.z)).toBeLessThanOrEqual(5);
      }
    }
    expect(spawnNavDistance(level, 'ct')).toBeLessThanOrEqual(5);
  });

  it('finds a connected path from the CT side to the T side', () => {
    const graph = createNavGraph(level);
    const from = graph.nearest(level.spawns.ct[0].pos);
    const to = graph.nearest(level.spawns.t[0].pos);
    const path = graph.findPath(from, to);
    expect(path.length).toBeGreaterThan(1);
    expect(path[0]).toBe(from);
    expect(path[path.length - 1]).toBe(to);
    // 相邻节点必须真的连边，避免返回“跳点”路径。
    for (let i = 0; i < path.length - 1; i += 1) {
      const a = path[i];
      const b = path[i + 1];
      const connected = level.navNodes[a].links.includes(b) || level.navNodes[b].links.includes(a);
      expect(connected).toBe(true);
    }
  });

  it('gives each team a patrol pool dedicated to the enemy side', () => {
    const graph = createNavGraph(level);
    for (const team of ['ct', 't'] as const) {
      const pool = graph.patrolNodes(team);
      expect(pool.length).toBeGreaterThan(0);
      expect(pool.length).toBeLessThanOrEqual(level.navNodes.length);
      for (const index of pool) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(level.navNodes.length);
      }
    }
    expect(graph.patrolNodes('ct')).not.toEqual(graph.patrolNodes('t'));
  });
});

describe('NavGraph 边界', () => {
  it('degrades safely with an empty graph', () => {
    const empty: LevelDefinition = { ...REDOUBT_LEVEL, navNodes: [] };
    const graph = createNavGraph(empty);
    expect(graph.nearest({ x: 0, y: 0, z: 0 })).toBe(-1);
    expect(graph.findPath(-1, 0)).toEqual([]);
    expect(graph.patrolNodes('ct')).toEqual([]);
  });

  it('rejects out-of-range path queries', () => {
    const graph = createNavGraph(DUST_LEVEL);
    expect(graph.findPath(0, 999)).toEqual([]);
    expect(graph.findPath(-1, 0)).toEqual([]);
    expect(graph.findPath(3, 3)).toEqual([3]);
  });

  it('does not mutate the injected level nav links', () => {
    const snapshot = DUST_LEVEL.navNodes.map((node) => node.links.join(','));
    const graph = createNavGraph(DUST_LEVEL);
    graph.findPath(0, 21);
    expect(DUST_LEVEL.navNodes.map((node) => node.links.join(','))).toEqual(snapshot);
  });
});
