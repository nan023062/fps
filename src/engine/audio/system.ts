/**
 * AudioSystem：音频系统的组合根。
 *
 * - 生命周期：AudioContext 只在 ensure()（用户手势内）创建；创建/resume 失败
 *   进入 degraded 状态并可查询，从不抛未捕获异常。
 * - 总线：BusMixer（Master → Weapons/Footsteps/Ambience/UI）。
 * - 并发：VoicePool 管理上限、优先级抢占与冷却；本文件负责真实节点释放。
 * - 空间：PannerNode + listener，UI 总线强制非空间化。
 */
import { BusMixer, createBusMixState, cloneMixState, resolveBusGains } from './buses';
import { clamp01, clampRange } from './defs';
import { createDefaultLibrary } from './sounds';
import { getNoiseBuffer, releaseNoiseBuffer } from './synth';
import {
  DEFAULT_LISTENER,
  applyListener,
  createVoicePanner,
  setPannerPosition,
} from './spatial';
import type {
  AudioSystemOptions,
  AudioSystemStatus,
  BusId,
  BusState,
  ListenerState,
  PlayOptions,
  SoundEntry,
  SoundHandle,
  SoundLibrary,
  Vec3Like,
} from './types';
import { BUS_IDS } from './types';
import {
  DEFAULT_MAX_VOICES,
  HARD_MAX_VOICES,
  VoicePool,
  cooldownRemaining,
  isCoolingDown,
  jitter,
  type VoiceSlot,
} from './voices';

interface VoiceRecord {
  readonly slot: VoiceSlot;
  readonly bus: BusId;
  readonly gain: GainNode;
  readonly panner: PannerNode | null;
  readonly sources: AudioScheduledSourceNode[];
  volume: number;
  remaining: number;
  position: Vec3Like | null;
}

type TimerHandle = ReturnType<typeof setTimeout>;

const DEFAULT_SMOOTH_TIME = 0.05;

/** play() 的返回值；引擎降级或未初始化时也是安全的空句柄。 */
class VoiceHandle implements SoundHandle {
  constructor(
    private readonly system: AudioSystem | null,
    private token: number | null,
    readonly id: string,
    readonly bus: BusId,
  ) {}

  isActive(): boolean {
    if (this.token === null || this.system === null) return false;
    return this.system.hasVoice(this.token);
  }

  stop(fadeSeconds = 0.05): void {
    if (this.token === null || this.system === null) return;
    this.system.releaseVoice(this.token, fadeSeconds);
    this.token = null;
  }

  setPosition(position: Vec3Like): void {
    if (this.token === null || this.system === null) return;
    this.system.setVoicePosition(this.token, position);
  }

  setVolume(volume: number): void {
    if (this.token === null || this.system === null) return;
    this.system.setVoiceVolume(this.token, volume);
  }
}

export class AudioSystem {
  private readonly options: Required<
    Pick<AudioSystemOptions, 'maxVoices' | 'smoothTime' | 'autoAmbience' | 'ambienceId'>
  >;
  private readonly contextFactory: () => AudioContext | null;
  private readonly rng: () => number;
  private readonly library: SoundLibrary;
  private readonly pool: VoicePool;
  private readonly perBus: Partial<Record<BusId, number>>;

  private ctx: AudioContext | null = null;
  private mixer: BusMixer | null = null;
  private preMix: Record<BusId, BusState>;
  private readonly voices = new Map<number, VoiceRecord>();
  private readonly lastPlayed = new Map<string, number>();
  private readonly timers = new Set<TimerHandle>();
  private listenerState: ListenerState = {
    position: { ...DEFAULT_LISTENER.position },
    forward: { ...DEFAULT_LISTENER.forward },
    up: { ...DEFAULT_LISTENER.up },
  };
  private degraded = false;
  private disposed = false;
  private ambienceStarted = false;
  private ambienceHandle: SoundHandle | null = null;

  constructor(options: AudioSystemOptions = {}) {
    const maxVoices = clampRange(options.maxVoices ?? DEFAULT_MAX_VOICES, 1, HARD_MAX_VOICES);
    this.options = {
      maxVoices: Math.floor(maxVoices),
      smoothTime: Math.max(0.001, options.smoothTime ?? DEFAULT_SMOOTH_TIME),
      autoAmbience: options.autoAmbience ?? true,
      ambienceId: options.ambienceId ?? 'ambience',
    };
    this.contextFactory = options.contextFactory ?? defaultContextFactory;
    this.rng = options.rng ?? Math.random;
    this.perBus = { ...options.perBusVoices };
    this.pool = new VoicePool({ maxVoices: this.options.maxVoices, perBus: this.perBus });
    this.preMix = createBusMixState({
      master: options.masterVolume ?? 0.8,
      ...options.busVolumes,
    });
    const extra: SoundEntry[] = [...(options.extraSounds ?? [])];
    this.library = options.library ?? createDefaultLibrary(extra);
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 必须在用户手势（点击/按键）里首次调用。返回是否可用。
   * 重复调用幂等，只会在上下文被挂起时尝试恢复。
   */
  ensure(): boolean {
    if (this.disposed) return false;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.resume();
      return !this.degraded;
    }
    let ctx: AudioContext | null = null;
    try {
      ctx = this.contextFactory();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      this.degraded = true;
      return false;
    }
    try {
      this.mixer = new BusMixer(ctx, {
        smoothTime: this.options.smoothTime,
        state: this.preMix,
      });
      applyListener(ctx, this.listenerState);
      getNoiseBuffer(ctx, this.rng);
    } catch {
      // createGain/总线搭建失败：保持无上下文并标记降级，绝不抛出。
      try {
        ctx.close?.();
      } catch {
        // 关闭失败无需处理，只是没有可用音频。
      }
      this.mixer = null;
      this.ctx = null;
      this.degraded = true;
      return false;
    }
    this.ctx = ctx;
    this.degraded = false;
    this.preMix = cloneMixState(this.mixer.state);
    if (ctx.state === 'suspended') void this.resume();
    if (this.options.autoAmbience) this.startAmbience();
    return true;
  }

  get status(): AudioSystemStatus {
    if (this.disposed) return 'disposed';
    if (this.degraded) return 'degraded';
    if (!this.ctx) return 'uninitialized';
    return this.ctx.state === 'running' ? 'running' : 'suspended';
  }

  get degradedState(): boolean {
    return this.degraded;
  }

  get maxVoices(): number {
    return this.pool.limit;
  }

  get activeVoiceCount(): number {
    return this.pool.activeCount;
  }

  /** 当前环境底噪句柄（没有则为 null）。 */
  get ambienceVoice(): SoundHandle | null {
    return this.ambienceHandle;
  }

  get contextState(): string | null {
    return this.ctx ? this.ctx.state : null;
  }

  async suspend(): Promise<void> {
    if (!this.ctx || this.disposed || this.degraded) return;
    try {
      await this.ctx.suspend();
    } catch {
      // 浏览器拒绝挂起时保持原状态。
    }
  }

  async resume(): Promise<void> {
    if (!this.ctx || this.disposed) return;
    try {
      await this.ctx.resume();
      this.degraded = false;
    } catch {
      // 自动播放策略拒绝时标记降级，调用方可通过 status/degradedState 观察。
      this.degraded = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ambienceHandle = null;
    for (const token of [...this.voices.keys()]) {
      this.releaseVoice(token, 0.01);
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.voices.clear();
    this.pool.clearAll();
    this.mixer?.dispose();
    this.mixer = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      releaseNoiseBuffer(ctx);
      try {
        const closing = ctx.close?.();
        if (closing && typeof closing.then === 'function') closing.catch(() => undefined);
      } catch {
        // 已关闭或环境不支持 close 时忽略。
      }
    }
    this.listenerState = {
      position: { ...DEFAULT_LISTENER.position },
      forward: { ...DEFAULT_LISTENER.forward },
      up: { ...DEFAULT_LISTENER.up },
    };
  }

  // ------------------------------------------------------------------ 播放

  /** 播放一个已注册音效；未注册/降级/已释放时返回空句柄。 */
  play(id: string, options: PlayOptions = {}): SoundHandle {
    const entry = this.library.get(id);
    const bus = entry ? entry.def.bus : 'ui';
    if (this.disposed || this.degraded || !this.ctx || !entry) {
      return new VoiceHandle(null, null, id, bus);
    }
    const ctx = this.ctx;
    const def = entry.def;
    const now = ctx.currentTime;
    if (!options.force && isCoolingDown(this.lastPlayed.get(id), now, def.cooldown)) {
      return new VoiceHandle(null, null, id, def.bus);
    }

    const volume = clamp01(options.volume ?? 1);
    const pitchBase = clampRange(options.pitch ?? 1, 0.05, 8);
    const gain = def.gain * volume * jitter(this.rng, 1, def.gainJitter);
    const pitch = pitchBase * jitter(this.rng, 1, def.pitchJitter);
    const position = options.position ? { ...options.position } : null;

    const admit = this.pool.admit({
      id,
      bus: def.bus,
      priority: def.priority,
      loop: def.loop,
      now,
    });
    for (const stolen of admit.stolen) this.releaseVoice(stolen.token, 0.02);
    if (!admit.slot) return new VoiceHandle(null, null, id, def.bus);

    const slot = admit.slot;
    let gainNode: GainNode;
    try {
      gainNode = ctx.createGain();
    } catch {
      this.pool.release(slot.token);
      return new VoiceHandle(null, null, id, def.bus);
    }
    gainNode.gain.value = 1;
    try {
      gainNode.connect(this.mixer ? this.mixer.node(def.bus) : ctx.destination);
    } catch {
      this.pool.release(slot.token);
      return new VoiceHandle(null, null, id, def.bus);
    }

    // UI 总线强制非空间化（界面提示音不应随视角移动）；
    // options.spatial 允许调用方按次覆盖（玩家自身枪声非空间化，Bot 枪声空间化）。
    const spatial = (options.spatial ?? def.spatial) && def.bus !== 'ui';
    let panner: PannerNode | null = null;
    if (spatial) {
      panner = createVoicePanner(ctx, def, position ?? undefined);
      if (panner) {
        try {
          panner.connect(gainNode);
        } catch {
          panner = null;
        }
      }
    }

    let sources: AudioScheduledSourceNode[];
    try {
      sources = entry.render(ctx, panner ?? gainNode, {
        def,
        when: now,
        gain,
        pitch,
        params: options.params ?? {},
      });
    } catch {
      sources = [];
    }
    if (sources.length === 0) {
      // 合成失败：回收本次申请，避免占用并发额度。
      this.pool.release(slot.token);
      this.safeDisconnect(gainNode);
      if (panner) this.safeDisconnect(panner);
      return new VoiceHandle(null, null, id, def.bus);
    }

    const record: VoiceRecord = {
      slot,
      bus: def.bus,
      gain: gainNode,
      panner,
      sources,
      volume: 1,
      remaining: sources.length,
      position,
    };
    this.voices.set(slot.token, record);
    this.lastPlayed.set(id, now);
    this.watchSources(record);
    return new VoiceHandle(this, slot.token, id, def.bus);
  }

  // ------------------------------------------------------------------ 并发

  stopAll(bus?: BusId): void {
    const tokens: number[] = [];
    for (const [token, voice] of this.voices) {
      if (!bus || voice.bus === bus) tokens.push(token);
    }
    for (const token of tokens) this.releaseVoice(token, 0.03);
    if (bus === 'ambience' || bus === undefined) this.ambienceHandle = null;
  }

  hasVoice(token: number): boolean {
    return this.voices.has(token);
  }

  /** 内部接口：VoiceHandle.stop 使用。 */
  releaseVoice(token: number, fadeSeconds = 0.05): void {
    const voice = this.voices.get(token);
    if (!voice) return;
    this.voices.delete(token);
    this.pool.release(token);
    const ctx = this.ctx;
    if (!ctx) {
      this.safeDisconnect(voice.gain);
      if (voice.panner) this.safeDisconnect(voice.panner);
      return;
    }
    const now = ctx.currentTime;
    const fade = Math.max(0.005, fadeSeconds);
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, fade / 3);
    } catch {
      // 参数已释放时忽略。
    }
    for (const source of voice.sources) {
      try {
        source.stop(now + fade);
      } catch {
        // 已停止的源重复 stop 会抛 InvalidStateError，忽略。
      }
    }
    this.disconnectLater(voice, fade);
  }

  /** 内部接口：VoiceHandle.setPosition 使用。 */
  setVoicePosition(token: number, position: Vec3Like): void {
    const voice = this.voices.get(token);
    if (!voice || !voice.panner) return;
    voice.position = { ...position };
    setPannerPosition(voice.panner, position);
  }

  /** 内部接口：VoiceHandle.setVolume 使用。 */
  setVoiceVolume(token: number, volume: number): void {
    const voice = this.voices.get(token);
    if (!voice) return;
    const ctx = this.ctx;
    const value = clamp01(volume);
    voice.volume = value;
    if (!ctx) return;
    try {
      voice.gain.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    } catch {
      // 忽略已释放节点的写入。
    }
  }

  // ------------------------------------------------------------------ 总线

  setBusVolume(bus: BusId, volume: number): void {
    if (this.mixer) this.mixer.setVolume(bus, volume);
    else this.preMix[bus] = { ...this.preMix[bus], volume: clamp01(volume) };
  }

  setBusMute(bus: BusId, muted: boolean): void {
    if (this.mixer) this.mixer.setMute(bus, muted);
    else this.preMix[bus] = { ...this.preMix[bus], muted: Boolean(muted) };
  }

  setBusSolo(bus: BusId, soloed: boolean): void {
    if (this.mixer) this.mixer.setSolo(bus, soloed);
    else if (bus !== 'master') this.preMix[bus] = { ...this.preMix[bus], soloed: Boolean(soloed) };
  }

  getBusState(bus: BusId): BusState {
    return this.mixer ? this.mixer.getState(bus) : this.preMix[bus];
  }

  busGains(): Record<BusId, number> {
    return this.mixer ? this.mixer.gains() : resolveBusGains(this.preMix);
  }

  busIds(): readonly BusId[] {
    return BUS_IDS;
  }

  // ---------------------------------------------------------------- listener

  /** 只接收数值；调用方（下一任务的 main.ts 接线）负责把相机姿态换算成向量。 */
  setListener(position: Vec3Like, forward: Vec3Like, up?: Vec3Like): void {
    this.listenerState = {
      position: { x: position.x, y: position.y, z: position.z },
      forward: { x: forward.x, y: forward.y, z: forward.z },
      up: up
        ? { x: up.x, y: up.y, z: up.z }
        : { ...DEFAULT_LISTENER.up },
    };
    if (this.ctx) applyListener(this.ctx, this.listenerState);
  }

  getListener(): ListenerState {
    return this.listenerState;
  }

  // ------------------------------------------------------------------ 查询

  hasSound(id: string): boolean {
    return this.library.has(id);
  }

  soundIds(): readonly string[] {
    return [...this.library.keys()];
  }

  getSoundDef(id: string): SoundEntry['def'] | null {
    return this.library.get(id)?.def ?? null;
  }

  /** 距离下一段可播放还需等待的秒数（0 表示可以播放）。 */
  cooldownRemaining(id: string): number {
    const def = this.library.get(id)?.def;
    if (!def || !this.ctx) return 0;
    return cooldownRemaining(this.lastPlayed.get(id), this.ctx.currentTime, def.cooldown);
  }

  // ---------------------------------------------------------------- 内部

  private startAmbience(): void {
    if (this.ambienceStarted) return;
    this.ambienceStarted = true;
    if (!this.hasSound(this.options.ambienceId)) return;
    this.ambienceHandle = this.play(this.options.ambienceId, { force: true });
  }

  private watchSources(record: VoiceRecord): void {
    if (record.sources.length === 0) return;
    for (const source of record.sources) {
      source.onended = () => {
        record.remaining -= 1;
        if (record.remaining <= 0) this.finishVoice(record.slot.token);
      };
    }
  }

  private finishVoice(token: number): void {
    const voice = this.voices.get(token);
    if (!voice) return;
    this.voices.delete(token);
    this.pool.release(token);
    this.safeDisconnect(voice.gain);
    if (voice.panner) this.safeDisconnect(voice.panner);
  }

  private disconnectLater(voice: VoiceRecord, fade: number): void {
    const delay = Math.max(10, (fade + 0.05) * 1000);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.safeDisconnect(voice.gain);
      if (voice.panner) this.safeDisconnect(voice.panner);
    }, delay);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
    this.timers.add(timer);
  }

  private safeDisconnect(node: AudioNode): void {
    try {
      node.disconnect();
    } catch {
      // 重复断开是安全的，忽略。
    }
  }
}

function defaultContextFactory(): AudioContext | null {
  const scope = typeof globalThis === 'undefined' ? undefined : (globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  });
  if (!scope) return null;
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

