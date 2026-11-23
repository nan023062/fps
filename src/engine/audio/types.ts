/**
 * 音频系统公共类型。
 *
 * 约束：
 * - 不加载任何外部音频文件，所有声音由 Oscillator / BufferSource 实时合成。
 * - 不 import 相机、玩法或 UI 模块；空间化只接收数值。
 */

/** 总线图：Master 是根，其余总线并联到 Master，可继续扩展。 */
export type BusId = 'master' | 'weapons' | 'footsteps' | 'ambience' | 'ui';

export const BUS_IDS: readonly BusId[] = ['master', 'weapons', 'footsteps', 'ambience', 'ui'];

/** 可扩展的子总线列表（master 之外）。 */
export const CHILD_BUS_IDS: readonly BusId[] = ['weapons', 'footsteps', 'ambience', 'ui'];

export function isBusId(value: string): value is BusId {
  return (BUS_IDS as readonly string[]).includes(value);
}

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 地面材质：决定脚步噪声的滤波与包络。 */
export type SurfaceMaterial = 'sand' | 'concrete' | 'metal' | 'wood';

export type PanningModel = 'HRTF' | 'equalpower';

export interface SoundDef {
  readonly id: string;
  readonly bus: BusId;
  /** 0..100，抢占时低优先级先被抢占。 */
  readonly priority: number;
  /** 一次性音效的标称时长（秒），用于排定释放兜底与测试断言。 */
  readonly duration: number;
  /** 同一音效最短间隔（秒）。 */
  readonly cooldown: number;
  readonly loop: boolean;
  readonly gain: number;
  /** 音高抖动比例：0.06 表示 ±6%。 */
  readonly pitchJitter: number;
  /** 增益抖动比例。 */
  readonly gainJitter: number;
  /** 是否使用 PannerNode。UI 总线会被强制关掉。 */
  readonly spatial: boolean;
  readonly refDistance: number;
  readonly maxDistance: number;
  readonly rolloff: number;
  readonly panningModel: PanningModel;
}

export interface BusState {
  readonly volume: number;
  readonly muted: boolean;
  readonly soloed: boolean;
}

/** 合成器请求：只包含数值与基础参数，渲染函数不读取引擎状态。 */
export interface SynthRequest {
  readonly def: SoundDef;
  /** AudioContext 时间轴上的起始时刻。 */
  readonly when: number;
  /** 已应用 bus/音量/抖动的最终增益。 */
  readonly gain: number;
  /** 已应用音高抖动的播放速率，1 为原速。 */
  readonly pitch: number;
  /** 音效参数（material、speed、headshot、win 等）。 */
  readonly params: Readonly<Record<string, number | string | undefined>>;
}

/** 渲染函数把节点接到 output 上，并返回可停止/断开的源节点。 */
export type SynthLayer = (
  ctx: AudioContext,
  output: AudioNode,
  request: SynthRequest,
) => AudioScheduledSourceNode[];

export interface SoundEntry {
  readonly def: SoundDef;
  readonly render: SynthLayer;
}

export type SoundLibrary = ReadonlyMap<string, SoundEntry>;

export interface PlayOptions {
  readonly position?: Vec3Like;
  /** 0..1 的额外音量系数。 */
  readonly volume?: number;
  /** 播放速率倍率（在音高抖动之前应用）。 */
  readonly pitch?: number;
  /** 跳过冷却检查（调试或关键提示音）。 */
  readonly force?: boolean;
  /**
   * 覆盖音效定义的 spatial 标志（A2 接线需要）：玩家自身开枪复用 Bot 的
   * rifle/pistol 定义，但要按非空间化播放；UI 总线仍强制非空间化。
   */
  readonly spatial?: boolean;
  readonly params?: Readonly<Record<string, number | string | undefined>>;
}

/** play() 返回的句柄：即使引擎降级也返回可用（无副作用）对象。 */
export interface SoundHandle {
  readonly id: string;
  readonly bus: BusId;
  isActive(): boolean;
  stop(fadeSeconds?: number): void;
  setPosition(position: Vec3Like): void;
  setVolume(volume: number): void;
}

export type AudioSystemStatus =
  | 'uninitialized'
  | 'running'
  | 'suspended'
  | 'degraded'
  | 'disposed';

export interface ListenerState {
  readonly position: Vec3Like;
  readonly forward: Vec3Like;
  readonly up: Vec3Like;
}

export interface AudioSystemOptions {
  /** 注入 AudioContext 构造（测试与降级用）。返回 null 表示环境不支持。 */
  readonly contextFactory?: () => AudioContext | null;
  /** 确定性随机源，默认 Math.random。 */
  readonly rng?: () => number;
  /** 总并发上限，默认 32，超过会被夹到 64 以内。 */
  readonly maxVoices?: number;
  readonly perBusVoices?: Partial<Record<BusId, number>>;
  readonly busVolumes?: Partial<Record<BusId, number>>;
  readonly masterVolume?: number;
  /** 增益平滑时间常数（秒）。 */
  readonly smoothTime?: number;
  readonly library?: SoundLibrary;
  readonly extraSounds?: readonly SoundEntry[];
  /** 首次 ensure() 后自动启动环境底噪。 */
  readonly autoAmbience?: boolean;
  /** 环境底噪音效 id。 */
  readonly ambienceId?: string;
}
