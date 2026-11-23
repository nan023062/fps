/**
 * PlayerController：玩家的绑定层（健康/护甲/武器库存 + 对外兼容 API）。
 *
 * 3C 拆分后各层职责：
 * - src/player/intent.ts  ControlIntent（与输入设备解耦的纯数据）；
 * - src/player/state.ts   CharacterState（位置/速度/视角/蹲伏/死亡/换弹）；
 * - src/player/motor.ts   CharacterMotor（速度/加速度/摩擦/重力/跳跃/AABB 碰撞）；
 * - src/player/control.ts PlayerControlSystem（消费意图与 dt，产出 CharacterState）；
 * - src/game/threeC.ts    CharacterState → CharacterRenderState / CameraTarget 的 3C 契约。
 *
 * 本类不再自己算运动或碰撞：运动全部委托给 PlayerControlSystem，
 * 这里保留拆分前的公开成员（position/yaw/pitch/crouchAmount/update/look/...），
 * 让既有用例与调用方无需改写。武器数值、伤害与命中规则不在这里。
 */
import { clamp, directionFromAngles, type Aabb, type Vec3 } from '../core/math';
import type { InputSnapshot } from '../core/input';
import { applyRawDamage } from '../combat/combat';
import { createWeapon, refillWeapon, updateWeapon } from '../combat/weapons';
import type { Team, WeaponId, WeaponState } from '../game/types';
import { PlayerControlSystem } from './control';
import { intentFromInput, lookDeltaFromMouse, LOOK_SENSITIVITY, type ControlIntent } from './intent';
import { MOTOR_DEFAULTS, type MotorWorld, type MotorStepResult } from './motor';
import {
  eyePosition,
  horizontalSpeed,
  isAirborne,
  setCrouch,
  type CharacterState,
} from './state';

export { LOOK_SENSITIVITY };
export type { ControlIntent };
/** 兼容旧名字：运动世界（碰撞）接口。 */
export type MovementWorld = MotorWorld;

/** 玩家碰撞盒半径（米）。 */
export const PLAYER_RADIUS = MOTOR_DEFAULTS.radius;

export class PlayerController {
  readonly id = 'player';
  readonly name = '你';
  readonly team: Team = 'ct';
  readonly isPlayer = true;
  /** 控制系统：唯一可写位置/速度/视角/蹲伏的地方。 */
  readonly control: PlayerControlSystem;
  health = 100;
  armor = 100;
  kills = 0;
  deaths = 0;
  weapons: Record<WeaponId, WeaponState>;

  constructor(spawn: Vec3, yaw = 0) {
    this.control = new PlayerControlSystem(spawn, yaw);
    this.weapons = {
      rifle: createWeapon('rifle'),
      pistol: createWeapon('pistol'),
    };
  }

  /** 控制状态（3C 契约的输入；只读引用，不要在外层直接改）。 */
  get controlState(): CharacterState {
    return this.control.state;
  }

  /** 本体状态的一个快照语义别名，供相机/渲染映射使用。 */
  get state(): CharacterState {
    return this.control.state;
  }

  get position(): Vec3 {
    return this.control.state.position;
  }

  set position(value: Vec3) {
    this.control.state.position = { ...value };
  }

  get velocity(): Vec3 {
    return this.control.state.velocity;
  }

  set velocity(value: Vec3) {
    this.control.state.velocity = { ...value };
  }

  get yaw(): number {
    return this.control.state.yaw;
  }

  set yaw(value: number) {
    this.control.state.yaw = value;
  }

  get pitch(): number {
    return this.control.state.pitch;
  }

  set pitch(value: number) {
    this.control.state.pitch = clamp(value, -1.45, 1.45);
  }

  get grounded(): boolean {
    return this.control.state.grounded;
  }

  set grounded(value: boolean) {
    this.control.state.grounded = value;
  }

  get crouchAmount(): number {
    return this.control.state.crouchAmount;
  }

  set crouchAmount(value: number) {
    setCrouch(this.control.state, value);
  }

  get alive(): boolean {
    return !this.control.state.dead;
  }

  /** CombatDirector 会直接写 alive；这里同步到控制状态，避免两份事实不一致。 */
  set alive(value: boolean) {
    if (value) {
      this.control.state.dead = false;
    } else {
      this.control.die();
    }
  }

  get weaponId(): WeaponId {
    return this.control.state.weaponId;
  }

  set weaponId(value: WeaponId) {
    this.control.state.weaponId = value;
  }

  /** 站立/蹲伏碰撞盒高度（米）。 */
  get height(): number {
    return this.control.state.height;
  }

  /** 视点相对脚底的高度（米）：站立 1.62，全蹲 1.10。 */
  get eyeHeight(): number {
    return this.control.state.eyeHeight;
  }

  get crouching(): boolean {
    return this.control.state.crouchAmount > 0.5;
  }

  /** 是否腾空（grounded 的派生状态）。 */
  get airborne(): boolean {
    return isAirborne(this.control.state);
  }

  /** 换弹中（武器层的只读镜像）。 */
  get reloading(): boolean {
    return this.control.state.reloading;
  }

  eyePosition(): Vec3 {
    return eyePosition(this.control.state);
  }

  lookDirection(): Vec3 {
    return directionFromAngles(this.control.state.yaw, this.control.state.pitch);
  }

  currentWeapon(): WeaponState {
    return this.weapons[this.weaponId];
  }

  bodyBox(): Aabb {
    const h = this.height;
    const position = this.control.state.position;
    return {
      min: { x: position.x - 0.38, y: position.y, z: position.z - 0.38 },
      max: { x: position.x + 0.38, y: position.y + h - 0.38, z: position.z + 0.38 },
    };
  }

  headBox(): Aabb {
    const h = this.height;
    const position = this.control.state.position;
    return {
      min: { x: position.x - 0.22, y: position.y + h - 0.42, z: position.z - 0.22 },
      max: { x: position.x + 0.22, y: position.y + h, z: position.z + 0.22 },
    };
  }

  /** 鼠标像素位移 → 视角（弧度量纲的意图增量）。 */
  look(mouseDX: number, mouseDY: number, sensitivity = LOOK_SENSITIVITY): void {
    const delta = lookDeltaFromMouse(mouseDX, mouseDY, sensitivity);
    this.control.look(delta.yaw, delta.pitch);
  }

  addRecoil(kick: number): void {
    this.control.addRecoil(kick);
  }

  switchWeapon(id: WeaponId): boolean {
    if (!this.alive || this.weaponId === id) return false;
    this.weaponId = id;
    this.syncWeaponState();
    return true;
  }

  speedRatio(): number {
    return this.control.speedRatio();
  }

  /** 水平速度（米/秒），3C 契约与动画使用。 */
  horizontalSpeed(): number {
    return horizontalSpeed(this.control.state);
  }

  /**
   * 兼容入口：把原始输入快照映射成 ControlIntent 后交给控制系统。
   * Match 现在的编排走 applyIntent，两步等价。
   */
  update(dt: number, input: InputSnapshot, world: MotorWorld): void {
    this.applyIntent(intentFromInput(input), dt, world);
  }

  /** 正式入口：消费意图 + dt + 碰撞世界，产出 CharacterState。 */
  applyIntent(intent: ControlIntent, dt: number, world: MotorWorld): MotorStepResult | null {
    if (!this.alive) return null;
    // 武器冷却/换弹计时属于武器层，控制层只同步只读镜像。
    updateWeapon(this.weapons.rifle, dt);
    updateWeapon(this.weapons.pistol, dt);
    const step = this.control.applyIntent(intent, dt, world);
    this.syncWeaponState();
    return step;
  }

  /** 把武器层的换弹/手持武器状态同步进控制状态。 */
  syncWeaponState(): void {
    this.control.setWeaponState(this.weaponId, this.currentWeapon().reloading);
  }

  /**
   * 单角色直接扣血，仅供单元测试与工具使用。
   * 对局中的伤害、击杀归属与击杀信息统一走 CombatDirector，不要在这里做击杀统计。
   */
  applyDamage(rawDamage: number): boolean {
    if (!this.alive) return false;
    const { remainingHealth } = applyRawDamage(this, rawDamage);
    if (remainingHealth <= 0) {
      this.alive = false;
      this.deaths += 1;
      return true;
    }
    return false;
  }

  /** 重生：控制状态复位到出生点，武器重新装填；击杀/死亡统计不在这里清零。 */
  reset(spawn: Vec3, yaw = 0): void {
    this.control.respawn(spawn, yaw, 'rifle');
    this.health = 100;
    this.armor = 100;
    refillWeapon(this.weapons.rifle);
    refillWeapon(this.weapons.pistol);
    this.syncWeaponState();
  }

  /** 死亡转换（伤害规则之外只有测试/工具会直接调用）。 */
  die(): void {
    this.control.die();
  }
}
