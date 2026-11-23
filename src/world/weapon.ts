import * as THREE from 'three';
import { capsuleBetween, mergedModel, part, roundedBox, type PartSpec } from './geometry';

export type WeaponModelId = 'rifle' | 'pistol';

/**
 * 分层程序化武器：机匣、枪管、护木、弹匣、瞄具、握把、枪托等独立零件，
 * 玩家视图模型与 Bot 手持武器共用同一份构建代码。
 */

/**
 * 程序化表面纹理（DataTexture，不依赖 DOM）。
 *
 * 零件在 mergedModel 里按材质合并，合并后只保留 position/normal/uv；
 * 因此这里只用 map / roughnessMap / bumpMap（都走 uv），不使用需要 tangent 的 normalMap。
 * 贴图按「种类 + 平铺次数」缓存、跨武器实例共享，不随单个模型释放。
 */
type WeaponSurface = 'brushed' | 'polymer' | 'wood' | 'rubber' | 'glass';

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
 * 生成武器表面贴图。
 * - detail：线性数据，兼作 roughnessMap 与 bumpMap（磨损处更亮更凹）。
 * - color：sRGB，与材质颜色相乘，制造轻微色差和烧蚀痕迹。
 */
function surfaceTexture(
  kind: WeaponSurface,
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
        if (kind === 'wood') {
          // 沿枪身方向的年轮：低频扰动 + 细密纹理。
          const grain = 0.5 + 0.5 * Math.sin((v * 26 + (low - 0.5) * 7) * Math.PI * 2);
          value = 0.62 + grain * 0.3 + (high - 0.5) * 0.08;
        } else {
          const contrast =
            kind === 'polymer' ? 0.12 : kind === 'rubber' ? 0.1 : kind === 'brushed' ? 0.08 : 0.05;
          value = 1 - contrast * (low * 0.6 + high * 0.4);
        }
      } else {
        switch (kind) {
          case 'brushed': {
            const streak = sampleField(fine, 32, u, v * 0.22);
            value = 0.68 + streak * 0.28 + (low - 0.5) * 0.05;
            break;
          }
          case 'polymer':
            value = 0.78 + low * 0.12 + (high - 0.5) * 0.16;
            break;
          case 'wood':
            value = 0.74 + low * 0.12 + (high - 0.5) * 0.18;
            break;
          case 'rubber':
            value = 0.84 + (high - 0.5) * 0.2;
            break;
          default:
            value = 0.92 + (high - 0.5) * 0.06;
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

  // 划痕/磕碰：金属与聚合物更明显。
  const scratches = kind === 'brushed' ? 26 : kind === 'polymer' ? 14 : kind === 'wood' ? 10 : 6;
  for (let s = 0; s < scratches; s += 1) {
    let px = Math.floor(rand() * size);
    let py = Math.floor(rand() * size);
    const length = 4 + Math.floor(rand() * (kind === 'brushed' ? 28 : 14));
    const horizontal = kind !== 'wood' && rand() < 0.7;
    const delta = (rand() < 0.5 ? -1 : 1) * (0.05 + rand() * 0.13);
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
  texture.colorSpace = mode === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  surfaceTextureCache.set(key, texture);
  return texture;
}

/** 给武器材质挂上色彩微差 + 粗糙度 + 微凹凸。 */
function textured(
  material: THREE.MeshStandardMaterial,
  kind: WeaponSurface,
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

const steel = new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.46, metalness: 0.9 });
textured(steel, 'brushed', 3, { bump: 0.0016 });

const steelBright = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.3, metalness: 0.96 });
textured(steelBright, 'brushed', 3, { bump: 0.0012 });

const polymer = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.78, metalness: 0.06 });
textured(polymer, 'polymer', 4, { bump: 0.0018 });

const polymerTan = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.74, metalness: 0.05 });
textured(polymerTan, 'polymer', 4, { bump: 0.0018 });

const woodMat = new THREE.MeshStandardMaterial({ color: 0x6d4b2a, roughness: 0.86, metalness: 0.02 });
textured(woodMat, 'wood', 2, { bump: 0.0025 });

const rubber = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.97, metalness: 0.02 });
textured(rubber, 'rubber', 5, { bump: 0.002 });

const lens = new THREE.MeshPhysicalMaterial({
  color: 0x2b6f8f,
  roughness: 0.06,
  metalness: 0.35,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
  emissive: 0x0e2b38,
  emissiveIntensity: 0.4,
});
// 镜片只加极轻微的镀膜不均，保留清晰的镜面高光。
lens.roughnessMap = surfaceTexture('glass', 2, 'detail');
lens.needsUpdate = true;

const brass = new THREE.MeshStandardMaterial({ color: 0xb08c46, roughness: 0.38, metalness: 0.92 });
textured(brass, 'brushed', 4, { bump: 0.001 });

function railTeeth(count: number, startZ: number, y: number, material: THREE.Material): PartSpec[] {
  const parts: PartSpec[] = [];
  const tooth = new THREE.BoxGeometry(0.03, 0.008, 0.012);
  for (let i = 0; i < count; i += 1) {
    parts.push(part(tooth.clone(), material, new THREE.Vector3(0, y, startZ - i * 0.024)));
  }
  return parts;
}

function rifleParts(): PartSpec[] {
  const parts: PartSpec[] = [];
  const euler = (x = 0, y = 0, z = 0): THREE.Euler => new THREE.Euler(x, y, z);
  const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  // 机匣 / 上机匣 / 导轨
  parts.push(part(roundedBox(0.068, 0.092, 0.3, 0.012, 3), polymer, at(0, 0, 0.03)));
  parts.push(part(roundedBox(0.05, 0.024, 0.26, 0.006, 2), steel, at(0, 0.058, 0.03)));
  parts.push(...railTeeth(10, 0.14, 0.076, steel));
  parts.push(part(new THREE.BoxGeometry(0.004, 0.05, 0.1), steel, at(0.036, 0.015, -0.01)));
  parts.push(part(new THREE.BoxGeometry(0.012, 0.01, 0.045), steel, at(0.042, 0.048, 0.1)));

  // 枪管 / 导气 / 消焰器
  parts.push(capsuleBetween(at(0, 0.012, -0.12), at(0, 0.012, -0.5), 0.013, steelBright, 5, 14));
  parts.push(part(new THREE.BoxGeometry(0.034, 0.032, 0.05), steel, at(0, 0.036, -0.3)));
  parts.push(part(new THREE.CylinderGeometry(0.02, 0.022, 0.075, 16), steel, at(0, 0.012, -0.53), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.024, 0.024, 0.012, 16), steelBright, at(0, 0.012, -0.49), euler(Math.PI / 2)));

  // 护木 + 散热槽 + 前握把
  parts.push(part(roundedBox(0.058, 0.07, 0.22, 0.01, 3), woodMat, at(0, -0.002, -0.28)));
  for (const z of [-0.22, -0.28, -0.34]) {
    parts.push(part(new THREE.BoxGeometry(0.062, 0.012, 0.02), polymer, at(0, 0.028, z)));
    parts.push(part(new THREE.BoxGeometry(0.012, 0.03, 0.02), steel, at(0.032, -0.004, z - 0.005)));
    parts.push(part(new THREE.BoxGeometry(0.012, 0.03, 0.02), steel, at(-0.032, -0.004, z - 0.005)));
  }
  parts.push(part(roundedBox(0.026, 0.09, 0.034, 0.01, 2), polymer, at(0, -0.075, -0.24), euler(0.16)));

  // 准星护翼
  parts.push(part(new THREE.BoxGeometry(0.01, 0.055, 0.012), steel, at(0, 0.055, -0.42)));
  parts.push(part(new THREE.BoxGeometry(0.036, 0.05, 0.01), steel, at(0, 0.055, -0.42)));

  // 瞄具：底座 + 镜筒 + 物镜 + 目镜
  parts.push(part(roundedBox(0.034, 0.022, 0.09, 0.006, 2), steel, at(0, 0.078, -0.03)));
  parts.push(part(new THREE.CylinderGeometry(0.026, 0.026, 0.12, 16), steel, at(0, 0.104, -0.03), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.03, 0.024, 0.02, 16), steel, at(0, 0.104, -0.092), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.02, 0.02, 0.006, 16), lens, at(0, 0.104, -0.1), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.026, 0.028, 0.016, 16), rubber, at(0, 0.104, 0.036), euler(Math.PI / 2)));
  parts.push(part(new THREE.BoxGeometry(0.05, 0.012, 0.014), steel, at(0, 0.089, 0.042)));
  parts.push(part(new THREE.CylinderGeometry(0.008, 0.008, 0.016, 12), brass, at(0.03, 0.104, -0.03), euler(0, 0, Math.PI / 2)));

  // 弹匣（两段折角，接近弯曲弹匣）+ 弹匣井
  parts.push(part(roundedBox(0.052, 0.14, 0.072, 0.008, 2), polymer, at(0, -0.115, 0.06), euler(0.12)));
  parts.push(part(roundedBox(0.05, 0.08, 0.066, 0.008, 2), polymer, at(0, -0.205, 0.028), euler(0.34)));
  parts.push(part(new THREE.BoxGeometry(0.06, 0.02, 0.08), steel, at(0, -0.055, 0.055)));

  // 握把 / 扳机护圈 / 扳机
  parts.push(part(roundedBox(0.042, 0.13, 0.058, 0.012, 3), polymerTan, at(0, -0.1, 0.15), euler(-0.34)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.008, 0.075), steel, at(0, -0.062, 0.13)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.05, 0.008), steel, at(0.026, -0.04, 0.098)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.05, 0.008), steel, at(-0.026, -0.04, 0.098)));
  parts.push(part(new THREE.BoxGeometry(0.006, 0.026, 0.008), steel, at(0, -0.045, 0.115), euler(0.3)));

  // 枪托：缓冲管 + 托体 + 托底 + 贴腮
  parts.push(part(new THREE.CylinderGeometry(0.017, 0.017, 0.16, 16), steel, at(0, 0.022, 0.24), euler(Math.PI / 2)));
  parts.push(part(roundedBox(0.05, 0.09, 0.17, 0.014, 3), polymer, at(0, -0.004, 0.33)));
  parts.push(part(new THREE.BoxGeometry(0.054, 0.12, 0.02), rubber, at(0, -0.012, 0.415)));
  parts.push(part(roundedBox(0.05, 0.02, 0.1, 0.008, 2), polymerTan, at(0, 0.046, 0.31)));
  parts.push(part(new THREE.TorusGeometry(0.018, 0.004, 8, 16), steel, at(0.04, -0.03, 0.28), euler(0, Math.PI / 2)));

  // 抛壳口 / 拉机柄
  parts.push(part(new THREE.BoxGeometry(0.002, 0.028, 0.07), rubber, at(0.035, 0.02, -0.02)));
  parts.push(part(new THREE.BoxGeometry(0.02, 0.012, 0.03), steel, at(-0.04, 0.05, 0.06)));
  return parts;
}

function pistolParts(): PartSpec[] {
  const parts: PartSpec[] = [];
  const euler = (x = 0, y = 0, z = 0): THREE.Euler => new THREE.Euler(x, y, z);
  const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  parts.push(part(roundedBox(0.046, 0.062, 0.22, 0.012, 3), steel, at(0, 0.022, -0.03)));
  parts.push(part(roundedBox(0.042, 0.04, 0.19, 0.01, 3), polymer, at(0, -0.022, -0.01)));
  parts.push(capsuleBetween(at(0, 0.02, -0.11), at(0, 0.02, -0.16), 0.011, steelBright, 5, 14));
  parts.push(part(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 16), steelBright, at(0, 0.02, -0.155), euler(Math.PI / 2)));
  parts.push(part(roundedBox(0.04, 0.13, 0.052, 0.012, 3), polymer, at(0, -0.095, 0.05), euler(-0.22)));
  parts.push(part(new THREE.BoxGeometry(0.044, 0.016, 0.06), polymer, at(0, -0.16, 0.062), euler(-0.22)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.008, 0.06), steel, at(0, -0.052, 0.03)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.04, 0.008), steel, at(0.02, -0.032, 0.004)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.04, 0.008), steel, at(-0.02, -0.032, 0.004)));
  parts.push(part(new THREE.BoxGeometry(0.006, 0.022, 0.007), steel, at(0, -0.038, 0.014), euler(0.3)));
  parts.push(part(new THREE.BoxGeometry(0.006, 0.012, 0.01), steel, at(0, 0.058, -0.1)));
  parts.push(part(new THREE.BoxGeometry(0.03, 0.008, 0.01), steel, at(0, 0.055, 0.07)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.008, 0.01), steel, at(-0.008, 0.058, 0.07)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.008, 0.01), steel, at(0.008, 0.058, 0.07)));
  parts.push(part(new THREE.BoxGeometry(0.002, 0.026, 0.06), rubber, at(0.023, 0.028, -0.03)));
  return parts;
}

export interface WeaponModel {
  id: WeaponModelId;
  group: THREE.Group;
  muzzle: THREE.Object3D;
}

export function buildWeaponModel(id: WeaponModelId, castShadow = true): WeaponModel {
  const parts = id === 'rifle' ? rifleParts() : pistolParts();
  const group = mergedModel(parts, castShadow);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, id === 'rifle' ? 0.012 : 0.02, id === 'rifle' ? -0.58 : -0.17);
  group.add(muzzle);
  return { id, group, muzzle };
}
