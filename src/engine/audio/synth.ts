/**
 * 程序化音效合成：全部用 Oscillator / BufferSource 实时生成，不加载音频文件。
 *
 * 每个 recipe 接收 (ctx, output, request)，把节点接到 output 并返回源节点，
 * 由 AudioSystem 负责 stop/disconnect。噪声缓冲按 AudioContext 缓存并复用。
 */
import type { SynthRequest, SurfaceMaterial } from './types';

const noiseCache = new WeakMap<AudioContext, AudioBuffer>();

/** 1 秒白噪声，按 1 次/引擎缓存，避免每次开枪都分配新 buffer。 */
export function getNoiseBuffer(ctx: AudioContext, rng: () => number = Math.random): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const length = Math.max(1, Math.floor(ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, Math.max(1, ctx.sampleRate));
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    const value = rng();
    data[i] = (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5) * 2 - 1;
  }
  noiseCache.set(ctx, buffer);
  return buffer;
}

/** dispose 时释放缓存，避免长生命周期进程里残留 buffer。 */
export function releaseNoiseBuffer(ctx: AudioContext): void {
  noiseCache.delete(ctx);
}

export interface NoiseOptions {
  readonly when: number;
  readonly duration: number;
  readonly gain: number;
  readonly cutoffStart: number;
  readonly cutoffEnd?: number;
  readonly filter?: BiquadFilterType;
  readonly q?: number;
  readonly pitch?: number;
  readonly loop?: boolean;
  readonly attack?: number;
}

/** 噪声层：滤波扫频 + 指数衰减包络，用于枪声、脚步、机械声。 */
export function noiseLayer(
  ctx: AudioContext,
  output: AudioNode,
  options: NoiseOptions,
): AudioBufferSourceNode {
  const duration = Math.max(0.01, options.duration);
  const gain = Math.max(0.0001, options.gain);
  const when = Math.max(0, options.when);
  const source = ctx.createBufferSource();
  source.buffer = getNoiseBuffer(ctx);
  source.loop = options.loop ?? false;
  if (options.pitch !== undefined) source.playbackRate.value = options.pitch;

  const filter = ctx.createBiquadFilter();
  filter.type = options.filter ?? 'lowpass';
  filter.frequency.setValueAtTime(Math.max(40, options.cutoffStart), when);
  if (options.cutoffEnd !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, options.cutoffEnd), when + duration);
  }
  if (options.q !== undefined) filter.Q.value = options.q;

  const envelope = ctx.createGain();
  const loop = options.loop ?? false;
  if (loop) {
    // 循环底噪不做衰减包络，否则会在一秒内淡出。
    envelope.gain.setValueAtTime(gain, when);
  } else {
    const attack = Math.min(options.attack ?? 0.004, duration * 0.5);
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.linearRampToValueAtTime(gain, when + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  }

  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(output);
  source.start(when);
  if (!loop) source.stop(when + duration + 0.02);
  return source;
}

export interface ToneOptions {
  readonly when: number;
  readonly duration: number;
  readonly gain: number;
  readonly frequency: number;
  readonly endFrequency?: number;
  readonly type?: OscillatorType;
  readonly pitch?: number;
}

/** 音调层：可选频率扫频（低频冲击、命中提示音）。 */
export function toneLayer(
  ctx: AudioContext,
  output: AudioNode,
  options: ToneOptions,
): OscillatorNode {
  const duration = Math.max(0.01, options.duration);
  const when = Math.max(0, options.when);
  const pitch = options.pitch ?? 1;
  const osc = ctx.createOscillator();
  osc.type = options.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(1, options.frequency * pitch), when);
  if (options.endFrequency !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, options.endFrequency * pitch),
      when + duration,
    );
  }
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, when);
  envelope.gain.linearRampToValueAtTime(Math.max(0.0001, options.gain), when + Math.min(0.006, duration));
  envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(envelope);
  envelope.connect(output);
  osc.start(when);
  osc.stop(when + duration + 0.02);
  return osc;
}

export interface FootstepProfile {
  readonly material: SurfaceMaterial;
  readonly filterType: BiquadFilterType;
  readonly cutoff: number;
  readonly q: number;
  /** 相对基础响度，已含速度系数。 */
  readonly gain: number;
  readonly duration: number;
  readonly pitch: number;
}

const MATERIAL_PROFILE: Record<
  SurfaceMaterial,
  { filterType: BiquadFilterType; cutoff: number; q: number; gain: number; duration: number }
> = {
  sand: { filterType: 'lowpass', cutoff: 780, q: 0.7, gain: 0.8, duration: 0.11 },
  concrete: { filterType: 'bandpass', cutoff: 1700, q: 1.1, gain: 1, duration: 0.1 },
  metal: { filterType: 'bandpass', cutoff: 2600, q: 4.5, gain: 0.9, duration: 0.16 },
  wood: { filterType: 'bandpass', cutoff: 1250, q: 2.1, gain: 0.95, duration: 0.12 },
};

export function isSurfaceMaterial(value: unknown): value is SurfaceMaterial {
  return value === 'sand' || value === 'concrete' || value === 'metal' || value === 'wood';
}

/**
 * 脚步参数化：速度（0..1）越大，响度与音高越高、时长越短；
 * 材质决定滤波类型与中心频率。纯函数，便于单测。
 */
export function footstepProfile(material: SurfaceMaterial, speed: number): FootstepProfile {
  const base = MATERIAL_PROFILE[material];
  const s = Number.isFinite(speed) ? Math.min(1, Math.max(0, speed)) : 0.5;
  return {
    material,
    filterType: base.filterType,
    cutoff: base.cutoff,
    q: base.q,
    gain: base.gain * (0.55 + 0.45 * s),
    duration: base.duration * (1.15 - 0.3 * s),
    pitch: 0.85 + 0.5 * s,
  };
}

/** 步枪：高频噪声爆发 + 低频冲击 + 尾音短混响感。 */
export function renderRifle(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const { when, gain, pitch } = request;
  return [
    noiseLayer(ctx, output, {
      when,
      duration: 0.15,
      gain: gain * 0.9,
      cutoffStart: 7200,
      cutoffEnd: 900,
      pitch,
    }),
    noiseLayer(ctx, output, {
      when,
      duration: 0.3,
      gain: gain * 0.5,
      cutoffStart: 1400,
      cutoffEnd: 240,
      pitch,
    }),
    toneLayer(ctx, output, {
      when,
      duration: 0.17,
      gain: gain * 0.55,
      frequency: 96,
      endFrequency: 40,
      type: 'sine',
      pitch,
    }),
    noiseLayer(ctx, output, {
      when: when + 0.02,
      duration: 0.55,
      gain: gain * 0.12,
      cutoffStart: 860,
      cutoffEnd: 160,
    }),
  ];
}

/** 手枪：更短、更亮，冲击更轻。 */
export function renderPistol(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const { when, gain, pitch } = request;
  return [
    noiseLayer(ctx, output, {
      when,
      duration: 0.1,
      gain: gain * 0.8,
      cutoffStart: 6400,
      cutoffEnd: 1200,
      pitch,
    }),
    toneLayer(ctx, output, {
      when,
      duration: 0.12,
      gain: gain * 0.4,
      frequency: 132,
      endFrequency: 62,
      type: 'triangle',
      pitch,
    }),
    noiseLayer(ctx, output, {
      when: when + 0.01,
      duration: 0.34,
      gain: gain * 0.08,
      cutoffStart: 700,
      cutoffEnd: 200,
    }),
  ];
}

/** 换弹：多段机械声（退匣、上匣、拉栓、复位）。 */
export function renderReload(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const { when, gain, pitch } = request;
  const stages: ReadonlyArray<{ offset: number; frequency: number; length: number; click: number }> = [
    { offset: 0, frequency: 520, length: 0.035, click: 0.16 },
    { offset: 0.13, frequency: 330, length: 0.05, click: 0.22 },
    { offset: 0.27, frequency: 410, length: 0.045, click: 0.2 },
    { offset: 0.42, frequency: 610, length: 0.03, click: 0.18 },
  ];
  const sources: AudioScheduledSourceNode[] = [];
  for (const stage of stages) {
    sources.push(
      toneLayer(ctx, output, {
        when: when + stage.offset,
        duration: stage.length,
        gain: gain * 0.1,
        frequency: stage.frequency,
        endFrequency: stage.frequency * 0.6,
        type: 'square',
        pitch,
      }),
      noiseLayer(ctx, output, {
        when: when + stage.offset,
        duration: stage.length * 1.4,
        gain: gain * 0.12 * (stage.click / 0.2),
        cutoffStart: 3200,
        cutoffEnd: 1100,
        filter: 'bandpass',
        q: 1.4,
        pitch,
      }),
    );
  }
  return sources;
}

/** 干火：扳机空击的短促机械点击。 */
export function renderDryFire(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const { when, gain, pitch } = request;
  return [
    toneLayer(ctx, output, {
      when,
      duration: 0.04,
      gain: gain * 0.18,
      frequency: 190,
      endFrequency: 120,
      type: 'square',
      pitch,
    }),
    noiseLayer(ctx, output, {
      when,
      duration: 0.025,
      gain: gain * 0.08,
      cutoffStart: 2600,
      cutoffEnd: 900,
      filter: 'bandpass',
      q: 1.6,
      pitch,
    }),
  ];
}

/** 脚步：材质 + 速度决定滤波、响度、音高与时长。 */
export function renderFootstep(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const materialParam = request.params.material;
  const material: SurfaceMaterial = isSurfaceMaterial(materialParam) ? materialParam : 'concrete';
  const speed = typeof request.params.speed === 'number' ? request.params.speed : 0.5;
  const profile = footstepProfile(material, speed);
  return [
    noiseLayer(ctx, output, {
      when: request.when,
      duration: profile.duration,
      gain: request.gain * profile.gain,
      cutoffStart: profile.cutoff * 1.6,
      cutoffEnd: profile.cutoff * 0.7,
      filter: profile.filterType,
      q: profile.q,
      pitch: request.pitch * profile.pitch,
    }),
    noiseLayer(ctx, output, {
      when: request.when + 0.004,
      duration: profile.duration * 1.8,
      gain: request.gain * profile.gain * 0.28,
      cutoffStart: profile.cutoff,
      cutoffEnd: profile.cutoff * 0.5,
      filter: profile.filterType,
      q: profile.q * 0.8,
      pitch: request.pitch * profile.pitch,
    }),
  ];
}

/** 命中：非爆头为单声提示，爆头为双声高音。 */
export function renderHit(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const headshot = request.params.headshot === 1 || request.params.headshot === 'true';
  const { when, gain, pitch } = request;
  if (headshot) {
    return [
      toneLayer(ctx, output, {
        when,
        duration: 0.06,
        gain: gain * 0.3,
        frequency: 1580,
        type: 'sine',
        pitch,
      }),
      toneLayer(ctx, output, {
        when: when + 0.03,
        duration: 0.05,
        gain: gain * 0.18,
        frequency: 2120,
        type: 'sine',
        pitch,
      }),
    ];
  }
  return [
    toneLayer(ctx, output, {
      when,
      duration: 0.05,
      gain: gain * 0.22,
      frequency: 1080,
      endFrequency: 900,
      type: 'sine',
      pitch,
    }),
  ];
}

/** 死亡：下滑音 + 噪声尾音。 */
export function renderDeath(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const { when, gain, pitch } = request;
  return [
    toneLayer(ctx, output, {
      when,
      duration: 0.5,
      gain: gain * 0.25,
      frequency: 320,
      endFrequency: 80,
      type: 'triangle',
      pitch,
    }),
    noiseLayer(ctx, output, {
      when,
      duration: 0.6,
      gain: gain * 0.1,
      cutoffStart: 900,
      cutoffEnd: 140,
    }),
  ];
}

/** 回合开始：两声上行提示。 */
export function renderRoundStart(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const { when, gain, pitch } = request;
  return [
    toneLayer(ctx, output, {
      when,
      duration: 0.12,
      gain: gain * 0.18,
      frequency: 430,
      type: 'sine',
      pitch,
    }),
    toneLayer(ctx, output, {
      when: when + 0.11,
      duration: 0.16,
      gain: gain * 0.16,
      frequency: 650,
      type: 'sine',
      pitch,
    }),
  ];
}

/** 回合结束：胜/负两套三音琶音。 */
export function renderRoundEnd(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  const win = request.params.win !== 0 && request.params.win !== 'false';
  const notes = win ? [523, 659, 784] : [392, 311, 233];
  const { when, gain, pitch } = request;
  return notes.map((frequency, index) =>
    toneLayer(ctx, output, {
      when: when + index * 0.11,
      duration: index === notes.length - 1 ? 0.2 : 0.14,
      gain: gain * 0.18,
      frequency,
      type: 'triangle',
      pitch,
    }),
  );
}

/** 环境底噪：低通噪声循环，首次 ensure 后常驻。 */
export function renderAmbience(
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
): AudioScheduledSourceNode[] {
  return [
    noiseLayer(ctx, output, {
      when: request.when,
      duration: 1,
      gain: request.gain * 0.035,
      cutoffStart: 260,
      cutoffEnd: 200,
      loop: true,
    }),
  ];
}
