/**
 * CharacterView：把 CharacterRenderState 变成三段式角色动画。
 *
 * 数据流：CharacterRenderState（纯数据）→ E1 AnimationMixer（layer 0 locomotion、
 * layer 1 上半身瞄准、layer 2 开火 additive、layer 3 换弹）→ 上半身 pitch 与蹲伏
 * 的两层 E1 applyMaskedLayer → 写入 Three 骨骼（SkinnedMesh 蒙皮）。
 *
 * 这里唯一的 Three.js 使用者是 CharacterView 本身；状态与片段都是纯数据。
 */
import * as THREE from 'three';
import {
  AnimationMixer,
  applyMaskedLayer,
  restPose,
  velocityBlend,
  type MixerEvent,
  type Pose,
  type Skeleton,
} from '../engine/anim';
import { buildCharacterModel, type CharacterModel, type CharacterPerfStats } from '../world/character';
import { createHumanMasks, createHumanSkeleton, humanJointIndex, type HumanJoint, type HumanMasks } from './rig';
import {
  aimWeaponMountRotation,
  createHumanClips,
  RELOAD_CLIP_DURATION,
  RELOAD_SECONDS,
  type HumanClips,
} from './clips';
import {
  animationParams,
  transitionEvents,
  type CharacterActionEvent,
  type CharacterAnimationMode,
  type CharacterRenderState,
  type CharacterTeam,
  type CharacterWeaponId,
} from './state';

export interface CharacterViewOptions {
  team: CharacterTeam;
  accent: number;
  variant?: number;
}

export interface CharacterDebugState {
  team: CharacterTeam;
  weaponId: CharacterWeaponId;
  alive: boolean;
  mode: CharacterAnimationMode;
  speed: number;
  aimPitch: number;
  crouch: number;
  weights: { idle: number; walk: number; run: number };
  aimWeight: number;
  reloadWeight: number;
  timeScale: number;
  playing: string[];
  /** 累计事件计数，用于确认动画事件真的在触发。 */
  events: { footstep: number; muzzle: number; reload: number; death: number };
  perf: CharacterPerfStats;
  position: { x: number; y: number; z: number };
  yaw: number;
}


export class CharacterView {
  readonly group: THREE.Group;
  readonly skeleton: Skeleton;
  readonly mixer: AnimationMixer;
  readonly model: CharacterModel;
  readonly clips: HumanClips;
  readonly masks: HumanMasks;
  readonly index: Record<HumanJoint, number>;

  private readonly rest: Pose;
  private readonly team: CharacterTeam;
  private weaponId: CharacterWeaponId = 'rifle';
  private alive = true;
  private aimWeight = 0;
  private reloadWeight = 0;
  private crouch = 0;
  private timeScale = 1;
  private mode: CharacterAnimationMode = 'locomotion';
  private speed = 0;
  private aimPitch = 0;
  private wasFiring = false;
  private deathElapsed = 0;
  /** 复用同一个对象记录上一帧的跳变来源，避免每帧分配。 */
  private readonly lastTransition = { alive: true, reloading: false };
  private hasTransition = false;
  private readonly counts = { footstep: 0, muzzle: 0, reload: 0, death: 0 };
  private perf: CharacterPerfStats;

  constructor(options: CharacterViewOptions) {
    // 骨架/遮罩/片段只依赖关节拓扑，对同一套人体完全相同：全场景共享一份，
    // 每个 View 只新建自己的 Three 骨骼与 AnimationMixer（播放状态互不影响）。
    const rig = sharedRig();
    this.skeleton = rig.skeleton;
    this.index = rig.index;
    this.masks = rig.masks;
    this.clips = rig.clips;
    this.model = buildCharacterModel({
      team: options.team,
      accent: options.accent,
      variant: options.variant ?? 0,
      skeleton: this.skeleton,
    });
    this.group = this.model.group;
    this.group.name = `character:${options.team}`;
    this.group.userData.characterView = true;
    this.team = options.team;
    this.perf = { ...this.model.stats };
    this.rest = restPose(this.skeleton);
    this.mixer = new AnimationMixer(this.skeleton);
    this.configureWeaponMount();
    this.playBaseActions();
    this.writePose(this.rest);
  }

  /** 当前武器（只读）。 */
  get currentWeapon(): CharacterWeaponId {
    return this.weaponId;
  }

  /** 切换武器：只切 visible 与挂点/换弹节奏，不重建几何。 */
  setWeapon(id: CharacterWeaponId): void {
    if (id === this.weaponId) return;
    this.weaponId = id;
    for (const [key, weapon] of Object.entries(this.model.weapons)) {
      weapon.group.visible = key === id;
    }
    const reloadSpeed = RELOAD_CLIP_DURATION / RELOAD_SECONDS[id];
    this.mixer.play(this.clips.reload, {
      id: 'reload',
      layer: 3,
      mask: this.masks.upperBody,
      weight: this.reloadWeight,
      loop: true,
      speed: reloadSpeed,
    });
    this.refreshPerf();
  }

  /**
   * 每帧驱动：输入控制层状态，返回本帧动画事件。
   * dt <= 0（暂停/首帧）时只重新计算姿势，不推进时间、不产生片段事件。
   */
  update(dt: number, state: CharacterRenderState): CharacterActionEvent[] {
    let events: CharacterActionEvent[] | null = null;

    this.setWeapon(state.weaponId);

    // 跳变事件：上一帧为空（首次 update）时只记录，不产生事件。
    if (this.hasTransition) {
      for (const event of transitionEvents(this.lastTransition, state)) {
        events = pushEvent(events, event);
        if (event.kind === 'reload') this.counts.reload += 1;
        if (event.kind === 'death') this.counts.death += 1;
      }
    }
    this.lastTransition.alive = state.alive;
    this.lastTransition.reloading = state.reloading;
    this.hasTransition = true;

    if (!state.alive && this.alive) {
      this.enterDeath();
    } else if (state.alive && !this.alive) {
      this.revive();
    }
    this.alive = state.alive;

    const params = animationParams(state);
    this.mode = params.mode;
    this.timeScale = params.timeScale;
    this.aimPitch = params.aimPitch;
    this.aimWeight = params.aimWeight;
    // 取夹取后的速度：非法 speed（NaN/Infinity）不会泄漏到调试输出与事件里。
    this.speed = params.speed;

    if (this.alive) {
      this.mixer.setWeight('idle', params.weights.idle);
      this.mixer.setWeight('walk', params.weights.walk);
      this.mixer.setWeight('run', params.weights.run);
      this.mixer.setWeight('aim', params.aimWeight);
      this.reloadWeight = approach(this.reloadWeight, params.reloadWeight, dt * 9);
      this.mixer.setWeight('reload', this.reloadWeight);
      this.crouch = approach(this.crouch, params.crouch, dt * 10);
      if (state.firing && !this.wasFiring) {
        this.fire();
      }
    } else {
      this.deathElapsed += Math.max(0, dt);
      this.aimWeight = 0;
      this.reloadWeight = 0;
    }
    this.wasFiring = state.firing;

    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const frame = this.mixer.update(step * (this.alive ? this.timeScale : 1));

    let pose = frame.pose;
    // 俯仰增量层：pitch 接近 0 时增量为 0，跳过可省下一次姿势混合与分配。
    if (this.alive && this.aimWeight > 0 && Math.abs(this.aimPitch) > AIM_PITCH_EPSILON) {
      const pitchPose = velocityBlend(this.aimPitch, this.clips.aimPitchStops);
      pose = applyMaskedLayer(pose, pitchPose, this.masks.upperBody, {
        mode: 'additive',
        weight: this.aimWeight,
        reference: this.rest,
      });
    }
    if (this.crouch > 0.001) {
      pose = applyMaskedLayer(pose, this.clips.crouchPose, this.masks.crouch, {
        mode: 'additive',
        weight: this.crouch,
        reference: this.rest,
      });
    }
    this.writePose(pose);

    this.group.position.set(state.position.x, state.position.y, state.position.z);
    this.group.rotation.y = state.yaw;

    for (const event of frame.events) {
      const mapped = this.mapEvent(event);
      if (!mapped) continue;
      events = pushEvent(events, mapped);
      if (mapped.kind === 'footstep') this.counts.footstep += 1;
      if (mapped.kind === 'muzzle') this.counts.muzzle += 1;
      if (mapped.kind === 'death') this.counts.death += 1;
    }
    return events ?? EMPTY_EVENTS;
  }

  /** 死亡动画已经播放的时长（秒）；供主循环决定尸体可见时间。 */
  get deathAge(): number {
    return this.alive ? 0 : this.deathElapsed;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** 武器挂点世界坐标（调试与枪口特效用）。 */
  weaponMountWorldPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return this.model.weaponMount.getWorldPosition(target);
  }

  debug(): CharacterDebugState {
    return {
      team: this.team,
      weaponId: this.weaponId,
      alive: this.alive,
      mode: this.mode,
      speed: round(this.speed),
      aimPitch: round(this.aimPitch),
      crouch: round(this.crouch),
      weights: this.currentWeights(),
      aimWeight: round(this.aimWeight),
      reloadWeight: round(this.reloadWeight),
      timeScale: round(this.timeScale),
      playing: this.mixer.playingIds,
      events: { ...this.counts },
      perf: { ...this.perf },
      position: {
        x: round(this.group.position.x),
        y: round(this.group.position.y),
        z: round(this.group.position.z),
      },
      yaw: round(this.group.rotation.y),
    };
  }

  /** 当前 layer 0 权重（与传入状态一致，便于对比验收）。 */
  currentWeights(): { idle: number; walk: number; run: number } {
    return {
      idle: round(this.mixer.weightOf('idle')),
      walk: round(this.mixer.weightOf('walk')),
      run: round(this.mixer.weightOf('run')),
    };
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const mesh of this.model.bodyMeshes) {
      mesh.geometry.dispose();
    }
    for (const weapon of Object.values(this.model.weapons)) {
      weapon.group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }
    this.model.threeSkeleton.dispose();
  }

  /** 武器挂点姿态：抵消手臂链条旋转，让枪管沿角色正面（-Z）指向。 */
  private configureWeaponMount(): void {
    const mount = this.model.weaponMount;
    mount.position.set(0.0, 0.04, -0.1);
    const rotation = aimWeaponMountRotation();
    mount.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
  }

  private playBaseActions(): void {
    this.mixer.play(this.clips.idle, { id: 'idle', layer: 0, weight: 1, loop: true });
    this.mixer.play(this.clips.walk, { id: 'walk', layer: 0, weight: 0, loop: true });
    this.mixer.play(this.clips.run, { id: 'run', layer: 0, weight: 0, loop: true });
    this.mixer.play(this.clips.aim, {
      id: 'aim',
      layer: 1,
      mask: this.masks.upperBody,
      weight: 0,
      loop: true,
    });
    this.mixer.play(this.clips.reload, {
      id: 'reload',
      layer: 3,
      mask: this.masks.upperBody,
      weight: 0,
      loop: true,
      speed: RELOAD_CLIP_DURATION / RELOAD_SECONDS[this.weaponId],
    });
  }

  private fire(): void {
    this.mixer.play(this.clips.fire, {
      id: 'fire',
      layer: 2,
      mask: this.masks.recoil,
      weight: 1,
      loop: false,
      mode: 'additive',
    });
  }

  private enterDeath(): void {
    this.deathElapsed = 0;
    this.mixer.stop();
    this.mixer.play(this.clips.death, { id: 'death', layer: 0, weight: 1, loop: false });
  }

  private revive(): void {
    this.deathElapsed = 0;
    this.reloadWeight = 0;
    this.crouch = 0;
    this.mixer.stop();
    this.playBaseActions();
    this.mixer.setWeight('idle', 1);
    this.mixer.setWeight('aim', 0);
  }

  private refreshPerf(): void {
    const weapon = this.model.weapons[this.weaponId];
    let weaponMeshes = 0;
    let weaponTriangles = 0;
    weapon.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      weaponMeshes += 1;
      const position = mesh.geometry.getAttribute('position');
      weaponTriangles += position ? Math.floor(position.count / 3) : 0;
    });
    this.perf = {
      ...this.model.stats,
      weaponMeshes,
      weaponTriangles,
      triangles: this.model.stats.bodyTriangles + weaponTriangles,
      drawCalls: this.model.stats.bodyMeshes + weaponMeshes,
    };
  }

  private mapEvent(event: MixerEvent): CharacterActionEvent | null {
    switch (event.name) {
      case 'footstep': {
        // 片段在自己的权重为 0 时仍会推进时间并派发事件（E1 未按权重过滤），
        // 所以这里按当前步态权重过滤：站立（idle）不产生脚步，
        // 混合区间只让主导步态出脚，避免 walk+run 双倍步频。
        const own = this.mixer.weightOf(event.clip);
        const otherId = event.clip === 'run' ? 'walk' : 'run';
        const other = this.mixer.weightOf(otherId);
        const dominant = own > other || (own === other && event.clip === 'run');
        if (own < FOOTSTEP_MIN_WEIGHT || !dominant) return null;
        return {
          kind: 'footstep',
          source: event.clip === 'run' ? 'run' : 'walk',
          foot: event.payload?.foot === 'right' ? 'right' : 'left',
          gait: event.payload?.gait === 'run' ? 'run' : 'walk',
          speed: round(this.speed),
          at: event.time,
        };
      }
      case 'muzzle':
        return {
          kind: 'muzzle',
          source: 'fire',
          weaponId: this.weaponId,
          at: event.time,
        };
      case 'death':
        // 死亡由状态跳变（transitionEvents）唯一上报，片段事件只是倒地动画标记，
        // 这里忽略，避免同一次死亡上报两次。
        return null;
      default:
        return null;
    }
  }

  private writePose(pose: Pose): void {
    const bones = this.model.bones;
    const count = Math.min(bones.length, pose.position.length);
    for (let i = 0; i < count; i += 1) {
      const position = pose.position[i];
      const rotation = pose.rotation[i];
      const scale = pose.scale[i];
      const bone = bones[i];
      bone.position.set(position.x, position.y, position.z);
      if (rotation) bone.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      if (scale) bone.scale.set(scale.x, scale.y, scale.z);
    }
  }
}

/** 低于该俯仰角（约 0.57°）视为水平瞄准：增量层可跳过。 */
export const AIM_PITCH_EPSILON = 0.01;

const EMPTY_EVENTS: CharacterActionEvent[] = Object.freeze([]) as unknown as CharacterActionEvent[];

interface SharedRig {
  skeleton: Skeleton;
  index: Record<HumanJoint, number>;
  masks: HumanMasks;
  clips: HumanClips;
}

let rigCache: SharedRig | null = null;

/** 共享骨架/遮罩/片段（确定、只读）：避免每个 Bot 重算一遍拓扑与关键帧。 */
export function sharedRig(): SharedRig {
  if (!rigCache) {
    const skeleton = createHumanSkeleton();
    const index = humanJointIndex();
    const masks = createHumanMasks(skeleton);
    rigCache = { skeleton, index, masks, clips: createHumanClips(skeleton, index, masks) };
  }
  return rigCache;
}

/** 低于该权重的步态不产生脚步事件（站立与刚起步的过渡帧）。 */
export const FOOTSTEP_MIN_WEIGHT = 0.15;

function pushEvent(
  target: CharacterActionEvent[] | null,
  event: CharacterActionEvent,
): CharacterActionEvent[] {
  if (target) {
    target.push(event);
    return target;
  }
  return [event];
}

function approach(current: number, target: number, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return current;
  const k = Math.min(1, rate);
  return current + (target - current) * k;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 供主循环做“尸体可见时长”判断的常量。 */
export const CORPSE_VISIBLE_SECONDS = 2.6;
