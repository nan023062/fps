import * as THREE from 'three';
import { vec3 } from '../core/math';
import type { LevelBox, LevelDefinition } from './level';
import { boxCenter, boxSize } from './level';
import type { MaterialLibrary } from './materials';
import type { QualityPreset } from './quality';
import {
  cylinderSegmentsFor,
  hashNoise,
  instanced,
  matrixAt,
  mergeStaticMeshes,
  meshAt,
  offsetMesh,
  polyhedronDetailFor,
  roundedBox,
  roundedSegmentsFor,
  sphereSegmentsFor,
  texturisedBox,
} from './geometry';

/**
 * 关卡几何：可见几何完全由 LevelDefinition.boxes 生成，碰撞体使用同一个数组。
 * 细节（倒角、护角、沙袋、拱门、围栏、残骸、沙丘、远景）都限制在盒体内部，
 * 因此“看得见”与“打得到”始终一致。
 */

export interface LevelModel {
  root: THREE.Group;
  /** 合并后真正提交给渲染器的绘制对象数量。 */
  meshes: number;
  /** 合并前的零件网格数量（几何细节量）。 */
  detailParts: number;
  update(dt: number): void;
  dispose(): void;
}

interface BuildContext {
  level: LevelDefinition;
  materials: MaterialLibrary;
  quality: QualityPreset;
  random: () => number;
  /** 当前盒体的局部坐标系（原点在盒体中心）。 */
  root: THREE.Group;
  meshes: number;
  /** 关卡自己创建、不属于材质库的材质（围栏铁线、布幔、雾层、尘埃）。 */
  owned: THREE.Material[];
}

/** RoundedBoxGeometry 每个面是 (segments+1)^2 个顶点；UV 仍然是 0..1，可整体缩放。 */
function scaleRoundedUvs(
  geometry: THREE.BufferGeometry,
  size: { x: number; y: number; z: number },
  tile: number,
): void {
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv || uv.count % 6 !== 0) return;
  const block = uv.count / 6;
  const spans: Array<[number, number]> = [
    [size.z, size.y],
    [size.z, size.y],
    [size.x, size.z],
    [size.x, size.z],
    [size.x, size.y],
    [size.x, size.y],
  ];
  for (let face = 0; face < 6; face += 1) {
    const [u, v] = spans[face];
    for (let i = 0; i < block; i += 1) {
      const index = face * block + i;
      uv.setXY(index, uv.getX(index) * (u / tile), uv.getY(index) * (v / tile));
    }
  }
  uv.needsUpdate = true;
}

function defaultRole(box: LevelBox): NonNullable<LevelBox['role']> {
  if (box.role) return box.role;
  switch (box.kind) {
    case 'sand':
      return 'ground';
    case 'crate':
      return 'crate';
    case 'sandbag':
      return 'sandbag';
    case 'wood':
      return 'crate';
    default:
      return 'block';
  }
}

function buildGround(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const geometry = texturisedBox(size.x, size.y, size.z, ctx.materials.tileSize('sand'));
  const mesh = meshAt(geometry, ctx.materials.surface(box.kind), vec3(0, 0, 0), false, true);
  mesh.position.set(0, 0, 0);
  ctx.root.add(mesh);
  ctx.meshes += 1;

  // 地面细节：碎石与干裂纹理用少量薄片表现，全部贴地不参与碰撞。
  if (ctx.quality.detailScale < 0.7) return;
  const pebbleGeo = roundedBox(0.22, 0.07, 0.16, 0.03, roundedSegmentsFor(ctx.quality));
  const pebbleMat = ctx.materials.detail(0x9d8a68, 0.95, 0.02, 'concrete');
  const pebbles: THREE.Matrix4[] = [];
  const count = Math.round(70 * ctx.quality.detailScale);
  for (let i = 0; i < count; i += 1) {
    const x = (ctx.random() - 0.5) * size.x * 0.9;
    const z = (ctx.random() - 0.5) * size.z * 0.9;
    pebbles.push(matrixAt(x, size.y * 0.5 + 0.02, z, 0.6 + ctx.random(), 1, 0.6 + ctx.random(), ctx.random() * 3));
  }
  ctx.root.add(instanced(pebbleGeo, pebbleMat, pebbles, false));
  ctx.meshes += 1;
}

function buildWall(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const material = ctx.materials.surface(box.kind, box.tone);
  const radius = Math.min(0.07, Math.min(size.x, size.y, size.z) * 0.25);
  const geometry = roundedBox(size.x, size.y, size.z, radius, roundedSegmentsFor(ctx.quality));
  scaleRoundedUvs(geometry, size, ctx.materials.tileSize(ctx.materials.patternOf(box.kind)));
  ctx.root.add(meshAt(geometry, material, vec3(0, 0, 0)));
  ctx.meshes += 1;

  const trimMat = ctx.materials.surface(box.kind, (box.tone ?? 1) * 1.18);
  const darkMat = ctx.materials.surface(box.kind, (box.tone ?? 1) * 0.72);

  // 压顶与踢脚：略微内缩，保证装饰不超出碰撞盒。
  const copingHeight = Math.min(0.24, size.y * 0.12);
  if (copingHeight > 0.05) {
    const coping = new THREE.BoxGeometry(size.x * 0.99, copingHeight, size.z * 0.99);
    ctx.root.add(offsetMesh(coping, trimMat, ctx.root, 0, size.y * 0.5 - copingHeight * 0.5, 0));
    ctx.meshes += 1;
  }
  const skirtHeight = Math.min(0.34, size.y * 0.16);
  if (skirtHeight > 0.06) {
    const skirt = new THREE.BoxGeometry(size.x * 0.998, skirtHeight, size.z * 0.998);
    ctx.root.add(offsetMesh(skirt, darkMat, ctx.root, 0, -size.y * 0.5 + skirtHeight * 0.5, 0));
    ctx.meshes += 1;
  }

  if (ctx.quality.detailScale < 0.6) return;

  // 沿长边做壁柱/凹板，弱化“一整块方盒”的感觉。
  const longX = size.x >= size.z;
  const longLength = longX ? size.x : size.z;
  const panels = Math.min(7, Math.max(2, Math.round((longLength / 5) * ctx.quality.detailScale) + 1));
  const panelWidth = (longLength / panels) * 0.66;
  const panelHeight = size.y * 0.46;
  if (panelHeight < 0.4 || panelWidth < 0.3) return;
  for (let i = 0; i < panels; i += 1) {
    const t = (i + 0.5) / panels;
    const along = (t - 0.5) * longLength;
    const outward = (longX ? size.z : size.x) * 0.5;
    const thin = 0.05;
    const panelGeometry = longX
      ? new THREE.BoxGeometry(panelWidth, panelHeight, thin)
      : new THREE.BoxGeometry(thin, panelHeight, panelWidth);
    for (const side of [-1, 1]) {
      const x = longX ? along : side * (outward - thin * 1.2);
      const z = longX ? side * (outward - thin * 1.2) : along;
      ctx.root.add(offsetMesh(panelGeometry, darkMat, ctx.root, x, 0, z, false));
      ctx.meshes += 1;
    }
  }
}

function buildBlock(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const material = ctx.materials.surface(box.kind, box.tone);
  const radius = Math.min(0.06, Math.min(size.x, size.y, size.z) * 0.3);
  const geometry = roundedBox(size.x, size.y, size.z, radius, roundedSegmentsFor(ctx.quality));
  scaleRoundedUvs(geometry, size, ctx.materials.tileSize(ctx.materials.patternOf(box.kind)));
  ctx.root.add(meshAt(geometry, material, vec3(0, 0, 0)));
  ctx.meshes += 1;

  const capMat = ctx.materials.surface(box.kind, (box.tone ?? 1) * 1.14);
  const capHeight = Math.min(0.14, size.y * 0.16);
  if (capHeight > 0.04) {
    const cap = new THREE.BoxGeometry(size.x * 0.98, capHeight, size.z * 0.98);
    ctx.root.add(offsetMesh(cap, capMat, ctx.root, 0, size.y * 0.5 - capHeight * 0.5, 0, false));
    ctx.meshes += 1;
  }

  if (ctx.quality.detailScale < 0.75) return;
  // 弹痕碎屑（内缩薄片），提示掩体表面质感。
  const chipMat = ctx.materials.detail(0x5d5142, 0.95, 0.02);
  const chips: THREE.Matrix4[] = [];
  const chipCount = Math.round(10 * ctx.quality.detailScale);
  for (let i = 0; i < chipCount; i += 1) {
    const onX = ctx.random() > 0.5;
    const x = onX ? size.x * 0.5 - 0.03 : (ctx.random() - 0.5) * size.x * 0.8;
    const z = onX ? (ctx.random() - 0.5) * size.z * 0.8 : size.z * 0.5 - 0.03;
    const y = (ctx.random() - 0.5) * size.y * 0.7;
    chips.push(matrixAt(x, y, z, 0.5 + ctx.random(), 0.4 + ctx.random(), 1, ctx.random() * 3));
  }
  ctx.root.add(instanced(new THREE.BoxGeometry(0.07, 0.07, 0.02), chipMat, chips, false));
  ctx.meshes += 1;
}

function buildCrate(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  // 主体内缩 2cm，装饰件（铁带/包角）因此始终落在碰撞盒内部。
  const inset = 0.02;
  const bodyX = size.x - inset;
  const bodyY = size.y - inset;
  const bodyZ = size.z - inset;
  const material = ctx.materials.surface(box.kind, box.tone);
  const geometry = roundedBox(
    bodyX,
    bodyY,
    bodyZ,
    Math.min(0.05, Math.min(bodyX, bodyY, bodyZ) * 0.2),
    roundedSegmentsFor(ctx.quality),
  );
  scaleRoundedUvs(
    geometry,
    new THREE.Vector3(bodyX, bodyY, bodyZ),
    ctx.materials.tileSize(ctx.materials.patternOf(box.kind)),
  );
  ctx.root.add(meshAt(geometry, material, vec3(0, 0, 0)));
  ctx.meshes += 1;

  const steel = ctx.materials.detail(0x4c545c, 0.42, 0.75, 'metal');
  const band = 0.055;
  // 金属包角
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const bracket = new THREE.BoxGeometry(band * 2, bodyY * 0.98, band * 2);
      ctx.root.add(
        offsetMesh(
          bracket,
          steel,
          ctx.root,
          sx * (bodyX * 0.5 - band),
          0,
          sz * (bodyZ * 0.5 - band),
          false,
        ),
      );
      ctx.meshes += 1;
    }
  }
  // 横向铁带
  for (const yFactor of [-0.28, 0.3]) {
    const belt = new THREE.BoxGeometry(bodyX * 1.005, band, bodyZ * 1.005);
    ctx.root.add(offsetMesh(belt, steel, ctx.root, 0, bodyY * yFactor, 0, false));
    ctx.meshes += 1;
  }
  if (ctx.quality.detailScale < 0.7) return;
  // 顶部板缝
  const seam = new THREE.BoxGeometry(bodyX * 0.96, 0.02, bodyZ * 0.12);
  ctx.root.add(offsetMesh(seam, steel, ctx.root, 0, bodyY * 0.5 - 0.01, 0, false));
  ctx.meshes += 1;
}

function buildSandbag(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const bagGeo = roundedBox(0.5, 0.24, 0.42, 0.11, roundedSegmentsFor(ctx.quality));
  const material = ctx.materials.surface(box.kind, box.tone);
  const rows = Math.max(1, Math.round(size.y / 0.26));
  const cols = Math.max(1, Math.round(size.x / 0.5));
  const layers = Math.max(1, Math.round(size.z / 0.42));
  const matrices: THREE.Matrix4[] = [];
  const colors: THREE.Color[] = [];
  const bagY = size.y / rows;
  const bagX = size.x / cols;
  const bagZ = size.z / layers;
  for (let row = 0; row < rows; row += 1) {
    const stagger = row % 2 === 0 ? 0 : bagX * 0.5;
    for (let layer = 0; layer < layers; layer += 1) {
      for (let col = 0; col < cols; col += 1) {
        if (matrices.length > 320) break;
        const x = -size.x * 0.5 + bagX * (col + 0.5) + (stagger % bagX) - bagX * 0.25;
        const z = -size.z * 0.5 + bagZ * (layer + 0.5);
        const y = -size.y * 0.5 + bagY * (row + 0.5);
        matrices.push(
          matrixAt(
            x + (ctx.random() - 0.5) * 0.02,
            y,
            z + (ctx.random() - 0.5) * 0.02,
            (bagX / 0.5) * 0.96,
            (bagY / 0.24) * 0.96,
            (bagZ / 0.42) * 0.96,
            (ctx.random() - 0.5) * 0.18,
            (ctx.random() - 0.5) * 0.08,
          ),
        );
        // 每袋轻微色差，避免整排一个颜色
        const shade = 0.88 + ctx.random() * 0.2;
        colors.push(new THREE.Color(shade, shade * (0.97 + ctx.random() * 0.05), shade * 0.94));
      }
    }
  }
  ctx.root.add(instanced(bagGeo, material, matrices, true, colors));
  ctx.meshes += 1;
}

function buildFence(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const longX = size.x >= size.z;
  const length = longX ? size.x : size.z;
  const postMat = ctx.materials.detail(0x4e4740, 0.7, 0.35, 'metal');
  const railMat = ctx.materials.surface(box.kind, box.tone);
  const posts: THREE.Matrix4[] = [];
  const count = Math.max(2, Math.round(length / 2.2));
  for (let i = 0; i <= count; i += 1) {
    const along = (i / count - 0.5) * length;
    posts.push(
      matrixAt(
        longX ? along : 0,
        size.y * 0.5 - Math.min(0.06, size.y * 0.1),
        longX ? 0 : along,
        1,
        size.y / 1.1,
        1,
      ),
    );
  }
  const postGeo = roundedBox(0.09, 1.1, 0.09, 0.02, roundedSegmentsFor(ctx.quality));
  ctx.root.add(instanced(postGeo, postMat, posts, true));
  ctx.meshes += 1;

  for (const heightFactor of [0.28, 0.72]) {
    const rail = longX
      ? new THREE.BoxGeometry(length * 0.99, 0.07, 0.05)
      : new THREE.BoxGeometry(0.05, 0.07, length * 0.99);
    ctx.root.add(offsetMesh(rail, railMat, ctx.root, 0, size.y * (heightFactor - 0.5), 0, false));
    ctx.meshes += 1;
  }

  // 铁丝：纯线框，不参与碰撞也不投影。
  const points: THREE.Vector3[] = [];
  const wireY = size.y * 0.5;
  const steps = Math.max(2, Math.round(length));
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps - 0.5) * length;
    const b = ((i + 1) / steps - 0.5) * length;
    const sag = 0.16;
    const mid = (a + b) * 0.5;
    if (longX) {
      points.push(
        new THREE.Vector3(a, wireY - 0.04, 0),
        new THREE.Vector3(mid, wireY - 0.04 - sag, 0),
        new THREE.Vector3(mid, wireY - 0.04 - sag, 0),
        new THREE.Vector3(b, wireY - 0.04, 0),
      );
    } else {
      points.push(
        new THREE.Vector3(0, wireY - 0.04, a),
        new THREE.Vector3(0, wireY - 0.04 - sag, mid),
        new THREE.Vector3(0, wireY - 0.04 - sag, mid),
        new THREE.Vector3(0, wireY - 0.04, b),
      );
    }
  }
  const wireGeo = new THREE.BufferGeometry().setFromPoints(points);
  const wireMaterial = new THREE.LineBasicMaterial({ color: 0x6c6255 });
  ctx.owned.push(wireMaterial);
  const wire = new THREE.LineSegments(wireGeo, wireMaterial);
  ctx.root.add(wire);
  ctx.meshes += 1;
}

function buildPillar(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const radius = Math.min(size.x, size.z) * 0.46;
  const material = ctx.materials.surface(box.kind, box.tone);
  const shaftHeight = size.y * 0.84;
  const shaft = new THREE.CylinderGeometry(
    radius,
    radius * 1.03,
    shaftHeight,
    cylinderSegmentsFor(ctx.quality),
    1,
  );
  ctx.root.add(meshAt(shaft, material, vec3(0, 0, 0)));
  ctx.meshes += 1;

  const trim = ctx.materials.surface(box.kind, (box.tone ?? 1) * 1.16);
  const baseHeight = (size.y - shaftHeight) * 0.55;
  const base = roundedBox(size.x * 0.98, baseHeight, size.z * 0.98, 0.04, roundedSegmentsFor(ctx.quality));
  ctx.root.add(offsetMesh(base, trim, ctx.root, 0, -size.y * 0.5 + baseHeight * 0.5, 0));
  ctx.meshes += 1;

  const cap = roundedBox(size.x * 0.99, baseHeight, size.z * 0.99, 0.04, roundedSegmentsFor(ctx.quality));
  ctx.root.add(offsetMesh(cap, trim, ctx.root, 0, size.y * 0.5 - baseHeight * 0.5, 0));
  ctx.meshes += 1;

  if (ctx.quality.detailScale < 0.7) return;
  const ring = new THREE.CylinderGeometry(
    radius * 1.08,
    radius * 1.08,
    0.12,
    cylinderSegmentsFor(ctx.quality),
    1,
  );
  const ringMat = ctx.materials.surface(box.kind, (box.tone ?? 1) * 0.8);
  ctx.root.add(offsetMesh(ring, ringMat, ctx.root, 0, size.y * 0.16, 0, false));
  ctx.root.add(offsetMesh(ring, ringMat, ctx.root, 0, -size.y * 0.2, 0, false));
  ctx.meshes += 2;
}

function buildLintel(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const material = ctx.materials.surface(box.kind, box.tone);
  const geometry = roundedBox(
    size.x,
    size.y,
    size.z,
    Math.min(0.06, size.y * 0.3),
    roundedSegmentsFor(ctx.quality),
  );
  scaleRoundedUvs(geometry, size, ctx.materials.tileSize(ctx.materials.patternOf(box.kind)));
  ctx.root.add(meshAt(geometry, material, vec3(0, 0, 0)));
  ctx.meshes += 1;

  const keystoneMat = ctx.materials.surface(box.kind, (box.tone ?? 1) * 1.2);
  const keystone = new THREE.BoxGeometry(Math.min(0.5, size.x * 0.08), size.y * 0.94, size.z * 0.98);
  ctx.root.add(offsetMesh(keystone, keystoneMat, ctx.root, 0, 0, 0, false));
  ctx.meshes += 1;
}

function buildWreck(box: LevelBox, ctx: BuildContext): void {
  const size = boxSize(box);
  const metal = ctx.materials.detail(0x6b6055, 0.85, 0.45, 'metal');
  const rust = ctx.materials.detail(0x8a5a35, 0.95, 0.2, 'concrete');
  const hull = roundedBox(
    size.x * 0.9,
    size.y * 0.62,
    size.z * 0.9,
    0.08,
    roundedSegmentsFor(ctx.quality),
  );
  ctx.root.add(offsetMesh(hull, metal, ctx.root, 0, -size.y * 0.08, 0));
  ctx.meshes += 1;

  const cabin = roundedBox(
    size.x * 0.42,
    size.y * 0.34,
    size.z * 0.7,
    0.05,
    roundedSegmentsFor(ctx.quality),
  );
  ctx.root.add(offsetMesh(cabin, rust, ctx.root, size.x * 0.12, size.y * 0.22, -size.z * 0.04));
  ctx.meshes += 1;

  const wheelGeo = new THREE.CylinderGeometry(
    size.y * 0.22,
    size.y * 0.22,
    0.22,
    cylinderSegmentsFor(ctx.quality),
  );
  wheelGeo.rotateZ(Math.PI * 0.5);
  const rubber = ctx.materials.detail(0x23242a, 0.95, 0.05);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = wheelGeo.clone();
      const wheelMesh = new THREE.Mesh(wheel, rubber);
      wheelMesh.position.set(sx * size.x * 0.34, -size.y * 0.34, sz * size.z * 0.32);
      wheelMesh.rotation.y = sx * Math.PI * 0.5;
      wheelMesh.castShadow = true;
      wheelMesh.receiveShadow = true;
      ctx.root.add(wheelMesh);
      ctx.meshes += 1;
    }
  }

  if (ctx.quality.detailScale < 0.7) return;
  const plate = new THREE.BoxGeometry(size.x * 0.7, 0.06, size.z * 0.4);
  ctx.root.add(offsetMesh(plate, rust, ctx.root, 0, size.y * 0.28, size.z * 0.2, false));
  ctx.meshes += 1;
}

function buildOneBox(box: LevelBox, ctx: BuildContext): THREE.Group {
  const center = boxCenter(box);
  const group = new THREE.Group();
  group.position.set(center.x, center.y, center.z);
  ctx.root = group;
  const role = defaultRole(box);
  switch (role) {
    case 'ground':
      buildGround(box, ctx);
      break;
    case 'wall':
      buildWall(box, ctx);
      break;
    case 'crate':
      buildCrate(box, ctx);
      break;
    case 'sandbag':
      buildSandbag(box, ctx);
      break;
    case 'fence':
      buildFence(box, ctx);
      break;
    case 'pillar':
      buildPillar(box, ctx);
      break;
    case 'lintel':
      buildLintel(box, ctx);
      break;
    case 'wreck':
      buildWreck(box, ctx);
      break;
    case 'cover':
    case 'block':
    default:
      buildBlock(box, ctx);
      break;
  }
  return group;
}

function boundsOf(level: LevelDefinition): { min: THREE.Vector3; max: THREE.Vector3 } {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const box of level.boxes) {
    min.min(new THREE.Vector3(box.min.x, box.min.y, box.min.z));
    max.max(new THREE.Vector3(box.max.x, box.max.y, box.max.z));
  }
  return { min, max };
}

function buildHorizon(
  level: LevelDefinition,
  materials: MaterialLibrary,
  quality: QualityPreset,
  owned: THREE.Material[],
): THREE.Group {
  const group = new THREE.Group();
  const theme = level.theme;
  const bounds = boundsOf(level);
  const random = hashNoise(level.id.length * 7919 + level.boxes.length * 131);

  const groundGeo = new THREE.PlaneGeometry(1400, 1400);
  groundGeo.rotateX(-Math.PI * 0.5);
  const groundMat = materials.detail(theme.horizon.ground, 1, 0);
  const farGround = new THREE.Mesh(groundGeo, groundMat);
  farGround.position.y = -0.06;
  farGround.receiveShadow = false;
  group.add(farGround);

  const duneCount = Math.round(level.decor.dunes * Math.min(1, quality.detailScale + 0.2));
  if (duneCount > 0) {
    const duneSegments = sphereSegmentsFor(quality);
    const duneGeo = new THREE.SphereGeometry(
      1,
      duneSegments.widthSegments,
      duneSegments.heightSegments,
      0,
      Math.PI * 2,
      0,
      Math.PI * 0.5,
    );
    const duneMat = materials.detail(theme.horizon.dune, 1, 0, 'sand');
    const matrices: THREE.Matrix4[] = [];
    // 沙丘必须完全落在场地外：中心距 = 场地半长 * 1.5 + 沙丘自身半径。
    const extent = Math.max(
      Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
      Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)),
    );
    for (let i = 0; i < duneCount; i += 1) {
      const angle = (i / duneCount) * Math.PI * 2 + random() * 0.4;
      const width = 22 + random() * 38;
      const depth = width * (0.7 + random() * 0.5);
      const distance = extent * 1.45 + Math.max(width, depth) + random() * 70;
      const height = 3 + random() * 8;
      matrices.push(
        matrixAt(
          Math.cos(angle) * distance,
          -0.6,
          Math.sin(angle) * distance,
          width,
          height,
          depth,
          random() * Math.PI,
        ),
      );
    }
    group.add(instanced(duneGeo, duneMat, matrices, false));
  }

  const mesaCount = Math.round(level.decor.mesas * Math.min(1, quality.detailScale + 0.2));
  if (mesaCount > 0) {
    const mesas: THREE.Matrix4[] = [];
    const rockGeo = new THREE.DodecahedronGeometry(1, polyhedronDetailFor(quality));
    const rockMat = materials.detail(theme.horizon.ridge, 0.95, 0, 'stone');
    for (let i = 0; i < mesaCount; i += 1) {
      const angle = (i / mesaCount) * Math.PI * 2 + random() * 0.7;
      const radius = 140 + random() * 190;
      const width = 14 + random() * 30;
      const height = 6 + random() * 16;
      mesas.push(
        matrixAt(
          Math.cos(angle) * radius,
          -2 + height * 0.15,
          Math.sin(angle) * radius,
          width,
          height,
          width * (0.6 + random() * 0.6),
          random() * Math.PI,
        ),
      );
    }
    group.add(instanced(rockGeo, rockMat, mesas, false));
    // 远景雾层：极简大气透视，把远山压到雾色里。
    const ridgeMat = new THREE.MeshBasicMaterial({
      color: theme.horizon.haze,
      transparent: true,
      opacity: 0.55,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const ridgeSegments = sphereSegmentsFor(quality);
    const ridge = new THREE.Mesh(
      new THREE.SphereGeometry(
        520,
        ridgeSegments.widthSegments,
        ridgeSegments.heightSegments,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.32,
      ),
      ridgeMat,
    );
    ridge.position.y = -30;
    owned.push(ridgeMat);
    group.add(ridge);
  }

  // 布幔：只挂在长墙内侧面，避免挂在立柱或拱门上挡住通路视线。
  const wallCandidates = level.boxes.filter((box) => {
    const height = box.max.y - box.min.y;
    const spanX = box.max.x - box.min.x;
    const spanZ = box.max.z - box.min.z;
    return height > 3 && Math.max(spanX, spanZ) > 12 && Math.min(spanX, spanZ) < 4;
  });
  const bannerCount = Math.min(level.decor.banners, wallCandidates.length);
  if (bannerCount > 0) {
    const cloth = new THREE.MeshStandardMaterial({
      color: theme.accent.ct,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    owned.push(cloth);    for (let i = 0; i < bannerCount; i += 1) {
      const box = wallCandidates[(i * 3 + 1) % wallCandidates.length];
      const height = Math.min(2.6, (box.max.y - box.min.y) * 0.4);
      const width = 1.1;
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(width, height, 4, 6), cloth);
      const z = box.max.z > 0 ? box.max.z - 0.06 : box.min.z + 0.06;
      banner.position.set(
        (box.min.x + box.max.x) * 0.5 + (i % 2 === 0 ? -1.5 : 1.5),
        box.max.y - height * 0.6,
        z,
      );
      banner.rotation.y = z > 0 ? 0 : Math.PI;
      banner.receiveShadow = true;
      group.add(banner);
    }
  }
  return group;
}

function buildDustMotes(
  level: LevelDefinition,
  quality: QualityPreset,
): { points: THREE.Points | null; material: THREE.PointsMaterial | null } {
  const count = Math.round(quality.dustMotes);
  if (count <= 0) return { points: null, material: null };
  const positions = new Float32Array(count * 3);
  const random = hashNoise(count * 17 + 3);
  const xs = level.boxes.reduce((acc, box) => Math.max(acc, box.max.x - box.min.x), 20);
  const zs = level.boxes.reduce((acc, box) => Math.max(acc, box.max.z - box.min.z), 20);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (random() - 0.5) * xs;
    positions[i * 3 + 1] = 0.3 + random() * 6;
    positions[i * 3 + 2] = (random() - 0.5) * zs;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: level.theme.horizon.haze,
    size: 0.055,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    sizeAttenuation: true,
    fog: true,
  });
  return { points: new THREE.Points(geometry, material), material };
}

export function buildLevel(level: LevelDefinition, materials: MaterialLibrary, quality: QualityPreset): LevelModel {
  const root = new THREE.Group();
  root.name = `level:${level.id}`;
  const owned: THREE.Material[] = [];
  const context: BuildContext = {
    level,
    materials,
    quality,
    random: hashNoise(level.id.length * 2654435761 + level.boxes.length),
    root,
    meshes: 0,
    owned,
  };

  for (const box of level.boxes) {
    const group = buildOneBox(box, context);
    root.add(group);
  }

  root.add(buildHorizon(level, materials, quality, owned));
  const motes = buildDustMotes(level, quality);
  if (motes.points) root.add(motes.points);
  if (motes.material) owned.push(motes.material);

  // 静态几何按材质合并：可见画面与阴影不变，draw call 从「零件数」降到「材质数」。
  const merge = mergeStaticMeshes(root);
  const detailParts = context.meshes + merge.sourceMeshes;

  let elapsed = 0;
  return {
    root,
    meshes: merge.drawObjects,
    detailParts,
    update(dt: number) {
      if (!motes.points) return;
      elapsed += dt;
      motes.points.rotation.y = elapsed * 0.01;
      motes.points.position.y = Math.sin(elapsed * 0.15) * 0.25;
    },
    dispose() {
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      // 只释放关卡自建的材质；共享材质由 MaterialLibrary 统一释放，
      // 因此切换画质重建模型时不会把仍在使用的材质销毁。
      for (const material of owned) material.dispose();
    },
  };
}
