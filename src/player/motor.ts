/**
 * CharacterMotor：把意图里的移动轴变成速度与位移（纯函数式一步积分）。
 *
 * 只做运动学和 AABB 盒体碰撞，不认识武器、回合、渲染：
 * - 手感参数集中在 MOTOR_DEFAULTS（速度/加速度/摩擦/重力/跳跃冲量），
 *   与拆分前的玩家数值完全一致；
 * - 碰撞世界由调用方注入（`MotorWorld` 接口或 `createBoxMotorWorld(boxes)`），
 *   马达不读取任何全局场景；
 * - 输出位移与 grounded 状态，状态转换（落地/起跳）通过状态转换函数写回。
 */
import { clamp, vec3, type Aabb, type Vec3 } from '../core/math';
import { WorldCollider } from '../world/collision';
import {
  CROUCH_RATE,
  landCharacter,
  launchCharacter,
  updateCrouch,
  type CharacterState,
} from './state';

/** 碰撞世界最小契约：把一次位移解析成合法位置 + 是否着地。与 WorldCollider 结构兼容。 */
export interface MotorWorld {
  move(
    position: Vec3,
    radius: number,
    height: number,
    delta: Vec3,
    stepHeight?: number,
  ): { position: Vec3; grounded: boolean; blocked?: boolean };
}

/** 用注入的 AABB 盒体集合构造碰撞世界（关卡/测试共用同一份盒体定义）。 */
export function createBoxMotorWorld(boxes: readonly Aabb[]): MotorWorld {
  return new WorldCollider(boxes.map((box) => ({ min: { ...box.min }, max: { ...box.max } })));
}

export interface MotorConfig {
  /** 角色碰撞半径（米）。 */
  radius: number;
  /** 跑速（米/秒）。 */
  runSpeed: number;
  /** 慢走速度（米/秒，Shift）。 */
  walkSpeed: number;
  /** 蹲伏速度（米/秒）。 */
  crouchSpeed: number;
  /** 地面加速度（米/秒²）。 */
  groundAcceleration: number;
  /** 空中加速度（米/秒²），远小于地面，保留既有空中微调手感。 */
  airAcceleration: number;
  /** 地面无输入时的摩擦减速度（米/秒²）。 */
  groundFriction: number;
  /** 重力加速度（米/秒²）。 */
  gravity: number;
  /** 起跳冲量（米/秒）。 */
  jumpSpeed: number;
  /** 最大下落速度（米/秒），防止长时间掉落数值爆掉。 */
  maxFallSpeed: number;
  /** 台阶高度（米），交给碰撞世界处理。 */
  stepHeight: number;
  /** 蹲伏量变化速度（1/秒）。 */
  crouchRate: number;
}

/** 拆分前 player.ts 里的玩家手感数值，原样保留（米、秒、弧度）。 */
export const MOTOR_DEFAULTS: MotorConfig = {
  radius: 0.38,
  runSpeed: 6,
  walkSpeed: 3.4,
  crouchSpeed: 2.6,
  groundAcceleration: 45,
  airAcceleration: 11,
  groundFriction: 45,
  gravity: 18,
  jumpSpeed: 5.4,
  maxFallSpeed: 40,
  stepHeight: 0.45,
  crouchRate: CROUCH_RATE,
};

/** 马达这一步需要的最小意图子集（ControlIntent 结构上满足它）。 */
export interface MotorIntent {
  move: { x: number; z: number };
  jump: boolean;
  crouch: boolean;
  walk?: boolean;
}

export interface MotorStepResult {
  /** 本步在世界坐标里的实际位移（米）。 */
  displacement: Vec3;
  grounded: boolean;
  /** 本步从空中落到地面。 */
  landed: boolean;
  /** 本步执行了起跳。 */
  jumped: boolean;
  /** 碰撞世界报告本步被阻挡（贴墙/撞盒体）。 */
  blocked: boolean;
}

function emptyStep(grounded: boolean): MotorStepResult {
  return { displacement: vec3(), grounded, landed: false, jumped: false, blocked: false };
}

/**
 * 走一步马达：计算期望速度 → 起跳/重力 → 交给碰撞世界解算位移。
 *
 * 就地修改 state 的 velocity / position / grounded / crouchAmount（含 height、eyeHeight），
 * 并返回本步位移与状态变化标志，便于上层做落地音效、动画事件等。
 */
export function stepCharacterMotor(
  state: CharacterState,
  intent: MotorIntent,
  dt: number,
  world: MotorWorld,
  config: MotorConfig = MOTOR_DEFAULTS,
): MotorStepResult {
  const step = Number.isFinite(dt) ? dt : 0;
  if (state.dead || step <= 0) {
    return emptyStep(state.grounded);
  }

  // 蹲伏是平滑量：碰撞盒与视高在同一帧内一起变化，避免“先矮后缩”或穿天花板。
  updateCrouch(state, step, intent.crouch, config.crouchRate);

  // 局部轴 → 世界轴：yaw 0 面向 -Z，右手方向为 (cos yaw, -sin yaw)。
  const forwardX = -Math.sin(state.yaw);
  const forwardZ = -Math.cos(state.yaw);
  const rightX = Math.cos(state.yaw);
  const rightZ = -Math.sin(state.yaw);
  let wishX = forwardX * intent.move.z + rightX * intent.move.x;
  let wishZ = forwardZ * intent.move.z + rightZ * intent.move.x;
  const wishLength = Math.hypot(wishX, wishZ);
  if (!Number.isFinite(wishLength)) {
    wishX = 0;
    wishZ = 0;
  } else if (wishLength > 1e-6) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }

  const targetSpeed = intent.crouch
    ? config.crouchSpeed
    : intent.walk
      ? config.walkSpeed
      : config.runSpeed;
  const hasInput = wishLength > 1e-6;
  const accel = hasInput
    ? state.grounded
      ? config.groundAcceleration
      : config.airAcceleration
    : state.grounded
      ? config.groundFriction
      : config.airAcceleration;
  const maxDelta = accel * step;
  state.velocity.x += clamp(wishX * targetSpeed - state.velocity.x, -maxDelta, maxDelta);
  state.velocity.z += clamp(wishZ * targetSpeed - state.velocity.z, -maxDelta, maxDelta);

  const wasGrounded = state.grounded;
  let jumped = false;
  if (intent.jump && state.grounded) {
    launchCharacter(state, config.jumpSpeed);
    jumped = true;
  }
  state.velocity.y = Math.max(-config.maxFallSpeed, state.velocity.y - config.gravity * step);

  const delta = {
    x: state.velocity.x * step,
    y: state.velocity.y * step,
    z: state.velocity.z * step,
  };
  const before: Vec3 = { x: state.position.x, y: state.position.y, z: state.position.z };
  const moved = world.move(state.position, config.radius, state.height, delta, config.stepHeight);
  state.position = { x: moved.position.x, y: moved.position.y, z: moved.position.z };
  state.grounded = moved.grounded;
  if (state.grounded && state.velocity.y < 0) {
    landCharacter(state);
  }
  const landed = !wasGrounded && state.grounded && !jumped;

  return {
    displacement: {
      x: state.position.x - before.x,
      y: state.position.y - before.y,
      z: state.position.z - before.z,
    },
    grounded: state.grounded,
    landed,
    jumped,
    blocked: moved.blocked ?? false,
  };
}
