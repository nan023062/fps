import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../core/audio';
import { SOUND_IDS } from './sounds';
import { createHarness } from './fixtures';

/** 用 mock AudioContext 跑的 facade 兼容性测试（不依赖真实浏览器 API）。 */
function facade(harnessOptions: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness({ autoAmbience: false, ...harnessOptions });
  const engine = new AudioEngine(harness.system);
  return { ...harness, engine };
}

describe('AudioEngine facade 向后兼容', () => {
  it('保留旧方法并在 ensure 后可用', () => {
    const { engine, system, mock } = facade();
    expect(typeof engine.shot).toBe('function');
    expect(typeof engine.hit).toBe('function');
    expect(typeof engine.reload).toBe('function');
    expect(typeof engine.dryFire).toBe('function');
    expect(typeof engine.roundStart).toBe('function');
    expect(typeof engine.roundEnd).toBe('function');
    expect(typeof engine.ambience).toBe('function');
    engine.ensure();
    expect(engine.status).toBe('running');
    expect(system.status).toBe('running');
    expect(mock.created.gain.length).toBeGreaterThanOrEqual(5);
  });

  it('shot 区分步枪与手枪，且遵守冷却', () => {
    const { engine, system } = facade();
    engine.ensure();
    engine.shot('rifle');
    expect(system.activeVoiceCount).toBe(1);
    engine.shot('rifle');
    expect(system.activeVoiceCount).toBe(1);
    engine.shot('pistol');
    expect(system.activeVoiceCount).toBe(2);
  });

  it('hit / roundEnd 传入判定参数但仍可重复播放', () => {
    const { engine, system } = facade();
    engine.ensure();
    engine.hit(true);
    engine.hit(false);
    engine.roundEnd(true);
    engine.roundEnd(false);
    engine.reload();
    engine.dryFire();
    engine.roundStart();
    expect(system.activeVoiceCount).toBe(7);
    expect(system.play(SOUND_IDS.hit).isActive()).toBe(false);
  });

  it('footstep 按材质选择音效并携带参数', () => {
    const { engine, system } = facade();
    engine.ensure();
    engine.footstep('sand', 1, { x: 1, y: 0, z: 2 });
    const handle = system.play('footstep_metal', { params: { material: 'metal', speed: 0.2 } });
    expect(handle.isActive()).toBe(true);
    expect(engine.activeVoiceCount).toBe(2);
  });

  it('ambience(false) 停止底噪', () => {
    const { engine } = facade();
    engine.ensure();
    engine.ambience();
    expect(engine.activeVoiceCount).toBe(1);
    engine.ambience(false);
    expect(engine.activeVoiceCount).toBe(0);
  });

  it('setListenerFromCamera 只传数值并换算前向量', () => {
    const { engine, mock } = facade();
    engine.ensure();
    engine.setListenerFromCamera({ x: 2, y: 1.62, z: -3 }, 0, 0);
    expect(mock.listener.positionX.value).toBeCloseTo(2, 9);
    expect(mock.listener.forwardZ.value).toBeCloseTo(-1, 9);
    engine.setListenerFromCamera({ x: 2, y: 1.62, z: -3 }, Math.PI / 2, 0);
    expect(mock.listener.forwardX.value).toBeCloseTo(-1, 9);
    expect(engine.yawAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('总线设置与 dispose 通过 facade 透传', () => {
    const { engine, system, mock } = facade();
    engine.ensure();
    engine.setBusMute('weapons', true);
    expect(system.getBusState('weapons').muted).toBe(true);
    engine.setBusVolume('ui', 0.25);
    expect(system.getBusState('ui').volume).toBeCloseTo(0.25, 9);
    engine.setBusSolo('footsteps', true);
    expect(system.busGains().weapons).toBe(0);
    engine.play(SOUND_IDS.hit);
    engine.stopAll();
    expect(engine.activeVoiceCount).toBe(0);
    engine.dispose();
    expect(engine.status).toBe('disposed');
    expect(mock.closeCount).toBe(1);
  });

  it('未 ensure 时调用旧方法不创建节点', () => {
    const { engine, mock } = facade();
    engine.shot('rifle');
    engine.hit(true);
    engine.reload();
    engine.roundEnd(true);
    expect(mock.created.total).toBe(0);
    expect(engine.degraded).toBe(false);
  });
});
