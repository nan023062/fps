/**
 * 兼容 facade：保留旧 AudioEngine 的公开方法，内部转发到 src/engine/audio。
 *
 * 新增能力（总线、并发、空间化、句柄）请直接用 `AudioSystem` 或经本类的
 * 扩展方法；本文件不再自己创建节点，只负责默认参数与旧调用面的适配。
 */
import { AudioSystem } from '../engine/audio/system';
import { hitSoundId, roundEndSoundId, footstepSoundId, SOUND_IDS } from '../engine/audio/sounds';
import type { SurfaceMaterial } from '../engine/audio/types';
import type { PlayOptions } from '../engine/audio/types';
import { forwardFromAngles } from '../engine/audio/spatial';

export class AudioEngine {
  private readonly system: AudioSystem;
  private yaw = 0;
  private pitch = 0;

  constructor(system?: AudioSystem) {
    this.system = system ?? new AudioSystem();
  }

  /** 用户手势内调用；重复调用幂等。返回是否可用（false 表示已降级）。 */
  ensure(): boolean {
    return this.system.ensure();
  }

  get audio(): AudioSystem {
    return this.system;
  }

  /**
   * 枪声：
   * - 不传 position（玩家自己开枪）→ 非空间化，只经过 Weapons 总线；
   * - 传 position（Bot 开枪）→ 按世界坐标空间化（HRTF + 距离衰减）。
   */
  shot(kind: 'rifle' | 'pistol', position?: { x: number; y: number; z: number }): void {
    const id = kind === 'rifle' ? SOUND_IDS.rifle : SOUND_IDS.pistol;
    this.system.play(id, position ? { position } : { spatial: false });
  }

  hit(headshot: boolean): void {
    this.system.play(hitSoundId(headshot), {
      params: { headshot: headshot ? 1 : 0 },
      force: true,
    });
  }

  reload(): void {
    this.system.play(SOUND_IDS.reload);
  }

  dryFire(): void {
    this.system.play(SOUND_IDS.dryFire);
  }

  roundStart(): void {
    this.system.play(SOUND_IDS.roundStart, { force: true });
  }

  roundEnd(win: boolean): void {
    this.system.play(roundEndSoundId(win), {
      params: { win: win ? 1 : 0 },
      force: true,
    });
  }

  /** 脚步：材质与速度决定滤波/音量/音高；position 为世界坐标（可选）。 */
  footstep(material: SurfaceMaterial, speed: number, position?: { x: number; y: number; z: number }): void {
    this.system.play(footstepSoundId(material), {
      params: { material, speed },
      // 没有世界坐标时退化为非空间化，避免声音固定在世界原点。
      ...(position ? { position } : { spatial: false }),
    });
  }

  /** 环境底噪开关；默认 ensure() 后自动启动。 */
  ambience(enabled = true): void {
    if (enabled) this.system.play(SOUND_IDS.ambience, { force: true });
    else this.system.stopAll('ambience');
  }

  /**
   * 相机姿态跟随：main.ts 下一任务接线时把 yaw/pitch 与视点位置传入。
   * 只传数值，音频层不 import 相机模块。
   */
  setListenerFromCamera(
    position: { x: number; y: number; z: number },
    yaw: number,
    pitch: number,
    up?: { x: number; y: number; z: number },
  ): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.system.setListener(position, forwardFromAngles(yaw, pitch), up);
  }

  get yawAngle(): number {
    return this.yaw;
  }

  get pitchAngle(): number {
    return this.pitch;
  }

  play(id: string, options?: PlayOptions): ReturnType<AudioSystem['play']> {
    return this.system.play(id, options);
  }

  stopAll(bus?: Parameters<AudioSystem['stopAll']>[0]): void {
    this.system.stopAll(bus);
  }

  setBusVolume(bus: Parameters<AudioSystem['setBusVolume']>[0], volume: number): void {
    this.system.setBusVolume(bus, volume);
  }

  setBusMute(bus: Parameters<AudioSystem['setBusMute']>[0], muted: boolean): void {
    this.system.setBusMute(bus, muted);
  }

  setBusSolo(bus: Parameters<AudioSystem['setBusSolo']>[0], soloed: boolean): void {
    this.system.setBusSolo(bus, soloed);
  }

  /** 总线当前状态与解析后的实际增益（调试面板/下一阶段设置 UI 只读展示用）。 */
  getBusState(bus: Parameters<AudioSystem['getBusState']>[0]): ReturnType<AudioSystem['getBusState']> {
    return this.system.getBusState(bus);
  }

  busGains(): ReturnType<AudioSystem['busGains']> {
    return this.system.busGains();
  }

  suspend(): Promise<void> {
    return this.system.suspend();
  }

  resume(): Promise<void> {
    return this.system.resume();
  }

  dispose(): void {
    this.system.dispose();
  }

  get status(): AudioSystem['status'] {
    return this.system.status;
  }

  get degraded(): boolean {
    return this.system.degradedState;
  }

  /** 真实 AudioContext 状态（running/suspended），未初始化时为 null。 */
  get contextState(): string | null {
    return this.system.contextState;
  }

  get listenerState(): ReturnType<AudioSystem['getListener']> {
    return this.system.getListener();
  }

  get activeVoiceCount(): number {
    return this.system.activeVoiceCount;
  }
}

export type { BusId, SoundHandle, SurfaceMaterial } from '../engine/audio/types';
export { AudioSystem } from '../engine/audio/system';
