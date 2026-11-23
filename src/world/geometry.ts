import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../core/math';

/** 程序化几何工具：倒角盒、按米缩放的 UV、实例化重复件。 */

export function roundedBox(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  radius: number,
  segments = 2,
): THREE.BufferGeometry {
  const limit = Math.min(sizeX, sizeY, sizeZ) * 0.42;
  const r = Math.max(0.004, Math.min(radius, limit));
  return new RoundedBoxGeometry(sizeX, sizeY, sizeZ, segments, r);
}

/**
 * BoxGeometry 每个面 4 个顶点，顺序为 +X, -X, +Y, -Y, +Z, -Z。
 * 按面尺寸缩放 UV，使任意尺寸的盒体都有相同的每米纹理密度。
 */
export function scaleBoxUvs(
  geometry: THREE.BufferGeometry,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  tile: number,
): void {
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv || tile <= 0) return;
  const spans: Array<[number, number]> = [
    [sizeZ, sizeY],
    [sizeZ, sizeY],
    [sizeX, sizeZ],
    [sizeX, sizeZ],
    [sizeX, sizeY],
    [sizeX, sizeY],
  ];
  for (let face = 0; face < 6; face += 1) {
    const [u, v] = spans[face];
    for (let i = 0; i < 4; i += 1) {
      const index = face * 4 + i;
      uv.setXY(index, uv.getX(index) * (u / tile), uv.getY(index) * (v / tile));
    }
  }
  uv.needsUpdate = true;
}

export function texturisedBox(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  tile: number,
): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
  scaleBoxUvs(geometry, sizeX, sizeY, sizeZ, tile);
  return geometry;
}

export function meshAt(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  center: Vec3,
  castShadow = true,
  receiveShadow = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(center.x, center.y, center.z);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

export function offsetMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  castShadow = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
  castShadow: boolean,
  colors?: THREE.Color[],
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, matrices.length));
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  for (let i = 0; i < matrices.length; i += 1) {
    mesh.setMatrixAt(i, matrices[i]);
    if (colors && colors[i]) mesh.setColorAt(i, colors[i]);
  }
  mesh.count = matrices.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

export function matrixAt(
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = 1,
  sz = 1,
  rotateY = 0,
  rotateZ = 0,
): THREE.Matrix4 {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotateY, rotateZ));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    quaternion,
    new THREE.Vector3(sx, sy, sz),
  );
}

/** 带轻微抖动的确定性随机，供程序化装饰使用。 */
export function hashNoise(seed: number): () => number {
  let s = (seed || 1) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export interface PartSpec {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  material: THREE.Material;
}

export function part(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: THREE.Vector3,
  rotation?: THREE.Euler,
  scale?: THREE.Vector3,
): PartSpec {
  const matrix = new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromEuler(rotation ?? new THREE.Euler()),
    scale ?? new THREE.Vector3(1, 1, 1),
  );
  return { geometry, matrix, material };
}

/** 两点之间的胶囊体，用于四肢与枪管等分段造型。 */
export function capsuleBetween(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  capSegments = 4,
  radialSegments = 10,
): PartSpec {
  const direction = new THREE.Vector3().subVectors(to, from);
  const distance = direction.length();
  const geometry = new THREE.CapsuleGeometry(
    radius,
    Math.max(0.01, distance - radius * 2),
    capSegments,
    radialSegments,
  );
  const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  const matrix = new THREE.Matrix4().compose(midpoint, quaternion, new THREE.Vector3(1, 1, 1));
  return { geometry, matrix, material };
}

/** 合并前的几何需要统一的属性集合：只要 position / normal / uv，且必须是非索引几何。 */
function normaliseForMerge(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const result = geometry.index ? geometry.toNonIndexed() : geometry;
  const keep = new Set(['position', 'normal', 'uv']);
  for (const name of Object.keys(result.attributes)) {
    if (!keep.has(name)) result.deleteAttribute(name);
  }
  const position = result.getAttribute('position');
  if (position && !result.getAttribute('uv')) {
    result.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  }
  if (position && !result.getAttribute('normal')) result.computeVertexNormals();
  return result;
}

export interface StaticMergeResult {
  /** 合并后剩下的绘制对象数量（Mesh + InstancedMesh + Line + Points）。 */
  drawObjects: number;
  /** 合并前的零件网格数量。 */
  sourceMeshes: number;
  /** 被合并掉的网格数量。 */
  mergedMeshes: number;
}

/**
 * 关卡静态几何合并：可见几何全部来自同一份盒体数据且不逐帧变化，
 * 因此可以把共享材质的零件烘焙成一个 Mesh，把 draw call 从「零件数」降到「材质数」。
 * 阴影开关不同的零件会分到不同的桶里，保证投影结果与合并前一致。
 * 实例化网格（InstancedMesh）、线与粒子保持原样。
 */
export function mergeStaticMeshes(root: THREE.Object3D): StaticMergeResult {
  root.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, { material: THREE.Material; castShadow: boolean; receiveShadow: boolean; meshes: THREE.Mesh[] }>();
  let sourceMeshes = 0;

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (object as THREE.InstancedMesh).isInstancedMesh) return;
    if (Array.isArray(mesh.material) || !mesh.geometry) return;
    sourceMeshes += 1;
    const key = `${mesh.material.uuid}:${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.meshes.push(mesh);
    else {
      buckets.set(key, {
        material: mesh.material,
        castShadow: mesh.castShadow,
        receiveShadow: mesh.receiveShadow,
        meshes: [mesh],
      });
    }
  });

  const removedGeometries = new Set<THREE.BufferGeometry>();
  let mergedMeshes = 0;
  for (const bucket of buckets.values()) {
    if (bucket.meshes.length < 2) continue;
    const geometries: THREE.BufferGeometry[] = [];
    for (const mesh of bucket.meshes) {
      const geometry = normaliseForMerge(mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone());
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld));
      geometries.push(geometry);
    }
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue; // 属性不一致等极端情况：保留原零件，不影响画面
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = bucket.receiveShadow;
    mesh.name = 'merged';
    for (const source of bucket.meshes) {
      removedGeometries.add(source.geometry);
      source.parent?.remove(source);
      mergedMeshes += 1;
    }
    root.add(mesh);
  }

  // 合并掉的原始几何只在没有其它对象引用时才释放（部分装饰件共享同一份几何）。
  const stillUsed = new Set<THREE.BufferGeometry>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) stillUsed.add(mesh.geometry);
  });
  for (const geometry of removedGeometries) {
    if (!stillUsed.has(geometry)) geometry.dispose();
  }

  let drawObjects = 0;
  root.traverse((object) => {
    const drawable = object as THREE.Mesh;
    if (drawable.isMesh || (object as unknown as THREE.Line).isLine || (object as unknown as THREE.Points).isPoints) {
      drawObjects += 1;
    }
  });

  return { drawObjects, sourceMeshes, mergedMeshes };
}

/**
 * 按材质合并同角色的分段零件：视觉细节保留（几十个零件），
 * draw call 降到每种材质一个，避免 Bot 数量拉高渲染批次。
 */
export function mergedModel(parts: PartSpec[], castShadow = true): THREE.Group {
  const group = new THREE.Group();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const entry of parts) {
    // three 的核心几何有 indexed/non-indexed 混合（如 CapsuleGeometry），
    // 全部转成 non-indexed 后再合并，避免 mergeGeometries 直接失败。
    const geometry = entry.geometry.index ? entry.geometry.toNonIndexed() : entry.geometry.clone();
    geometry.applyMatrix4(entry.matrix);
    entry.geometry.dispose();
    const list = buckets.get(entry.material);
    if (list) list.push(geometry);
    else buckets.set(entry.material, [geometry]);
  }
  for (const [material, geometries] of buckets) {
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) {
      continue;
    }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
