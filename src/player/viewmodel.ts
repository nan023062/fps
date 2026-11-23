import * as THREE from 'three';
import type { WeaponId } from '../game/types';
import { buildWeaponModel, type WeaponModel } from '../world/weapon';

/**
 * 第一人称视图模型：与 Bot 手持武器共用 src/world/weapon.ts 的分层程序化枪械，
 * 这里只负责持枪姿态、呼吸摆动与换弹动画。
 */
export class ViewModel {
  readonly group = new THREE.Group();
  private readonly weapons: Record<WeaponId, WeaponModel>;
  private weapon: WeaponId = 'rifle';
  private recoil = 0;
  private reloadOffset = 0;
  private reloading = false;
  private bobTime = 0;

  constructor(camera: THREE.Camera) {
    this.weapons = {
      rifle: buildWeaponModel('rifle', false),
      pistol: buildWeaponModel('pistol', false),
    };
    // 视图模型不参与阴影：避免近处枪械把大片阴影投进场景。
    this.group.add(this.weapons.rifle.group, this.weapons.pistol.group);
    this.group.position.set(0.27, -0.25, -0.5);
    this.group.scale.setScalar(0.8);
    camera.add(this.group);
    this.setWeapon('rifle');
  }

  setWeapon(id: WeaponId): void {
    this.weapon = id;
    this.weapons.rifle.group.visible = id === 'rifle';
    this.weapons.pistol.group.visible = id === 'pistol';
  }

  triggerRecoil(): void {
    this.recoil = Math.min(1, this.recoil + 0.55);
  }

  setReloading(reloading: boolean): void {
    this.reloading = reloading;
  }

  getMuzzleWorldPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return this.weapons[this.weapon].muzzle.getWorldPosition(target);
  }

  update(dt: number, moving: boolean, crouchAmount: number): void {
    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.bobTime += dt * (moving ? 9 : 2.2);
    const bob = Math.sin(this.bobTime) * (moving ? 0.01 : 0.0025);
    const reloadTarget = this.reloading ? -0.85 : 0;
    this.reloadOffset += (reloadTarget - this.reloadOffset) * Math.min(1, dt * 7);

    this.group.position.set(
      0.28 + bob * 0.45,
      -0.26 + bob - crouchAmount * 0.025 - this.recoil * 0.02,
      -0.48 + this.recoil * 0.06,
    );
    this.group.rotation.set(
      -this.recoil * 0.12 + this.reloadOffset * 0.45,
      this.reloadOffset * 0.2,
      this.reloadOffset * 0.65,
    );
  }
}
