import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { capsuleBetween, part, roundedBox, type PartSpec } from './geometry';
import { buildWeaponModel, type WeaponModel } from './weapon';
import type { HumanJoint } from '../character/rig';
import { jointIndex, type Skeleton } from '../engine/anim';
import type { CharacterTeam, CharacterWeaponId } from '../character/state';

/**
 * 程序化角色：分段躯干、四肢、头盔、护具与背包。
 *
 * 与旧实现的关键差异：零件不再整体烘焙成一个静态 Group，而是按“所属骨骼”
 * 做**刚性蒙皮**——同一材质的零件仍然合并成一个 SkinnedMesh（draw call 只按材质数算），
 * 但每个顶点带 1.0 权重绑定到对应骨骼，因此可以按 E1 Pose 逐帧动画。
 * 这样在保留全部视觉细节的同时，单角色仍然只有 9 个网格 + 武器网格。
 */

export type { CharacterTeam } from '../character/state';

interface CharacterPalette {
  fabric: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  strap: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
  boot: THREE.MeshStandardMaterial;
  visor: THREE.MeshPhysicalMaterial;
  metal: THREE.MeshStandardMaterial;
}

const paletteCache = new Map<string, CharacterPalette>();

/**
 * 程序化表面纹理：用 DataTexture 生成，不依赖 DOM（Node 里的 vitest 也能构建角色），
 * 同一贴图在浏览器与测试环境中完全一致。
 *
 * 纹理只走 uv 通道：toSkinnedGeometry 合并时只保留 position/normal/uv，
 * 因此 map / roughnessMap / bumpMap 都能安全保留，而 normalMap（需要 tangent）不使用。
 * 贴图按「种类 + 平铺次数 + 用途」缓存，跨角色共享，不随单个模型 dispose 释放。
 */
type SurfaceKind = 'weave' | 'leather' | 'rubber' | 'brushed' | 'paint' | 'skin' | 'glass';

const surfaceTextureCache = new Map<string, THREE.DataTexture>();

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function noiseField(rand: () => number, cells: number): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i += 1) grid[i] = rand();
  return grid;
}

/** 双线性 + smoothstep 插值的值噪声，用于织物/皮革的低频起伏。 */
function sampleField(grid: Float32Array, cells: number, u: number, v: number): number {
  const x = u * cells;
  const y = v * cells;
  const xf = Math.floor(x);
  const yf = Math.floor(y);
  const x0 = ((xf % cells) + cells) % cells;
  const y0 = ((yf % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const fx = x - xf;
  const fy = y - yf;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = grid[y0 * cells + x0] + (grid[y0 * cells + x1] - grid[y0 * cells + x0]) * sx;
  const bottom = grid[y1 * cells + x0] + (grid[y1 * cells + x1] - grid[y1 * cells + x0]) * sx;
  return top + (bottom - top) * sy;
}

/**
 * 生成表面贴图。
 * - detail：线性数据，同时作为 roughnessMap 与 bumpMap（划痕处更光滑、更凹）。
 * - color：sRGB，作为 map 与材质颜色相乘，制造轻微明暗/磨损差异。
 */
function surfaceTexture(
  kind: SurfaceKind,
  repeat: number,
  mode: 'detail' | 'color',
  size = 128,
): THREE.DataTexture {
  const key = `${mode}:${kind}:${repeat}:${size}`;
  const cached = surfaceTextureCache.get(key);
  if (cached) return cached;

  const rand = seededRandom(hashSeed(key));
  const coarse = noiseField(rand, 8);
  const fine = noiseField(rand, 32);
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const low = sampleField(coarse, 8, u, v);
      const high = sampleField(fine, 32, u, v);
      let value: number;
      if (mode === 'color') {
        // 颜色贴图围绕白色做小幅乘性差异；木质/涂装对比更强。
        const contrast =
          kind === 'paint' ? 0.16 : kind === 'leather' ? 0.14 : kind === 'weave' ? 0.09 : 0.06;
        value = 1 - contrast * (low * 0.6 + high * 0.4);
        if (kind === 'brushed') value -= 0.05 * Math.abs(Math.sin(v * Math.PI * 18));
      } else {
        // 细节贴图：0.6–1.0 的粗糙度/凹凸，划痕在下方叠加。
        switch (kind) {
          case 'weave': {
            const weave = Math.sin(u * Math.PI * 2 * 12) * Math.sin(v * Math.PI * 2 * 12);
            value = 0.82 + weave * 0.05 + (high - 0.5) * 0.12;
            break;
          }
          case 'brushed': {
            const streak = sampleField(fine, 32, u, v * 0.22);
            value = 0.7 + streak * 0.26 + (low - 0.5) * 0.05;
            break;
          }
          case 'leather':
            value = 0.76 + low * 0.14 + (high - 0.5) * 0.2;
            break;
          case 'rubber':
            value = 0.84 + (high - 0.5) * 0.2;
            break;
          case 'paint':
            value = 0.78 + low * 0.16 + (high - 0.5) * 0.12;
            break;
          case 'skin':
            value = 0.83 + low * 0.08 + (high - 0.5) * 0.1;
            break;
          default:
            value = 0.9 + (high - 0.5) * 0.08;
            break;
        }
      }
      const channel = Math.round(Math.max(0, Math.min(1, value)) * 255);
      const index = (y * size + x) * 4;
      data[index] = channel;
      data[index + 1] = channel;
      data[index + 2] = channel;
      data[index + 3] = 255;
    }
  }

  // 划痕：金属/涂装最明显，织物与皮革只有少量磨白。
  const scratchCount =
    kind === 'brushed' || kind === 'paint' ? 24 : kind === 'leather' ? 10 : kind === 'glass' ? 6 : 4;
  const scratchScale = mode === 'color' ? 0.5 : 1;
  for (let s = 0; s < scratchCount; s += 1) {
    let px = Math.floor(rand() * size);
    let py = Math.floor(rand() * size);
    const length = 4 + Math.floor(rand() * (kind === 'brushed' ? 30 : 16));
    const horizontal = kind === 'brushed' ? rand() < 0.8 : rand() < 0.5;
    const delta = (rand() < 0.5 ? -1 : 1) * (0.05 + rand() * 0.14) * scratchScale;
    for (let step = 0; step < length; step += 1) {
      const index = (py * size + px) * 4;
      const next = Math.max(0, Math.min(1, data[index] / 255 + delta));
      data[index] = Math.round(next * 255);
      data[index + 1] = data[index];
      data[index + 2] = data[index];
      if (horizontal) px = (px + 1) % size;
      else py = (py + 1) % size;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = key;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  // 细节贴图是线性数据，颜色贴图按 sRGB 采样。
  texture.colorSpace = mode === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  surfaceTextureCache.set(key, texture);
  return texture;
}

/** 给材质挂上程序化贴图：色彩微差（map）+ 粗糙度（roughnessMap）+ 微凹凸（bumpMap）。 */
function textured(
  material: THREE.MeshStandardMaterial,
  kind: SurfaceKind,
  repeat: number,
  options: { color?: boolean; bump?: number } = {},
): void {
  const detail = surfaceTexture(kind, repeat, 'detail');
  material.roughnessMap = detail;
  if (options.color !== false) material.map = surfaceTexture(kind, repeat, 'color');
  if (options.bump !== undefined) {
    material.bumpMap = detail;
    material.bumpScale = options.bump;
  }
  material.needsUpdate = true;
}

function palette(team: CharacterTeam, accentColor: number): CharacterPalette {
  const key = `${team}:${accentColor}`;
  const cached = paletteCache.get(key);
  if (cached) return cached;
  const fabricColor = team === 'ct' ? 0x3c4854 : 0x6a5a41;
  const plateColor = team === 'ct' ? 0x59636d : 0x7f6c4d;

  const fabric = new THREE.MeshStandardMaterial({
    color: fabricColor,
    roughness: 0.95,
    metalness: 0.02,
  });
  textured(fabric, 'weave', 4, { bump: 0.005 });

  const plate = new THREE.MeshStandardMaterial({
    color: plateColor,
    roughness: 0.66,
    metalness: 0.2,
  });
  textured(plate, 'brushed', 3, { bump: 0.003 });

  const strap = new THREE.MeshStandardMaterial({
    color: 0x2c2d2c,
    roughness: 0.94,
    metalness: 0.06,
  });
  textured(strap, 'leather', 4, { bump: 0.004 });

  const accent = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.7,
    metalness: 0.14,
  });
  textured(accent, 'paint', 3, { bump: 0.002 });

  const skin = new THREE.MeshStandardMaterial({
    color: team === 'ct' ? 0xc7a17b : 0xb08a63,
    roughness: 0.8,
    metalness: 0.0,
  });
  textured(skin, 'skin', 2, { bump: 0.0012 });

  const glove = new THREE.MeshStandardMaterial({
    color: 0x33352f,
    roughness: 0.93,
    metalness: 0.05,
  });
  textured(glove, 'leather', 5, { bump: 0.004 });

  const boot = new THREE.MeshStandardMaterial({
    color: 0x2a2926,
    roughness: 0.96,
    metalness: 0.04,
  });
  textured(boot, 'leather', 5, { bump: 0.005 });

  const visor = new THREE.MeshPhysicalMaterial({
    color: 0x1c2a30,
    roughness: 0.14,
    metalness: 0.55,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  // 面罩只加粗糙度细节（细微擦痕），保留镜面反射与 clearcoat 的干净观感。
  visor.roughnessMap = surfaceTexture('glass', 3, 'detail');
  visor.needsUpdate = true;

  const metal = new THREE.MeshStandardMaterial({
    color: 0x4a4f55,
    roughness: 0.5,
    metalness: 0.78,
  });
  textured(metal, 'brushed', 3, { bump: 0.002 });

  const paletteValue: CharacterPalette = {
    fabric,
    plate,
    strap,
    accent,
    skin,
    glove,
    boot,
    visor,
    metal,
  };
  paletteCache.set(key, paletteValue);
  return paletteValue;
}

export interface CharacterOptions {
  team: CharacterTeam;
  accent: number;
  /** 0–2 的体型/护具变化，让同队 Bot 不完全一样。 */
  variant?: number;
  /** 与 CharacterView 共用的骨架（保证骨骼下标与 Pose 下标一致）。 */
  skeleton: Skeleton;
}

export interface CharacterPerfStats {
  /** 角色躯干/护具/头盔的网格数（= 材质数）。 */
  bodyMeshes: number;
  /** 武器网格数（当前武器）。 */
  weaponMeshes: number;
  /** 没有 InstancedMesh、每网格一次绘制的三角面总数。 */
  triangles: number;
  bodyTriangles: number;
  weaponTriangles: number;
  /** 主渲染通道的粗略 draw call 数（每网格一次）。 */
  drawCalls: number;
  /** 会写入阴影贴图的网格数（只有剪影材质开启，控制阴影 pass 开销）。 */
  shadowCasters: number;
}

export interface CharacterModel {
  group: THREE.Group;
  /** 与 skeleton.joints 同序的 Three 骨骼。 */
  bones: THREE.Bone[];
  /** 渲染用骨架（SkinnedMesh.bind 的宿主）。 */
  threeSkeleton: THREE.Skeleton;
  /** 右手挂点：武器、枪口与特效都挂在这里。 */
  weaponMount: THREE.Object3D;
  weapons: Record<CharacterWeaponId, WeaponModel>;
  bodyMeshes: THREE.Mesh[];
  stats: CharacterPerfStats;
  height: number;
}

interface BoundPart {
  bone: HumanJoint;
  spec: PartSpec;
}

function bound(bone: HumanJoint, spec: PartSpec): BoundPart {
  return { bone, spec };
}

/** 把零件几何转换成带 skinIndex/skinWeight 的非索引几何。 */
function toSkinnedGeometry(spec: PartSpec, boneIndex: number): THREE.BufferGeometry {
  const geometry = spec.geometry.index ? spec.geometry.toNonIndexed() : spec.geometry.clone();
  geometry.applyMatrix4(spec.matrix);
  spec.geometry.dispose();
  const keep = new Set(['position', 'normal', 'uv']);
  for (const name of Object.keys(geometry.attributes)) {
    if (!keep.has(name)) geometry.deleteAttribute(name);
  }
  const position = geometry.getAttribute('position');
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  }
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }
  const count = position.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    skinIndex[i * 4] = boneIndex;
    skinWeight[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  return geometry;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  return position ? Math.floor(position.count / 3) : 0;
}

/** 角色全部零件及其所属骨骼。 */
function characterParts(colors: CharacterPalette, variant: number): BoundPart[] {
  const parts: BoundPart[] = [];
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const shoulderWidth = 0.235 + variant * 0.012;
  const chestDepth = 0.27 + variant * 0.01;
  const hipOffset = 0.11 + variant * 0.004;

  // ── 骨盆：髋部、腰带、腰包 ──────────────────────────────
  parts.push(bound('pelvis', part(roundedBox(0.34, 0.2, 0.25, 0.05, 2), colors.fabric, v(0, 0.94, 0))));
  parts.push(bound('pelvis', part(roundedBox(0.35, 0.06, 0.26, 0.02, 1), colors.strap, v(0, 1.03, 0))));
  for (const side of [-1, 1]) {
    parts.push(bound('pelvis', part(roundedBox(0.1, 0.09, 0.07, 0.02, 1), colors.strap, v(side * 0.14, 1.0, -0.13))));
  }
  parts.push(bound('pelvis', part(roundedBox(0.12, 0.1, 0.06, 0.02, 1), colors.strap, v(0, 0.99, 0.14))));

  // ── 腹部 ────────────────────────────────────────────────
  parts.push(bound('spine', part(roundedBox(0.37, 0.24, 0.24, 0.05, 2), colors.fabric, v(0, 1.14, 0))));
  parts.push(bound('spine', part(roundedBox(0.32, 0.05, 0.28, 0.015, 1), colors.accent, v(0, 1.2, 0))));

  // ── 胸部：护板、弹匣包、背包、天线、领口 ────────────────
  parts.push(bound('chest', part(roundedBox(0.41, 0.3, chestDepth, 0.06, 2), colors.fabric, v(0, 1.34, 0))));
  parts.push(bound('chest', part(
    roundedBox(0.3, 0.27, 0.06, 0.02, 3),
    colors.plate,
    v(0, 1.33, -chestDepth * 0.5 - 0.005),
  )));
  parts.push(bound('chest', part(
    roundedBox(0.3, 0.26, 0.05, 0.02, 2),
    colors.plate,
    v(0, 1.34, chestDepth * 0.5 + 0.01),
  )));
  for (const side of [-1, 0, 1]) {
    parts.push(bound('chest', part(
      roundedBox(0.075, 0.11, 0.05, 0.012, 1),
      colors.strap,
      v(side * 0.09, 1.23, -chestDepth * 0.5 - 0.03),
    )));
  }
  parts.push(bound('chest', part(roundedBox(0.26, 0.3, 0.17, 0.03, 2), colors.strap, v(0, 1.33, 0.24))));
  parts.push(bound('chest', part(roundedBox(0.22, 0.1, 0.05, 0.015, 1), colors.plate, v(0, 1.2, 0.31))));
  for (const side of [-1, 1]) {
    parts.push(bound('chest', part(
      roundedBox(0.045, 0.28, 0.03, 0.01, 1),
      colors.strap,
      v(side * 0.15, 1.36, -chestDepth * 0.5 + 0.02),
    )));
  }
  parts.push(bound('chest', capsuleBetween(
    v(0.09, 1.46, 0.27),
    v(0.11, 1.78, 0.3),
    0.006,
    colors.metal,
    2,
    6,
  )));
  parts.push(bound('chest', part(new THREE.CylinderGeometry(0.055, 0.06, 0.09, 20), colors.skin, v(0, 1.5, 0))));
  parts.push(bound('chest', part(roundedBox(0.2, 0.05, 0.19, 0.02, 1), colors.strap, v(0, 1.5, -0.01))));

  // ── 头部：面罩与头盔 ────────────────────────────────────
  parts.push(bound('head', part(roundedBox(0.19, 0.22, 0.2, 0.06, 3), colors.skin, v(0, 1.63, -0.005))));
  parts.push(bound('head', part(roundedBox(0.17, 0.07, 0.03, 0.012, 1), colors.visor, v(0, 1.65, -0.11))));
  const shellGeo = new THREE.SphereGeometry(0.125, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.58);
  parts.push(bound('head', part(shellGeo, colors.plate, v(0, 1.65, 0), undefined, v(1.05, 0.95, 1.12))));
  parts.push(bound('head', part(roundedBox(0.23, 0.035, 0.25, 0.015, 1), colors.plate, v(0, 1.67, -0.01))));
  for (const side of [-1, 1]) {
    parts.push(bound('head', part(roundedBox(0.02, 0.03, 0.14, 0.008, 1), colors.metal, v(side * 0.115, 1.68, -0.01))));
    parts.push(bound('head', part(roundedBox(0.03, 0.06, 0.06, 0.012, 1), colors.strap, v(side * 0.105, 1.62, 0.02))));
  }
  parts.push(bound('head', part(roundedBox(0.06, 0.05, 0.04, 0.012, 1), colors.metal, v(0, 1.74, -0.09))));
  parts.push(bound('head', part(roundedBox(0.05, 0.02, 0.14, 0.008, 1), colors.accent, v(0, 1.765, 0))));

  // ── 双臂：肩甲、上臂、肘垫、小臂、手套 ──────────────────
  for (const side of [-1, 1] as const) {
    const x = side * shoulderWidth;
    const arm: HumanJoint = side < 0 ? 'upperArmL' : 'upperArmR';
    const fore: HumanJoint = side < 0 ? 'lowerArmL' : 'lowerArmR';
    const hand: HumanJoint = side < 0 ? 'handL' : 'handR';
    parts.push(bound(arm, part(roundedBox(0.15, 0.13, 0.21, 0.04, 2), colors.plate, v(x + side * 0.012, 1.42, 0))));
    parts.push(bound(arm, part(
      roundedBox(0.04, 0.05, 0.06, 0.01, 1),
      colors.accent,
      v(x + side * 0.082, 1.42, 0),
    )));
    parts.push(bound(arm, capsuleBetween(v(x, 1.4, 0), v(x, 1.16, 0), 0.058, colors.fabric, 5, 14)));
    parts.push(bound(fore, part(roundedBox(0.05, 0.06, 0.11, 0.02, 1), colors.plate, v(x, 1.13, -0.03))));
    parts.push(bound(fore, capsuleBetween(v(x, 1.14, 0), v(x, 0.92, 0), 0.05, colors.fabric, 5, 14)));
    parts.push(bound(hand, part(roundedBox(0.075, 0.085, 0.11, 0.03, 2), colors.glove, v(x, 0.895, -0.01))));
  }

  // ── 双腿：大腿、护膝、小腿、靴子 ────────────────────────
  for (const side of [-1, 1] as const) {
    const x = side * hipOffset;
    const thigh: HumanJoint = side < 0 ? 'upperLegL' : 'upperLegR';
    const shin: HumanJoint = side < 0 ? 'lowerLegL' : 'lowerLegR';
    const foot: HumanJoint = side < 0 ? 'footL' : 'footR';
    parts.push(bound(thigh, capsuleBetween(v(x, 0.9, 0), v(x, 0.55, 0), 0.077, colors.fabric, 5, 14)));
    parts.push(bound(thigh, part(roundedBox(0.11, 0.1, 0.16, 0.03, 2), colors.strap, v(x, 0.78, 0.03))));
    parts.push(bound(shin, part(roundedBox(0.13, 0.13, 0.11, 0.03, 2), colors.plate, v(x, 0.51, -0.055))));
    parts.push(bound(shin, capsuleBetween(v(x, 0.5, 0), v(x, 0.16, 0), 0.06, colors.fabric, 5, 14)));
    parts.push(bound(foot, part(roundedBox(0.14, 0.12, 0.27, 0.035, 2), colors.boot, v(x, 0.06, -0.02))));
  }

  return parts;
}

/**
 * 构建可动画分段角色。
 * 所有零件按材质合并成 SkinnedMesh，顶点以刚性权重绑定到各自骨骼。
 */
export function buildCharacterModel(options: CharacterOptions): CharacterModel {
  const colors = palette(options.team, options.accent);
  const variant = options.variant ?? 0;
  const skeleton = options.skeleton;

  const group = new THREE.Group();
  group.name = `character:${options.team}`;

  // 1) 骨骼层级：rest 局部变换来自 E1 骨架定义。
  const bones = skeleton.joints.map((joint) => {
    const bone = new THREE.Bone();
    bone.name = joint.name;
    bone.position.set(joint.local.position.x, joint.local.position.y, joint.local.position.z);
    bone.quaternion.set(
      joint.local.rotation.x,
      joint.local.rotation.y,
      joint.local.rotation.z,
      joint.local.rotation.w,
    );
    bone.scale.set(joint.local.scale.x, joint.local.scale.y, joint.local.scale.z);
    return bone;
  });
  skeleton.joints.forEach((joint, index) => {
    if (joint.parent !== null) {
      bones[joint.parent].add(bones[index]);
    }
  });
  group.add(bones[0]);
  group.updateMatrixWorld(true);

  const boneIndices = new Map<HumanJoint, number>();
  for (const joint of skeleton.joints) {
    boneIndices.set(joint.name as HumanJoint, jointIndex(skeleton, joint.name));
  }

  // 2) 按材质合批 + 逐顶点写骨骼 index/weight。
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const entry of characterParts(colors, variant)) {
    const boneIndex = boneIndices.get(entry.bone);
    if (boneIndex === undefined) {
      throw new Error(`character part bound to unknown bone: ${entry.bone}`);
    }
    const geometry = toSkinnedGeometry(entry.spec, boneIndex);
    const list = buckets.get(entry.spec.material);
    if (list) list.push(geometry);
    else buckets.set(entry.spec.material, [geometry]);
  }

  const threeSkeleton = new THREE.Skeleton(bones);
  const bodyMeshes: THREE.Mesh[] = [];
  let bodyTriangles = 0;
  let shadowCasters = 0;
  const bindMatrix = new THREE.Matrix4();
  // 阴影预算：只有决定剪影的织物/护甲材质写入阴影贴图。
  // 高档下一个角色原本 17 个网格 × 阴影 pass = 17 次 draw call，
  // 只保留 2 个剪影投影后，5 个 Bot 的阴影 pass 从 85 降到 10 次。
  const shadowMaterials = new Set<THREE.Material>([colors.fabric, colors.plate]);
  for (const [material, geometries] of buckets) {
    const merged = mergeNonIndexed(geometries);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.SkinnedMesh(merged, material);
    mesh.name = 'character-body';
    mesh.castShadow = shadowMaterials.has(material);
    mesh.receiveShadow = true;
    mesh.bind(threeSkeleton, bindMatrix);
    // 蒙皮后的包围球会随姿势变化，手动放大避免倒地时被视锥裁剪。
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);
    group.add(mesh);
    bodyMeshes.push(mesh);
    bodyTriangles += triangleCount(merged);
    if (mesh.castShadow) shadowCasters += 1;
  }

  // 3) 右手挂点 + 两把武器（切换只用 visible，不重建几何）。
  // 武器不写阴影：距离远、体积小，投影几乎不可见却要占阴影 pass 的 draw call。
  const weaponMount = new THREE.Object3D();
  weaponMount.name = 'weaponMount';
  const handBone = bones[boneIndices.get('handR') as number];
  handBone.add(weaponMount);
  const weapons: Record<CharacterWeaponId, WeaponModel> = {
    rifle: buildWeaponModel('rifle', false),
    pistol: buildWeaponModel('pistol', false),
  };
  for (const weapon of Object.values(weapons)) {
    weapon.group.visible = false;
    weaponMount.add(weapon.group);
  }
  weapons.rifle.group.visible = true;

  const weaponMeshes = weapons.rifle.group.children.filter((child) => (child as THREE.Mesh).isMesh).length;
  const weaponTriangles = countMeshes(weapons.rifle.group);

  const stats: CharacterPerfStats = {
    bodyMeshes: bodyMeshes.length,
    weaponMeshes,
    triangles: bodyTriangles + weaponTriangles,
    bodyTriangles,
    weaponTriangles,
    drawCalls: bodyMeshes.length + weaponMeshes,
    shadowCasters,
  };

  return {
    group,
    bones,
    threeSkeleton,
    weaponMount,
    weapons,
    bodyMeshes,
    stats,
    height: 1.82,
  };
}

function mergeNonIndexed(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries, false);
  return merged ?? null;
}

function countMeshes(root: THREE.Object3D): number {
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      triangles += triangleCount(mesh.geometry);
    }
  });
  return triangles;
}
