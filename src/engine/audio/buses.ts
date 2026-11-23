/**
 * 总线图：Master → Weapons / Footsteps / Ambience / UI。
 *
 * 增益解析（resolveBusGains）是纯函数，便于在 Node 里穷举 mute/solo 组合；
 * BusMixer 只负责把解析结果以 setTargetAtTime 平滑地写到 GainNode。
 */
import { clamp01 } from './defs';
import { BUS_IDS, CHILD_BUS_IDS, type BusId, type BusState } from './types';

export type BusMixState = Readonly<Record<BusId, BusState>>;

export function createBusMixState(
  volumes: Partial<Record<BusId, number>> = {},
): Record<BusId, BusState> {
  const state = {} as Record<BusId, BusState>;
  for (const bus of BUS_IDS) {
    state[bus] = { volume: clamp01(volumes[bus] ?? (bus === 'master' ? 0.8 : 1)), muted: false, soloed: false };
  }
  return state;
}

/** 浅拷贝混音状态，避免外部表格被就地修改。 */
export function cloneMixState(state: BusMixState): Record<BusId, BusState> {
  const copy = {} as Record<BusId, BusState>;
  for (const bus of BUS_IDS) {
    const item = state[bus];
    copy[bus] = { volume: clamp01(item.volume), muted: item.muted, soloed: item.soloed };
  }
  return copy;
}

/** 解析每根总线最终要写入的增益（master 已包含自身 mute）。 */
export function resolveBusGains(mix: BusMixState): Record<BusId, number> {
  const soloed = CHILD_BUS_IDS.filter((bus) => mix[bus].soloed);
  const gains = {} as Record<BusId, number>;
  for (const bus of BUS_IDS) {
    const state = mix[bus];
    const muted = state.muted ? 0 : 1;
    if (bus === 'master') {
      gains[bus] = clamp01(state.volume) * muted;
      continue;
    }
    const soloMask = soloed.length > 0 && !state.soloed ? 0 : 1;
    gains[bus] = clamp01(state.volume) * muted * soloMask;
  }
  return gains;
}

export interface BusMixerOptions {
  readonly volumes?: Partial<Record<BusId, number>>;
  readonly smoothTime?: number;
  /** 初始化前的 mute/solo 状态（ensure 之前先设置过的），会被继承。 */
  readonly state?: BusMixState;
}

export class BusMixer {
  private readonly nodes = {} as Record<BusId, GainNode>;
  private readonly mix: Record<BusId, BusState>;
  private readonly smoothTime: number;
  private disposed = false;

  constructor(
    private readonly ctx: AudioContext,
    options: BusMixerOptions = {},
  ) {
    this.mix = options.state ? cloneMixState(options.state) : createBusMixState(options.volumes);
    this.smoothTime = Math.max(0.001, options.smoothTime ?? 0.05);
    for (const bus of BUS_IDS) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      this.nodes[bus] = gain;
    }
    this.nodes.master.connect(ctx.destination);
    for (const bus of CHILD_BUS_IDS) {
      this.nodes[bus].connect(this.nodes.master);
    }
    // 初始状态直接落值，避免开局一段 0 增益的淡入。
    const gains = resolveBusGains(this.mix);
    for (const bus of BUS_IDS) this.nodes[bus].gain.value = gains[bus];
  }

  get state(): BusMixState {
    return this.mix;
  }

  node(bus: BusId): GainNode {
    return this.nodes[bus];
  }

  getState(bus: BusId): BusState {
    return this.mix[bus];
  }

  gains(): Record<BusId, number> {
    return resolveBusGains(this.mix);
  }

  setVolume(bus: BusId, volume: number): void {
    this.mix[bus] = { ...this.mix[bus], volume: clamp01(volume) };
    this.apply();
  }

  setMute(bus: BusId, muted: boolean): void {
    this.mix[bus] = { ...this.mix[bus], muted: Boolean(muted) };
    this.apply();
  }

  setSolo(bus: BusId, soloed: boolean): void {
    if (bus === 'master') {
      // master 独奏等价于“只剩 master 自己”，没有实际意义，忽略避免误解。
      return;
    }
    this.mix[bus] = { ...this.mix[bus], soloed: Boolean(soloed) };
    this.apply();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bus of BUS_IDS) {
      const node = this.nodes[bus];
      try {
        node.disconnect();
      } catch {
        // 已断开的节点重复断开是安全的，忽略。
      }
    }
  }

  private apply(): void {
    if (this.disposed) return;
    const gains = resolveBusGains(this.mix);
    const now = this.ctx.currentTime;
    for (const bus of BUS_IDS) {
      const param = this.nodes[bus].gain;
      param.cancelScheduledValues(now);
      param.setTargetAtTime(gains[bus], now, this.smoothTime);
    }
  }
}
