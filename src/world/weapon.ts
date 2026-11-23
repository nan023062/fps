import * as THREE from 'three';
import { capsuleBetween, mergedModel, part, roundedBox, type PartSpec } from './geometry';

export type WeaponModelId = 'rifle' | 'pistol';

/**
 * 分层程序化武器：机匣、枪管、护木、弹匣、瞄具、握把、枪托等独立零件，
 * 玩家视图模型与 Bot 手持武器共用同一份构建代码。
 */

const steel = new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.4, metalness: 0.88 });
const steelBright = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.28, metalness: 0.95 });
const polymer = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.72, metalness: 0.08 });
const polymerTan = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.68, metalness: 0.06 });
const woodMat = new THREE.MeshStandardMaterial({ color: 0x6d4b2a, roughness: 0.82, metalness: 0.02 });
const rubber = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.95, metalness: 0.02 });
const lens = new THREE.MeshPhysicalMaterial({
  color: 0x2b6f8f,
  roughness: 0.05,
  metalness: 0.35,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
  emissive: 0x0e2b38,
  emissiveIntensity: 0.4,
});
const brass = new THREE.MeshStandardMaterial({ color: 0xb08c46, roughness: 0.35, metalness: 0.9 });

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
  parts.push(part(roundedBox(0.068, 0.092, 0.3, 0.012, 2), polymer, at(0, 0, 0.03)));
  parts.push(part(roundedBox(0.05, 0.024, 0.26, 0.006, 1), steel, at(0, 0.058, 0.03)));
  parts.push(...railTeeth(10, 0.14, 0.076, steel));
  parts.push(part(new THREE.BoxGeometry(0.004, 0.05, 0.1), steel, at(0.036, 0.015, -0.01)));
  parts.push(part(new THREE.BoxGeometry(0.012, 0.01, 0.045), steel, at(0.042, 0.048, 0.1)));

  // 枪管 / 导气 / 消焰器
  parts.push(capsuleBetween(at(0, 0.012, -0.12), at(0, 0.012, -0.5), 0.013, steelBright, 3, 10));
  parts.push(part(new THREE.BoxGeometry(0.034, 0.032, 0.05), steel, at(0, 0.036, -0.3)));
  parts.push(part(new THREE.CylinderGeometry(0.02, 0.022, 0.075, 12), steel, at(0, 0.012, -0.53), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.024, 0.024, 0.012, 12), steelBright, at(0, 0.012, -0.49), euler(Math.PI / 2)));

  // 护木 + 散热槽 + 前握把
  parts.push(part(roundedBox(0.058, 0.07, 0.22, 0.01, 2), woodMat, at(0, -0.002, -0.28)));
  for (const z of [-0.22, -0.28, -0.34]) {
    parts.push(part(new THREE.BoxGeometry(0.062, 0.012, 0.02), polymer, at(0, 0.028, z)));
    parts.push(part(new THREE.BoxGeometry(0.012, 0.03, 0.02), steel, at(0.032, -0.004, z - 0.005)));
    parts.push(part(new THREE.BoxGeometry(0.012, 0.03, 0.02), steel, at(-0.032, -0.004, z - 0.005)));
  }
  parts.push(part(roundedBox(0.026, 0.09, 0.034, 0.01, 1), polymer, at(0, -0.075, -0.24), euler(0.16)));

  // 准星护翼
  parts.push(part(new THREE.BoxGeometry(0.01, 0.055, 0.012), steel, at(0, 0.055, -0.42)));
  parts.push(part(new THREE.BoxGeometry(0.036, 0.05, 0.01), steel, at(0, 0.055, -0.42)));

  // 瞄具：底座 + 镜筒 + 物镜 + 目镜
  parts.push(part(roundedBox(0.034, 0.022, 0.09, 0.006, 1), steel, at(0, 0.078, -0.03)));
  parts.push(part(new THREE.CylinderGeometry(0.026, 0.026, 0.12, 14), steel, at(0, 0.104, -0.03), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.03, 0.024, 0.02, 14), steel, at(0, 0.104, -0.092), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.02, 0.02, 0.006, 16), lens, at(0, 0.104, -0.1), euler(Math.PI / 2)));
  parts.push(part(new THREE.CylinderGeometry(0.026, 0.028, 0.016, 14), rubber, at(0, 0.104, 0.036), euler(Math.PI / 2)));
  parts.push(part(new THREE.BoxGeometry(0.05, 0.012, 0.014), steel, at(0, 0.089, 0.042)));
  parts.push(part(new THREE.CylinderGeometry(0.008, 0.008, 0.016, 8), brass, at(0.03, 0.104, -0.03), euler(0, 0, Math.PI / 2)));

  // 弹匣（两段折角，接近弯曲弹匣）+ 弹匣井
  parts.push(part(roundedBox(0.052, 0.14, 0.072, 0.008, 1), polymer, at(0, -0.115, 0.06), euler(0.12)));
  parts.push(part(roundedBox(0.05, 0.08, 0.066, 0.008, 1), polymer, at(0, -0.205, 0.028), euler(0.34)));
  parts.push(part(new THREE.BoxGeometry(0.06, 0.02, 0.08), steel, at(0, -0.055, 0.055)));

  // 握把 / 扳机护圈 / 扳机
  parts.push(part(roundedBox(0.042, 0.13, 0.058, 0.012, 2), polymerTan, at(0, -0.1, 0.15), euler(-0.34)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.008, 0.075), steel, at(0, -0.062, 0.13)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.05, 0.008), steel, at(0.026, -0.04, 0.098)));
  parts.push(part(new THREE.BoxGeometry(0.008, 0.05, 0.008), steel, at(-0.026, -0.04, 0.098)));
  parts.push(part(new THREE.BoxGeometry(0.006, 0.026, 0.008), steel, at(0, -0.045, 0.115), euler(0.3)));

  // 枪托：缓冲管 + 托体 + 托底 + 贴腮
  parts.push(part(new THREE.CylinderGeometry(0.017, 0.017, 0.16, 10), steel, at(0, 0.022, 0.24), euler(Math.PI / 2)));
  parts.push(part(roundedBox(0.05, 0.09, 0.17, 0.014, 2), polymer, at(0, -0.004, 0.33)));
  parts.push(part(new THREE.BoxGeometry(0.054, 0.12, 0.02), rubber, at(0, -0.012, 0.415)));
  parts.push(part(roundedBox(0.05, 0.02, 0.1, 0.008, 1), polymerTan, at(0, 0.046, 0.31)));
  parts.push(part(new THREE.TorusGeometry(0.018, 0.004, 6, 12), steel, at(0.04, -0.03, 0.28), euler(0, Math.PI / 2)));

  // 抛壳口 / 拉机柄
  parts.push(part(new THREE.BoxGeometry(0.002, 0.028, 0.07), rubber, at(0.035, 0.02, -0.02)));
  parts.push(part(new THREE.BoxGeometry(0.02, 0.012, 0.03), steel, at(-0.04, 0.05, 0.06)));
  return parts;
}

function pistolParts(): PartSpec[] {
  const parts: PartSpec[] = [];
  const euler = (x = 0, y = 0, z = 0): THREE.Euler => new THREE.Euler(x, y, z);
  const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  parts.push(part(roundedBox(0.046, 0.062, 0.22, 0.012, 2), steel, at(0, 0.022, -0.03)));
  parts.push(part(roundedBox(0.042, 0.04, 0.19, 0.01, 2), polymer, at(0, -0.022, -0.01)));
  parts.push(capsuleBetween(at(0, 0.02, -0.11), at(0, 0.02, -0.16), 0.011, steelBright, 3, 10));
  parts.push(part(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 12), steelBright, at(0, 0.02, -0.155), euler(Math.PI / 2)));
  parts.push(part(roundedBox(0.04, 0.13, 0.052, 0.012, 2), polymer, at(0, -0.095, 0.05), euler(-0.22)));
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
