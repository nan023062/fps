/**
 * 轻量 AnimationMixer：动作、层、遮罩、crossfade 与事件队列。
 *
 * 不碰 Three.js 渲染器/DOM/WebGL：每帧 update(dt) 返回一份 Pose 与事件数组，
 * CharacterView 只负责把 Pose 写到自己的骨骼对象上。
 * 时间推进完全由调用方给出的 dt 驱动，测试可完全确定性运行。
 */
import type { AnimationClip } from './clip';
import { eventsBetween, sampleClip } from './clip';
import type { Pose, Skeleton } from './skeleton';
import { clonePose, restPose } from './skeleton';
import type { BoneMask, LayerMode, PoseWeight } from './blending';
import { applyMaskedLayer, blendPoses, crossFadePose } from './blending';
import { clamp01, lerp } from './math';
import type { ClipEventPayload } from './clip';

export interface PlayOptions {
  /** 动作 id，默认取 clip.name；重复 id 会重置该动作。 */
  id?: string;
  weight?: number;
  /** 时间倍率，必须 >= 0；用于慢放/加速。 */
  speed?: number;
  loop?: boolean;
  /** 层号：0 为基底 locomotion，>=1 为附加层（例如上半身）。 */
  layer?: number;
  /** 遮罩：有遮罩的层只影响被覆盖的关节。 */
  mask?: BoneMask;
  mode?: LayerMode;
  /** 起始时间，默认 0。 */
  time?: number;
}

export interface MixerEvent {
  name: string;
  clip: string;
  actionId: string;
  /** 片段内的局部时间。 */
  time: number;
  /** 混合器播放轴上的发生时间。 */
  at: number;
  payload?: ClipEventPayload;
}

export interface MixerFrame {
  pose: Pose;
  events: MixerEvent[];
}

interface Action {
  id: string;
  clip: AnimationClip;
  layer: number;
  weight: number;
  speed: number;
  loop: boolean;
  time: number;
  mask?: BoneMask;
  mode: LayerMode;
}

interface Fade {
  id: string;
  from: number;
  to: number;
  elapsed: number;
  duration: number;
  removeOnFinish: boolean;
}

export class AnimationMixer {
  readonly skeleton: Skeleton;

  private readonly basePose: Pose;
  private actions: Action[] = [];
  private fades: Fade[] = [];
  private layerWeights = new Map<number, number>();
  private elapsed = 0;
  private lastPose: Pose;

  constructor(skeleton: Skeleton) {
    this.skeleton = skeleton;
    this.basePose = restPose(skeleton);
    this.lastPose = clonePose(this.basePose);
  }

  /** 混合器已推进的播放轴时间（秒）。 */
  get time(): number {
    return this.elapsed;
  }

  /** 最近一帧的姿势拷贝（只读用途；update 返回的 pose 可被调用方接管）。 */
  get pose(): Pose {
    return clonePose(this.lastPose);
  }

  get playingIds(): string[] {
    return this.actions.map((action) => action.id);
  }

  isPlaying(id: string): boolean {
    return this.actions.some((action) => action.id === id);
  }

  weightOf(id: string): number {
    return this.findAction(id)?.weight ?? 0;
  }

  setWeight(id: string, weight: number): void {
    const action = this.findAction(id);
    if (!action) {
      return;
    }
    action.weight = clamp01(weight);
    this.fades = this.fades.filter((fade) => fade.id !== id);
  }

  /** 层权重会乘到该层每个动作的权重上；默认 1。 */
  setLayerWeight(layer: number, weight: number): void {
    this.layerWeights.set(layer, clamp01(weight));
  }

  layerWeight(layer: number): number {
    return this.layerWeights.get(layer) ?? 1;
  }

  /** 启动动作；同 id 会从 options.time 重新开始。返回动作 id。 */
  play(clip: AnimationClip, options: PlayOptions = {}): string {
    const id = options.id ?? clip.name;
    this.actions = this.actions.filter((action) => action.id !== id);
    this.fades = this.fades.filter((fade) => fade.id !== id);
    const speed = options.speed ?? 1;
    this.actions.push({
      id,
      clip,
      layer: options.layer ?? 0,
      weight: clamp01(options.weight ?? 1),
      speed: Number.isFinite(speed) && speed > 0 ? speed : 0,
      loop: options.loop ?? clip.loop,
      time: Math.max(0, options.time ?? 0),
      mask: options.mask,
      mode: options.mode ?? 'override',
    });
    return id;
  }

  /** 停止一个动作；不传 id 时清空全部动作与淡入淡出。 */
  stop(id?: string): void {
    if (id === undefined) {
      this.actions = [];
      this.fades = [];
      return;
    }
    this.actions = this.actions.filter((action) => action.id !== id);
    this.fades = this.fades.filter((fade) => fade.id !== id);
  }

  /**
   * 从 fromId 交叉淡出到 toId：duration 秒内 from 权重 → 0，to 权重 → 1。
   * duration <= 0 时立即完成。
   */
  crossFade(fromId: string, toId: string, duration: number): void {
    const from = this.findAction(fromId);
    const to = this.findAction(toId);
    if (!from || !to) {
      throw new Error(`crossFade requires both actions: ${fromId} -> ${toId}`);
    }
    if (!(duration > 0)) {
      this.setWeightImmediate(fromId, 0);
      this.stop(fromId);
      this.setWeightImmediate(toId, 1);
      return;
    }
    this.fades = this.fades.filter((fade) => fade.id !== fromId && fade.id !== toId);
    this.fades.push({
      id: fromId,
      from: from.weight,
      to: 0,
      elapsed: 0,
      duration,
      removeOnFinish: true,
    });
    this.fades.push({
      id: toId,
      from: to.weight,
      to: 1,
      elapsed: 0,
      duration,
      removeOnFinish: false,
    });
  }

  /**
   * 便捷入口：新动作从 0 权重起步，并淡出当前 layer 0 上的主动作。
   * 没有可淡出的动作时等价于 play(clip, weight 1)。
   */
  crossFadeTo(clip: AnimationClip, duration: number, options: PlayOptions = {}): string {
    const previous = this.actions.find((action) => action.layer === 0 && action.weight > 0);
    const id = this.play(clip, { ...options, weight: 0 });
    if (!previous) {
      this.setWeightImmediate(id, options.weight ?? 1);
      return id;
    }
    this.crossFade(previous.id, id, duration);
    return id;
  }

  /**
   * 推进 dt 秒，返回最终 Pose 与本次跨过的事件。
   * dt <= 0 或非有限值时只重算当前姿势，不推进时间、不触发事件。
   */
  update(dt: number): MixerFrame {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.elapsed += step;

    if (step > 0 && this.fades.length > 0) {
      const finished: Fade[] = [];
      for (const fade of this.fades) {
        fade.elapsed = Math.min(fade.elapsed + step, fade.duration);
        const progress = fade.duration <= 0 ? 1 : fade.elapsed / fade.duration;
        const action = this.findAction(fade.id);
        if (action) {
          action.weight = clamp01(lerp(fade.from, fade.to, progress));
        }
        if (progress >= 1) {
          finished.push(fade);
        }
      }
      for (const done of finished) {
        this.fades = this.fades.filter((fade) => fade !== done);
      }
      for (const done of finished) {
        if (done.removeOnFinish && (done.to <= 0 || this.weightOf(done.id) <= 0)) {
          this.stop(done.id);
        }
      }
    }

    const events: MixerEvent[] = [];
    const samples: { action: Action; pose: Pose; weight: number }[] = [];

    for (const action of this.actions) {
      const duration = action.clip.duration;
      const from = action.time;
      let to = from + step * action.speed;
      if (!action.loop) {
        to = Math.min(to, duration);
      }
      const fired = eventsBetween(action.clip, from, to, action.loop);
      for (const event of fired) {
        events.push({
          name: event.name,
          clip: action.clip.name,
          actionId: action.id,
          time: event.time,
          at: this.elapsed + (event.at - to),
          payload: event.payload,
        });
      }
      action.time = to;
      const weight = action.weight * this.layerWeight(action.layer);
      if (weight <= 0) {
        continue;
      }
      samples.push({
        action,
        pose: sampleClip(action.clip, action.time, { base: this.basePose, loop: action.loop }),
        weight,
      });
    }

    events.sort((a, b) => a.at - b.at);

    const baseEntries: PoseWeight[] = [];
    const layered: { pose: Pose; weight: number; mask?: BoneMask; mode: LayerMode; layer: number; order: number }[] = [];
    samples.forEach((sample, order) => {
      if (sample.action.mask) {
        layered.push({
          pose: sample.pose,
          weight: sample.weight,
          mask: sample.action.mask,
          mode: sample.action.mode,
          layer: sample.action.layer,
          order,
        });
        return;
      }
      if (sample.action.layer === 0) {
        baseEntries.push({ pose: sample.pose, weight: sample.weight });
        return;
      }
      layered.push({
        pose: sample.pose,
        weight: sample.weight,
        mode: sample.action.mode,
        layer: sample.action.layer,
        order,
      });
    });

    let pose = baseEntries.length > 0 ? blendPoses(baseEntries) : clonePose(this.basePose);
    const ordered = [...layered].sort((a, b) => (a.layer === b.layer ? a.order - b.order : a.layer - b.layer));
    for (const entry of ordered) {
      if (entry.mask) {
        pose = applyMaskedLayer(pose, entry.pose, entry.mask, {
          mode: entry.mode,
          weight: entry.weight,
          reference: this.basePose,
        });
      } else {
        pose = crossFadePose(pose, entry.pose, entry.weight);
      }
    }

    this.lastPose = pose;
    return { pose, events };
  }

  private setWeightImmediate(id: string, weight: number): void {
    const action = this.findAction(id);
    if (action) {
      action.weight = clamp01(weight);
    }
  }

  private findAction(id: string): Action | undefined {
    return this.actions.find((action) => action.id === id);
  }
}
