/**
 * PlayerControlSystem：玩家控制的唯一入口。
 *
 * 消费 ControlIntent + dt + 注入的碰撞世界，产出（就地维护）CharacterState：
 * - 视角：意图里的 yaw/pitch 增量直接累加，pitch 夹取到 ±1.45；
 * - 运动：全部交给 CharacterMotor（速度/加速度/摩擦/重力/跳跃/AABB 碰撞）；
 * - 状态：蹲伏平滑、落地/起跳、死亡/重生、换弹与手持武器的只读镜像。
 *
 * 本文件不 import Three.js、DOM、相机或渲染；碰撞世界只通过接口注入。
 */
import { clamp, vec3, type Vec3 } from '../core/math';
import type { WeaponId } from '../game/types';
import type { ControlIntent } from './intent';
import { MOTOR_DEFAULTS, stepCharacterMotor, type MotorConfig, type MotorStepResult, type MotorWorld } from './motor';
import {
  PITCH_LIMIT,
  applyLookDelta,
  createCharacterState,
  horizontalSpeed,
  killCharacter,
  respawnCharacter,
  type CharacterState,
} from './state';

export interface ControlStepResult extends MotorStepResult {
  /** 本步是否因为阵亡而没有进行任何控制。 */
  skipped: boolean;
}

export class PlayerControlSystem {
  readonly state: CharacterState;
  private config: MotorConfig;

  constructor(spawn: Vec3, yaw = 0, config: Partial<MotorConfig> = {}) {
    this.state = createCharacterState(spawn, yaw);
    this.config = { ...MOTOR_DEFAULTS, ...config };
  }

  /** 当前生效的手感参数（只读快照，避免外部改到运行中的配置）。 */
  get motorConfig(): MotorConfig {
    return { ...this.config };
  }

  /** 运行时调参入口（默认数值来自 MOTOR_DEFAULTS，本任务不改手感）。 */
  setMotorConfig(patch: Partial<MotorConfig>): MotorConfig {
    this.config = { ...this.config, ...patch };
    return this.motorConfig;
  }

  /** 应用一帧意图；返回本步位移与状态变化，便于上层做表现与规则编排。 */
  applyIntent(intent: ControlIntent, dt: number, world: MotorWorld): ControlStepResult {
    if (this.state.dead) {
      return {
        displacement: vec3(),
        grounded: this.state.grounded,
        landed: false,
        jumped: false,
        blocked: false,
        skipped: true,
      };
    }
    applyLookDelta(this.state, intent.look.yaw, intent.look.pitch);
    const step = stepCharacterMotor(this.state, intent, dt, world, this.config);
    return { ...step, skipped: false };
  }

  /** 视角增量（例如后坐力抬头）；与意图共用同一套夹取规则。 */
  look(yawDelta: number, pitchDelta: number): void {
    applyLookDelta(this.state, yawDelta, pitchDelta);
  }

  /** 后坐力抬头：纯视角偏移，不改武器数值。 */
  addRecoil(kick: number): void {
    this.state.pitch = clamp(this.state.pitch + kick, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** 武器层把换弹与手持武器同步进控制状态（只读镜像，规则仍在武器层）。 */
  setWeaponState(weaponId: WeaponId, reloading: boolean): void {
    this.state.weaponId = weaponId;
    this.state.reloading = this.state.dead ? false : reloading;
  }

  /** 水平速度占跑速比例（扩散/动画使用）。 */
  speedRatio(): number {
    const speed = horizontalSpeed(this.state);
    return clamp(speed / this.config.runSpeed, 0, 1);
  }

  /** 死亡转换：之后的意图不再生效，直到重生或回合重置。 */
  die(): void {
    killCharacter(this.state);
  }

  /** 重生转换：出生点 + 站立视角 + 清空速度与蹲伏。 */
  respawn(spawn: Vec3, yaw = 0, weaponId: WeaponId = 'rifle'): void {
    respawnCharacter(this.state, spawn, yaw, weaponId);
  }
}
