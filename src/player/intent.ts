/**
 * ControlIntent：输入设备 → 控制层的唯一数据通道（纯数据，无 DOM）。
 *
 * DOM 事件仍留在 src/core/input 与 src/ui/main 的输入层；
 * 这一层把“这一帧玩家想做什么”抽象成与设备无关的意图，
 * 控制系统只消费意图，不再直接看键盘/鼠标。
 */
import type { InputSnapshot } from '../core/input';
import type { WeaponId } from '../game/types';

/** 鼠标灵敏度（弧度/像素），与既有手感保持一致。 */
export const LOOK_SENSITIVITY = 0.0022;

/** 局部移动轴（长度 ≤ 1，对角线已在生成时归一化）。 */
export interface MoveAxis {
  /** +1 = 右（D），-1 = 左（A）。 */
  x: number;
  /** +1 = 前（W），-1 = 后（S）。 */
  z: number;
}

/** 视角增量（弧度/帧）。正值 pitch 抬头；yaw 为加法增量，向右转是负值（yaw 0 面向 -Z）。 */
export interface LookDelta {
  yaw: number;
  pitch: number;
}

export interface ControlIntent {
  move: MoveAxis;
  look: LookDelta;
  jump: boolean;
  crouch: boolean;
  /** 慢走（Shift）；保留既有手感参数，不属于武器规则。 */
  walk: boolean;
  fire: boolean;
  reload: boolean;
  switchWeapon: WeaponId | null;
}

/** 零意图：静止、不转视角、不按任何动作键。 */
export function createControlIntent(): ControlIntent {
  return {
    move: { x: 0, z: 0 },
    look: { yaw: 0, pitch: 0 },
    jump: false,
    crouch: false,
    walk: false,
    fire: false,
    reload: false,
    switchWeapon: null,
  };
}

/** 鼠标像素位移 → 视角增量（弧度）。右移鼠标向右转（yaw 减小）。 */
export function lookDeltaFromMouse(
  mouseDX: number,
  mouseDY: number,
  sensitivity = LOOK_SENSITIVITY,
): LookDelta {
  const dx = Number.isFinite(mouseDX) ? mouseDX : 0;
  const dy = Number.isFinite(mouseDY) ? mouseDY : 0;
  return { yaw: -dx * sensitivity, pitch: -dy * sensitivity };
}

/** 按键轴 → 归一化移动轴：对角线不会被加速（长度上限 1）。 */
export function normalizeMoveAxis(x: number, z: number): MoveAxis {
  const ax = Number.isFinite(x) ? x : 0;
  const az = Number.isFinite(z) ? z : 0;
  const length = Math.hypot(ax, az);
  if (length <= 1e-6) {
    return { x: 0, z: 0 };
  }
  if (length <= 1) {
    return { x: ax, z: az };
  }
  return { x: ax / length, z: az / length };
}

/**
 * 输入快照 → 控制意图。
 *
 * 只做纯映射：不读取任何全局状态、不修改输入快照，
 * 因此可以在 Node 里用普通对象直接测“按键 → 意图”。
 */
export function intentFromInput(
  input: InputSnapshot,
  sensitivity = LOOK_SENSITIVITY,
): ControlIntent {
  return {
    move: normalizeMoveAxis(
      (input.right ? 1 : 0) - (input.left ? 1 : 0),
      (input.forward ? 1 : 0) - (input.back ? 1 : 0),
    ),
    look: lookDeltaFromMouse(input.mouseDX, input.mouseDY, sensitivity),
    jump: input.jump,
    crouch: input.crouch,
    walk: input.walk,
    fire: input.fire,
    reload: input.reloadRequest,
    switchWeapon: input.switchRequest,
  };
}

/** 合并两帧意图（固定步长循环里把一帧输入摊到多步时使用）：移动取较大轴、动作取或、视角相加。 */
export function mergeControlIntent(a: ControlIntent, b: ControlIntent): ControlIntent {
  return {
    move: normalizeMoveAxis(a.move.x + b.move.x, a.move.z + b.move.z),
    look: { yaw: a.look.yaw + b.look.yaw, pitch: a.look.pitch + b.look.pitch },
    jump: a.jump || b.jump,
    crouch: a.crouch || b.crouch,
    walk: a.walk || b.walk,
    fire: a.fire || b.fire,
    reload: a.reload || b.reload,
    switchWeapon: b.switchWeapon ?? a.switchWeapon,
  };
}

/** 去掉一次性动作（换弹/切枪）与视角增量，用于固定步长的后续步。 */
export function withoutOneShot(intent: ControlIntent): ControlIntent {
  return {
    move: intent.move,
    look: { yaw: 0, pitch: 0 },
    jump: intent.jump,
    crouch: intent.crouch,
    walk: intent.walk,
    fire: intent.fire,
    reload: false,
    switchWeapon: null,
  };
}
