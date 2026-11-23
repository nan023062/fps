import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { resolveShot } from '../combat/combat';
import { WorldCollider } from './collision';
import {
  colliderBoxes,
  findPathIn,
  levelBounds,
  nearestNavNodeIn,
  validateLevel,
  type LevelDefinition,
} from './level';
import { REDOUBT_LEVEL } from './level_redoubt';
import { LEVELS } from './levels';
import { MaterialLibrary } from './materials';
import { DUST_LEVEL } from './map';
import { mergeStaticMeshes, roundedBox } from './geometry';
import { buildLevel } from './props';
import { QUALITY_PRESETS } from './quality';

function colliderFor(level: LevelDefinition): WorldCollider {
  return new WorldCollider(colliderBoxes(level));
}

describe('level contract', () => {
  it('默认关卡与示例关卡都通过结构校验', () => {
    expect(validateLevel(DUST_LEVEL)).toEqual([]);
    expect(validateLevel(REDOUBT_LEVEL)).toEqual([]);
    expect(LEVELS.map((level) => level.id)).toEqual(['dust', 'redoubt']);
  });

  it('碰撞体与可见几何来自同一份盒体数据', () => {
    expect(colliderBoxes(DUST_LEVEL)).toBe(DUST_LEVEL.boxes);
    const materials = new MaterialLibrary(DUST_LEVEL.theme, 1);
    const model = buildLevel(DUST_LEVEL, materials, QUALITY_PRESETS.low);
    // 每个盒体一个局部组，组原点就是盒体中心（合并后零件被烘到根节点，但结构仍在）。
    const groups = model.root.children.filter((child) => (child as THREE.Group).isGroup && child.name === '');
    expect(groups.length).toBeGreaterThanOrEqual(DUST_LEVEL.boxes.length);
    expect(model.detailParts).toBeGreaterThan(DUST_LEVEL.boxes.length);
    // 静态几何合并后，真正提交给渲染器的对象数应明显少于零件数。
    expect(model.meshes).toBeGreaterThan(0);
    expect(model.meshes).toBeLessThan(model.detailParts / 2);
    model.dispose();
    materials.dispose();
  });

  it('静态几何合并保留顶点与阴影分组', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    const geometry = roundedBox(1, 1, 1, 0.05, 1);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const verticesPerBox = flat.getAttribute('position').count;
    let vertices = 0;
    for (let i = 0; i < 4; i += 1) {
      const mesh = new THREE.Mesh(geometry.clone(), material);
      mesh.position.set(i * 2, 0, 0);
      mesh.castShadow = i % 2 === 0;
      mesh.receiveShadow = true;
      vertices += verticesPerBox;
      root.add(mesh);
    }
    if (flat !== geometry) flat.dispose();
    geometry.dispose();
    // 非投影件保持独立，避免合并改变阴影结果
    const result = mergeStaticMeshes(root);
    expect(result.mergedMeshes).toBeGreaterThan(0);
    expect(result.drawObjects).toBeLessThanOrEqual(2);

    let mergedVertices = 0;
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mergedVertices += mesh.geometry.getAttribute('position').count;
    });
    expect(mergedVertices).toBe(vertices);

    const casters = root.children.filter((child) => (child as THREE.Mesh).castShadow).length;
    expect(casters).toBe(1);
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    material.dispose();
  });

  it('示例关卡可直接构建几何与碰撞，无需修改战斗代码', () => {
    const materials = new MaterialLibrary(REDOUBT_LEVEL.theme, 1);
    const model = buildLevel(REDOUBT_LEVEL, materials, QUALITY_PRESETS.low);
    expect(model.detailParts).toBeGreaterThan(REDOUBT_LEVEL.boxes.length);
    model.dispose();
    materials.dispose();

    const collider = colliderFor(REDOUBT_LEVEL);
    const spawn = REDOUBT_LEVEL.spawns.ct[0].pos;
    expect(collider.isFree({ ...spawn }, 0.38, 1.8)).toBe(true);

    // 从出生点朝对面围墙射线：命中距离必须落在场地范围内（可见墙 = 可命中墙）。
    const hit = collider.raycast({ x: spawn.x, y: spawn.y + 1.6, z: spawn.z }, { x: 0, y: 0, z: -1 }, 80);
    expect(hit).not.toBeNull();
    const bounds = levelBounds(REDOUBT_LEVEL);
    expect(hit!.distance).toBeGreaterThan(20);
    expect(hit!.distance).toBeLessThan(bounds.max.z - bounds.min.z);

    // 战斗层的命中求解对任何关卡数据都成立。
    const shot = resolveShot(
      { x: spawn.x, y: spawn.y + 1.6, z: spawn.z },
      { x: 0, y: 0, z: -1 },
      80,
      'player',
      [],
      (origin, dir, maxDist) => collider.raycast(origin, dir, maxDist)?.distance ?? null,
    );
    expect(shot.targetId).toBeNull();
    expect(shot.hitWorld).toBe(true);
  });

  it('两关的出生点都能连到导航图', () => {
    for (const level of LEVELS) {
      const collider = colliderFor(level);
      const ctSpawn = level.spawns.ct[0].pos;
      const tSpawn = level.spawns.t[0].pos;
      expect(collider.isFree({ ...ctSpawn }, 0.38, 1.8)).toBe(true);
      expect(collider.isFree({ ...tSpawn }, 0.38, 1.8)).toBe(true);
      const from = nearestNavNodeIn(level.navNodes, ctSpawn);
      const to = nearestNavNodeIn(level.navNodes, tSpawn);
      const path = findPathIn(level.navNodes, from, to);
      expect(path.length).toBeGreaterThan(1);
    }
  });

  it('导航图自动补齐双向边', () => {
    const asymmetric: LevelDefinition = {
      ...REDOUBT_LEVEL,
      id: 'asymmetric',
      navNodes: [
        { pos: { x: 0, y: 0, z: 0 }, links: [1] },
        { pos: { x: 2, y: 0, z: 0 }, links: [] },
        { pos: { x: 4, y: 0, z: 0 }, links: [] },
      ],
    };
    expect(findPathIn(asymmetric.navNodes, 1, 0)).toEqual([1, 0]);
    expect(findPathIn(asymmetric.navNodes, 0, 2)).toEqual([]);
  });

  it('validateLevel 能抓住悬空出生点、越界导航与不可达节点', () => {
    const broken: LevelDefinition = {
      ...REDOUBT_LEVEL,
      id: 'broken',
      spawns: {
        ct: [{ pos: { x: 0, y: 6, z: 18 }, yaw: 0 }],
        t: [{ pos: { x: 0, y: 0, z: -18 }, yaw: Math.PI }],
      },
      navNodes: [
        { pos: { x: 0, y: 0, z: 18 }, links: [1] },
        { pos: { x: 0, y: 0, z: 0 }, links: [0] },
        { pos: { x: 500, y: 0, z: 500 }, links: [] },
        { pos: { x: 4, y: 0, z: 4 }, links: [3] },
        { pos: { x: 15, y: 0, z: 15 }, links: [] },
      ],
    };
    const issues = validateLevel(broken);
    expect(issues.some((issue) => issue.includes('悬空'))).toBe(true);
    expect(issues.some((issue) => issue.includes('关卡范围外'))).toBe(true);
    expect(issues.some((issue) => issue.includes('不可达节点'))).toBe(true);
    expect(issues.some((issue) => issue.includes('不能连接自身'))).toBe(true);
    expect(issues.some((issue) => issue.includes('位于实体盒体内'))).toBe(true);
  });
});
