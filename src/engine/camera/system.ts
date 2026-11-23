/**
 * CameraSystem：把 CameraTarget 解算成相机姿态。
 *
 * 三种模式：
 * - firstPerson：视点跟随眼睛，叠加后坐力与 trauma² 抖动；
 * - spectate：跟随观战目标（队友），目标全部失效时回退到死亡位置；
 * - thirdPersonDebug：绕焦点后上方跟随，带盒体遮挡回退。
 *
 * 系统不写全局状态、不读 Three.js 场景，也不读取伤害/回合/武器数值；
 * 调用方用 applyCameraPose(camera, pose) 把姿态交给渲染相机。
 */
import { clamp, type Aabb, type Vec3 } from '../../core/math';
import {
  DEFAULT_SHAKE_SCALE,
  copyVec3Into,
  createShakeOffsets,
  damp,
  dampAngle,
  dampVec3,
  distanceVec3,
  forwardFromAngles,
  normalizeQuat,
  quatFromEuler,
  sampleShake,
  smoothingAlpha,
  type Quat,
  type ShakeOffsets,
  type ShakeScale,
} from './math';
import { resolveOccludedDistance, type OcclusionOptions } from './occlusion';
import {
  DEFAULT_CAMERA_FOV,
  crouchAmount,
  resolveSpectateTarget,
  type CameraTarget,
  type SpectateCandidate,
} from './target';

export type CameraMode = 'firstPerson' | 'spectate' | 'thirdPersonDebug';

export const CAMERA_MODES: readonly CameraMode[] = ['firstPerson', 'spectate', 'thirdPersonDebug'];

export interface ThirdPersonConfig {
  /** 相机在焦点后方的距离（米）。 */
  distance: number;
  /** 相机抬升高度（米）。 */
  height: number;
}

export interface CameraSystemOptions {
  mode?: CameraMode;
  /** 基础 FOV；target.fov 为正时优先使用 target 的值。 */
  fov?: number;
  fovHalfLife?: number;
  positionHalfLife?: number;
  rotationHalfLife?: number;
  /** trauma 每秒自然衰减量。 */
  traumaDecay?: number;
  recoilHalfLife?: number;
  shakeScale?: Partial<ShakeScale>;
  /** 蹲伏时视点下沉量（米）。 */
  crouchDrop?: number;
  /** 第三人称跟随速度滞后时间（秒），用 target.velocity 让镜头略微拖尾。 */
  followLag?: number;
  thirdPerson?: Partial<ThirdPersonConfig>;
  occlusion?: OcclusionOptions & { enabled?: boolean };
  /** 位置差超过该值时直接吸附（重生/切换观战目标），避免相机扫过整张地图。 */
  snapDistance?: number;
}

export interface CameraPose {
  position: Vec3;
  quaternion: Quat;
  fov: number;
  yaw: number;
  pitch: number;
  roll: number;
  mode: CameraMode;
  /** 相机到焦点的实际距离（遮挡回退后的值）。 */
  distance: number;
}

export interface CameraDebugState {
  mode: CameraMode;
  fov: number;
  desiredFov: number;
  trauma: number;
  recoilPitch: number;
  recoilYaw: number;
  spectateId: string | null;
  position: Vec3;
  yaw: number;
  pitch: number;
}

const DEFAULT_OPTIONS = {
  positionHalfLife: 0.05,
  rotationHalfLife: 0.05,
  fovHalfLife: 0.12,
  traumaDecay: 0.85,
  recoilHalfLife: 0.07,
  crouchDrop: 0.52,
  snapDistance: 2.5,
  followLag: 0.06,
  thirdPerson: { distance: 3.2, height: 0.55 } as ThirdPersonConfig,
  occlusion: { enabled: true, margin: 0.22, minDistance: 0.18 },
};

export class CameraSystem {
  private currentMode: CameraMode;
  private readonly baseFov: number;
  private readonly fovHalfLife: number;
  private readonly positionHalfLife: number;
  private readonly rotationHalfLife: number;
  private readonly traumaDecay: number;
  private readonly recoilHalfLife: number;
  private readonly crouchDrop: number;
  private readonly snapDistance: number;
  private readonly followLag: number;
  private readonly thirdPerson: ThirdPersonConfig;
  private readonly occlusion: OcclusionOptions & { enabled: boolean };
  private readonly shakeScale: ShakeScale;

  private readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  private yaw = 0;
  private pitch = 0;
  private currentFov: number;
  private desiredFov: number;
  private initialized = false;
  private snapNext = true;
  private trauma = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private shakeTime = 0;
  private spectateIdValue: string | null = null;
  private occluders: readonly Aabb[] = [];
  private readonly offsets: ShakeOffsets = createShakeOffsets();

  constructor(options: CameraSystemOptions = {}) {
    this.currentMode = options.mode ?? 'firstPerson';
    this.baseFov = options.fov ?? DEFAULT_CAMERA_FOV;
    this.currentFov = this.baseFov;
    this.desiredFov = this.baseFov;
    this.fovHalfLife = options.fovHalfLife ?? DEFAULT_OPTIONS.fovHalfLife;
    this.positionHalfLife = options.positionHalfLife ?? DEFAULT_OPTIONS.positionHalfLife;
    this.rotationHalfLife = options.rotationHalfLife ?? DEFAULT_OPTIONS.rotationHalfLife;
    this.traumaDecay = options.traumaDecay ?? DEFAULT_OPTIONS.traumaDecay;
    this.recoilHalfLife = options.recoilHalfLife ?? DEFAULT_OPTIONS.recoilHalfLife;
    this.crouchDrop = options.crouchDrop ?? DEFAULT_OPTIONS.crouchDrop;
    this.snapDistance = options.snapDistance ?? DEFAULT_OPTIONS.snapDistance;
    this.followLag = Math.max(0, options.followLag ?? DEFAULT_OPTIONS.followLag);
    this.thirdPerson = {
      distance: options.thirdPerson?.distance ?? DEFAULT_OPTIONS.thirdPerson.distance,
      height: options.thirdPerson?.height ?? DEFAULT_OPTIONS.thirdPerson.height,
    };
    this.occlusion = {
      enabled: options.occlusion?.enabled ?? DEFAULT_OPTIONS.occlusion.enabled,
      margin: options.occlusion?.margin ?? DEFAULT_OPTIONS.occlusion.margin,
      minDistance: options.occlusion?.minDistance ?? DEFAULT_OPTIONS.occlusion.minDistance,
    };
    this.shakeScale = { ...DEFAULT_SHAKE_SCALE, ...options.shakeScale };
  }

  get mode(): CameraMode {
    return this.currentMode;
  }

  get fov(): number {
    return this.currentFov;
  }

  get traumaLevel(): number {
    return this.trauma;
  }

  /** 最近一次 compute 解算出的观战目标 id（无则 null）。 */
  get spectateId(): string | null {
    return this.spectateIdValue;
  }

  /** 切换模式：下一次 compute 直接吸附到新模式的期望姿态，避免镜头飞过场景。 */
  setMode(mode: CameraMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.snapNext = true;
  }

  setOccluders(boxes: readonly Aabb[]): void {
    this.occluders = boxes;
  }

  setThirdPerson(config: Partial<ThirdPersonConfig>): void {
    if (config.distance !== undefined) this.thirdPerson.distance = Math.max(0, config.distance);
    if (config.height !== undefined) this.thirdPerson.height = config.height;
  }

  /** 叠加一次后坐力冲量（弧度）。正值 pitch 向上。 */
  addRecoil(pitchKick: number, yawKick = 0): void {
    this.recoilPitch = clamp(this.recoilPitch + pitchKick, -0.3, 0.3);
    this.recoilYaw = clamp(this.recoilYaw + yawKick, -0.2, 0.2);
  }

  /** 叠加抖动能量（0..1），最终幅度为 trauma²。 */
  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  reset(): void {
    this.initialized = false;
    this.snapNext = true;
    this.trauma = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shakeTime = 0;
    this.spectateIdValue = null;
    this.currentFov = this.baseFov;
    this.desiredFov = this.baseFov;
    this.yaw = 0;
    this.pitch = 0;
    copyVec3Into(this.position, { x: 0, y: 0, z: 0 });
  }

  /**
   * 解算一帧姿态。dt 被限幅到 0..0.1，切后台回来不会一次跳变。
   * 返回新对象，不写全局状态。
   */
  compute(dt: number, target: CameraTarget): CameraPose {
    const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);

    this.trauma = Math.max(0, this.trauma - this.traumaDecay * step);
    const recoilAlpha = smoothingAlpha(this.recoilHalfLife, step);
    this.recoilPitch -= this.recoilPitch * recoilAlpha;
    this.recoilYaw -= this.recoilYaw * recoilAlpha;
    this.shakeTime += step;

    const focus = this.focusPoint(target);
    // trauma 有两个来源：系统内部冲量（addTrauma）与目标状态（target.shake），取较强者。
    const trauma = Math.max(this.trauma, clamp(target.shake, 0, 1));
    const desired = this.desiredPose(target, focus);

    if (this.snapNext) {
      this.snapTo(desired.position, desired.yaw, desired.pitch);
      this.snapNext = false;
    } else if (!this.initialized || distanceVec3(this.position, desired.position) > this.snapDistance) {
      // 远距离跳变（重生、切换观战目标）直接吸附，不做长距离插值。
      this.snapTo(desired.position, desired.yaw, desired.pitch);
    } else {
      dampVec3(this.position, desired.position, this.positionHalfLife, step);
      this.yaw = dampAngle(this.yaw, desired.yaw, this.rotationHalfLife, step);
      this.pitch = damp(this.pitch, desired.pitch, this.rotationHalfLife, step);
    }
    this.initialized = true;

    const wantedFov = this.resolveFov(target);
    this.desiredFov = wantedFov;
    this.currentFov = damp(this.currentFov, wantedFov, this.fovHalfLife, step);

    const shake = sampleShake(trauma, this.shakeTime, this.offsets, this.shakeScale);
    const yaw = this.yaw + shake.yaw;
    const pitch = this.pitch + shake.pitch;
    const roll = shake.roll;

    const pose: CameraPose = {
      position: {
        x: this.position.x + shake.position.x,
        y: this.position.y + shake.position.y,
        z: this.position.z + shake.position.z,
      },
      quaternion: normalizeQuat(quatFromEuler(yaw, pitch, roll)),
      fov: this.currentFov,
      yaw,
      pitch,
      roll,
      mode: this.currentMode,
      distance: desired.distance,
    };
    return pose;
  }

  /** 供调试钩子/测试读取的当前内部状态（只读快照）。 */
  debugState(): CameraDebugState {
    return {
      mode: this.currentMode,
      fov: this.currentFov,
      desiredFov: this.desiredFov,
      trauma: this.trauma,
      recoilPitch: this.recoilPitch,
      recoilYaw: this.recoilYaw,
      spectateId: this.spectateIdValue,
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  private snapTo(position: Vec3, yaw: number, pitch: number): void {
    copyVec3Into(this.position, position);
    this.yaw = yaw;
    this.pitch = pitch;
  }

  private resolveFov(target: CameraTarget): number {
    const wanted = target.fov > 0 ? target.fov : this.baseFov;
    return clamp(wanted, 20, 140);
  }

  /** 焦点：站立视点按蹲伏量下沉。 */
  private focusPoint(target: CameraTarget): Vec3 {
    return {
      x: target.eye.x,
      y: target.eye.y - this.crouchDrop * crouchAmount(target),
      z: target.eye.z,
    };
  }

  private desiredPose(
    target: CameraTarget,
    focus: Vec3,
  ): { position: Vec3; yaw: number; pitch: number; distance: number } {
    if (this.currentMode === 'spectate') {
      const candidate: SpectateCandidate | null = resolveSpectateTarget(target.spectate);
      this.spectateIdValue = candidate ? candidate.id : null;
      if (candidate) {
        return {
          position: { x: candidate.eye.x, y: candidate.eye.y, z: candidate.eye.z },
          yaw: candidate.yaw,
          pitch: candidate.pitch,
          distance: 0,
        };
      }
      // 没有可用观战目标：停在死亡位置，保持原朝向后拉一点点。
      return {
        position: { x: focus.x, y: focus.y, z: focus.z },
        yaw: target.yaw,
        pitch: target.pitch,
        distance: 0,
      };
    }

    this.spectateIdValue = null;
    if (this.currentMode === 'thirdPersonDebug') {
      const direction = forwardFromAngles(target.yaw, target.pitch);
      const offset: Vec3 = {
        x: -direction.x * this.thirdPerson.distance,
        y: -direction.y * this.thirdPerson.distance + this.thirdPerson.height,
        z: -direction.z * this.thirdPerson.distance,
      };
      // 跟随滞后：镜头焦点落后于角色速度 * followLag，移动时有拖尾感。
      const lagged: Vec3 = {
        x: focus.x - target.velocity.x * this.followLag,
        y: focus.y,
        z: focus.z - target.velocity.z * this.followLag,
      };
      const raw: Vec3 = { x: lagged.x + offset.x, y: lagged.y + offset.y, z: lagged.z + offset.z };
      const resolved = this.applyOcclusion(lagged, raw);
      return {
        position: resolved,
        yaw: target.yaw,
        pitch: target.pitch,
        distance: Math.max(0, distanceVec3(lagged, resolved)),
      };
    }

    return {
      position: { x: focus.x, y: focus.y, z: focus.z },
      yaw: target.yaw + target.recoil.yaw + this.recoilYaw,
      pitch: target.pitch + target.recoil.pitch + this.recoilPitch,
      distance: 0,
    };
  }

  /** 相机不穿墙：沿焦点 → 相机方向做一次射线回退。 */
  private applyOcclusion(focus: Vec3, raw: Vec3): Vec3 {
    if (!this.occlusion.enabled || this.occluders.length === 0) return raw;
    const delta: Vec3 = { x: raw.x - focus.x, y: raw.y - focus.y, z: raw.z - focus.z };
    const distance = Math.hypot(delta.x, delta.y, delta.z);
    if (distance < 1e-5) return raw;
    const direction: Vec3 = { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance };
    const limited = resolveOccludedDistance(focus, direction, distance, this.occluders, this.occlusion);
    if (limited >= distance) return raw;
    return {
      x: focus.x + direction.x * limited,
      y: focus.y + direction.y * limited,
      z: focus.z + direction.z * limited,
    };
  }
}
