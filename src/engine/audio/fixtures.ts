/**
 * 测试用 mock Web Audio 环境与确定性随机源。
 *
 * 只模拟 AudioSystem / 合成器实际用到的接口：AudioParam 写入、connect 计数、
 * PannerNode 属性、listener、buffer 与 currentTime。所有断言都基于这里记录的
 * 显式状态，不依赖真实浏览器。
 */
import { AudioSystem } from './system';
import type { AudioSystemOptions, SoundDef, SoundEntry } from './types';
import { createSoundDef } from './defs';

export interface ParamEvent {
  readonly type: string;
  readonly value: number;
  readonly time: number;
  readonly timeConstant?: number;
}

export class MockAudioParam {
  value = 0;
  readonly events: ParamEvent[] = [];

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'setValueAtTime', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'linearRampToValueAtTime', value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time });
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): void {
    this.value = value;
    this.events.push({ type: 'setTargetAtTime', value, time, timeConstant });
  }

  cancelScheduledValues(time: number): void {
    this.events.push({ type: 'cancelScheduledValues', value: this.value, time });
  }

  eventsOfType(type: string): ParamEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

export class MockAudioNode {
  readonly incoming: MockAudioNode[] = [];
  readonly connections: MockAudioNode[] = [];
  disconnectCount = 0;

  constructor(
    readonly kind: string,
    readonly context: MockAudioContext | null = null,
  ) {}

  connect<T extends MockAudioNode>(target: T): T {
    this.connections.push(target);
    target.incoming.push(this);
    return target;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connections.length = 0;
  }
}

export class MockGainNode extends MockAudioNode {
  readonly gain = new MockAudioParam();

  constructor(context: MockAudioContext) {
    super('gain', context);
  }
}

export class MockPannerNode extends MockAudioNode {
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX = new MockAudioParam();
  readonly positionY = new MockAudioParam();
  readonly positionZ = new MockAudioParam();
  readonly orientationX = new MockAudioParam();
  readonly orientationY = new MockAudioParam();
  readonly orientationZ = new MockAudioParam();
  positions: Array<{ x: number; y: number; z: number }> = [];
  private model: string;

  constructor(
    context: MockAudioContext,
    private readonly failHrtf: boolean,
    initial: 'HRTF' | 'equalpower',
  ) {
    super('panner', context);
    this.model = initial;
  }

  get panningModel(): string {
    return this.model;
  }

  set panningModel(value: string) {
    if (value === 'HRTF' && this.failHrtf) throw new Error('HRTF unsupported');
    this.model = value;
  }

  setPosition(x: number, y: number, z: number): void {
    this.positionX.value = x;
    this.positionY.value = y;
    this.positionZ.value = z;
    this.positions.push({ x, y, z });
  }
}

export class MockBufferSourceNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  loop = false;
  readonly playbackRate = new MockAudioParam();
  readonly detune = new MockAudioParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  /** 模拟浏览器：start 后调度结束时触发 onended。 */
  stopScheduled = false;

  constructor(context: MockAudioContext) {
    super('bufferSource', context);
  }

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(when = 0): void {
    this.stoppedAt = when;
    this.stopScheduled = true;
  }

  fireEnded(): void {
    const handler = this.onended;
    if (handler) handler();
  }
}

export class MockOscillatorNode extends MockAudioNode {
  type: OscillatorType = 'sine';
  readonly frequency = new MockAudioParam();
  readonly detune = new MockAudioParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;

  constructor(context: MockAudioContext) {
    super('oscillator', context);
  }

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(when = 0): void {
    this.stoppedAt = when;
  }

  fireEnded(): void {
    const handler = this.onended;
    if (handler) handler();
  }
}

export class MockBiquadFilterNode extends MockAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new MockAudioParam();
  readonly Q = new MockAudioParam();
  readonly gain = new MockAudioParam();

  constructor(context: MockAudioContext) {
    super('biquad', context);
  }
}

export class MockAudioBuffer {
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}

  get duration(): number {
    return this.length / Math.max(1, this.sampleRate);
  }

  getChannelData(): Float32Array {
    // 只为让合成器写入；长度夹到 1024 避免测试分配数万浮点。
    return new Float32Array(Math.min(1024, this.length));
  }
}

class MockAudioListener {
  readonly positionX = new MockAudioParam();
  readonly positionY = new MockAudioParam();
  readonly positionZ = new MockAudioParam();
  readonly forwardX = new MockAudioParam();
  readonly forwardY = new MockAudioParam();
  readonly forwardZ = new MockAudioParam();
  readonly upX = new MockAudioParam();
  readonly upY = new MockAudioParam();
  readonly upZ = new MockAudioParam();
}

export interface MockContextBehavior {
  readonly sampleRate?: number;
  /** createPanner 抛异常 */
  readonly failPanner?: boolean;
  /** 设置 panningModel='HRTF' 抛异常，用于验证 equalpower 回退 */
  readonly failHrtf?: boolean;
  /** resume() reject，模拟自动播放策略拦截 */
  readonly rejectResume?: boolean;
  /** createGain 抛异常，模拟总线搭建失败 */
  readonly failCreateGain?: boolean;
  readonly initialState?: AudioContextState;
}

export class MockAudioContext {
  readonly sampleRate: number;
  currentTime = 0;
  state: AudioContextState;
  readonly destination = new MockAudioNode('destination', null);
  readonly listener = new MockAudioListener();
  readonly created = {
    gain: [] as MockGainNode[],
    panner: [] as MockPannerNode[],
    bufferSource: [] as MockBufferSourceNode[],
    oscillator: [] as MockOscillatorNode[],
    biquad: [] as MockBiquadFilterNode[],
    buffers: 0,
    total: 0,
  };
  resumeCount = 0;
  suspendCount = 0;
  closeCount = 0;

  constructor(private readonly behavior: MockContextBehavior = {}) {
    this.sampleRate = behavior.sampleRate ?? 8000;
    this.state = behavior.initialState ?? 'running';
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.behavior.rejectResume) return Promise.reject(new Error('autoplay blocked'));
    this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCount += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    this.state = 'closed';
    return Promise.resolve();
  }

  createGain(): MockGainNode {
    if (this.behavior.failCreateGain) throw new Error('gain not available');
    const node = new MockGainNode(this);
    this.created.gain.push(node);
    this.created.total += 1;
    return node;
  }

  createPanner(): MockPannerNode {
    if (this.behavior.failPanner) throw new Error('panner not available');
    const node = new MockPannerNode(this, this.behavior.failHrtf ?? false, 'equalpower');
    this.created.panner.push(node);
    this.created.total += 1;
    return node;
  }

  createBufferSource(): MockBufferSourceNode {
    const node = new MockBufferSourceNode(this);
    this.created.bufferSource.push(node);
    this.created.total += 1;
    return node;
  }

  createOscillator(): MockOscillatorNode {
    const node = new MockOscillatorNode(this);
    this.created.oscillator.push(node);
    this.created.total += 1;
    return node;
  }

  createBiquadFilter(): MockBiquadFilterNode {
    const node = new MockBiquadFilterNode(this);
    this.created.biquad.push(node);
    this.created.total += 1;
    return node;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
    this.created.buffers += 1;
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
  }

  /** 让所有已调度的源触发 onended，等价于真实浏览器的播放结束回调。 */
  fireAllEnded(): void {
    for (const source of this.created.bufferSource) source.fireEnded();
    for (const source of this.created.oscillator) source.fireEnded();
  }

  /** 测试侧类型转换：真实代码只依赖 AudioContext 的类型，不依赖 mock 类。 */
  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}

/** mulberry32：确定性随机源，便于断言抖动与噪声。 */
export function seededRng(seed = 0x9e3779b9): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HarnessOptions extends Omit<AudioSystemOptions, 'contextFactory'> {
  readonly behavior?: MockContextBehavior;
}

export interface Harness {
  readonly mock: MockAudioContext;
  readonly system: AudioSystem;
  /** 初始化（等价于用户手势内的 ensure）。 */
  start(): AudioSystem;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const { behavior, ...systemOptions } = options;
  const mock = new MockAudioContext(behavior);
  const system = new AudioSystem({
    ...systemOptions,
    contextFactory: () => mock.asAudioContext(),
  });
  return {
    mock,
    system,
    start: () => {
      system.ensure();
      return system;
    },
  };
}

/** 便于在空间化与总线测试里构造自定义音效。 */
export function makeEntry(
  def: Partial<Omit<SoundDef, 'id' | 'bus'>> & { readonly id: string; readonly bus: SoundDef['bus'] },
  render: SoundEntry['render'],
): SoundEntry {
  return { def: createSoundDef(def), render };
}

/** 一个极简合成器：只创建 1 个 BufferSource，便于断言 voice 数量。 */
export function silentRender(): SoundEntry['render'] {
  return (ctx, output) => {
    const source = ctx.createBufferSource();
    source.connect(output);
    source.start(0);
    return [source];
  };
}
