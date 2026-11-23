import { describe, expect, it } from 'vitest';
import { AudioSystem } from './system';
import { SOUND_IDS } from './sounds';
import { createHarness, makeEntry, silentRender, seededRng } from './fixtures';
import type { MockGainNode, MockPannerNode } from './fixtures';

function started(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(options);
  harness.start();
  return harness;
}

describe('生命周期与降级', () => {
  it('ensure 之前不创建任何节点，play 返回空句柄', () => {
    const { mock, system } = createHarness({ autoAmbience: false });
    expect(system.status).toBe('uninitialized');
    const handle = system.play(SOUND_IDS.rifle);
    expect(handle.isActive()).toBe(false);
    expect(mock.created.total).toBe(0);
    handle.stop();
    handle.setVolume(0.5);
    handle.setPosition({ x: 1, y: 1, z: 1 });
  });

  it('ensure 搭建 Master 与 4 条总线并进入 running', () => {
    const { mock, system } = createHarness({ autoAmbience: false });
    expect(system.ensure()).toBe(true);
    expect(system.status).toBe('running');
    expect(mock.created.gain).toHaveLength(5);
    expect(mock.created.gain[0].connections).toContain(mock.destination);
  });

  it('ensure 幂等，不重复建总线', () => {
    const { mock, system } = createHarness({ autoAmbience: false });
    system.ensure();
    const before = mock.created.total;
    system.ensure();
    expect(mock.created.total).toBe(before);
    expect(mock.created.gain).toHaveLength(5);
  });

  it('环境不支持 AudioContext 时进入 degraded 且播放安全', () => {
    const system = new AudioSystem({ contextFactory: () => null, autoAmbience: false });
    expect(system.ensure()).toBe(false);
    expect(system.status).toBe('degraded');
    expect(system.degradedState).toBe(true);
    const handle = system.play(SOUND_IDS.rifle);
    expect(handle.isActive()).toBe(false);
  });

  it('总线搭建失败（createGain 抛异常）时降级不抛出', () => {
    const { system } = createHarness({
      autoAmbience: false,
      behavior: { failCreateGain: true },
    });
    expect(system.ensure()).toBe(false);
    expect(system.status).toBe('degraded');
  });

  it('resume 被自动播放策略拒绝时降级但不产生未捕获异常', async () => {
    const { mock, system } = createHarness({
      autoAmbience: false,
      behavior: { initialState: 'suspended', rejectResume: true },
    });
    system.ensure();
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.resumeCount).toBeGreaterThan(0);
    expect(system.status).toBe('degraded');
    await system.resume();
    expect(system.status).toBe('degraded');
  });

  it('suspend / resume 切换状态', async () => {
    const { mock, system } = started({ autoAmbience: false });
    await system.suspend();
    expect(mock.state).toBe('suspended');
    expect(system.status).toBe('suspended');
    await system.resume();
    expect(mock.state).toBe('running');
    expect(system.status).toBe('running');
  });

  it('dispose 后状态为 disposed，不再创建节点', () => {
    const { mock, system } = started({ autoAmbience: false });
    const handle = system.play(SOUND_IDS.rifle);
    expect(handle.isActive()).toBe(true);
    system.dispose();
    expect(system.status).toBe('disposed');
    expect(system.activeVoiceCount).toBe(0);
    expect(mock.closeCount).toBe(1);
    const created = mock.created.total;
    const after = system.play(SOUND_IDS.rifle);
    expect(after.isActive()).toBe(false);
    expect(mock.created.total).toBe(created);
    system.dispose();
    expect(mock.closeCount).toBe(1);
  });
});

describe('播放、句柄与并发', () => {
  it('play 返回活动句柄，spatial 音效创建 panner 并接到 voice 增益', () => {
    const { mock, system } = started({ autoAmbience: false });
    const handle = system.play(SOUND_IDS.rifle, { position: { x: 1, y: 2, z: 3 } });
    expect(handle.isActive()).toBe(true);
    expect(handle.id).toBe(SOUND_IDS.rifle);
    expect(handle.bus).toBe('weapons');
    expect(mock.created.panner).toHaveLength(1);
    expect(mock.created.panner[0].panningModel).toBe('HRTF');
    expect(mock.created.panner[0].positionX.value).toBeCloseTo(1, 9);
    expect(mock.created.bufferSource.length).toBeGreaterThan(0);
    expect(system.activeVoiceCount).toBe(1);
  });

  it('UI 总线音效强制非空间化（不创建 panner）', () => {
    const { mock, system } = started({ autoAmbience: false });
    system.play(SOUND_IDS.roundStart);
    system.play(SOUND_IDS.hit);
    expect(mock.created.panner).toHaveLength(0);
    expect(system.activeVoiceCount).toBe(2);
  });

  it('handle.stop 淡出、停止源并释放额度', () => {
    const { mock, system } = started({ autoAmbience: false });
    const handle = system.play(SOUND_IDS.rifle);
    const voiceGain = mock.created.gain[5] as MockGainNode;
    handle.stop();
    expect(handle.isActive()).toBe(false);
    expect(system.activeVoiceCount).toBe(0);
    expect(voiceGain.gain.value).toBe(0);
    for (const source of mock.created.bufferSource) {
      expect(source.stoppedAt).not.toBeNull();
    }
    handle.stop();
    expect(system.activeVoiceCount).toBe(0);
  });

  it('handle.setVolume 与 setPosition 作用到 voice 节点', () => {
    const { mock, system } = started({ autoAmbience: false });
    const handle = system.play(SOUND_IDS.rifle, { position: { x: 0, y: 0, z: 0 } });
    const voiceGain = mock.created.gain[5] as MockGainNode;
    handle.setVolume(0.5);
    expect(voiceGain.gain.value).toBeCloseTo(0.5, 9);
    handle.setPosition({ x: 4, y: 5, z: 6 });
    const panner = mock.created.panner[0] as MockPannerNode;
    expect(panner.positionX.value).toBeCloseTo(4, 9);
    expect(panner.positionY.value).toBeCloseTo(5, 9);
  });

  it('冷却窗口阻止同一音效连续播放，到点恢复', () => {
    const { mock, system } = started({ autoAmbience: false });
    expect(system.play(SOUND_IDS.rifle).isActive()).toBe(true);
    expect(system.play(SOUND_IDS.rifle).isActive()).toBe(false);
    expect(system.cooldownRemaining(SOUND_IDS.rifle)).toBeGreaterThan(0);
    mock.advance(0.05);
    expect(system.play(SOUND_IDS.rifle).isActive()).toBe(true);
  });

  it('force 跳过冷却，未知 id 返回空句柄且不占额度', () => {
    const { system } = started({ autoAmbience: false });
    system.play(SOUND_IDS.rifle);
    expect(system.play(SOUND_IDS.rifle, { force: true }).isActive()).toBe(true);
    expect(system.activeVoiceCount).toBe(2);
    expect(system.play('does_not_exist').isActive()).toBe(false);
    expect(system.activeVoiceCount).toBe(2);
  });

  it('并发上限触发优先级抢占，低优先级句柄失效', () => {
    const { system } = started({
      autoAmbience: false,
      maxVoices: 1,
      extraSounds: [
        makeEntry({ id: 'low', bus: 'weapons', priority: 10 }, silentRender()),
        makeEntry({ id: 'high', bus: 'weapons', priority: 90 }, silentRender()),
      ],
    });
    const low = system.play('low');
    expect(low.isActive()).toBe(true);
    const high = system.play('high');
    expect(high.isActive()).toBe(true);
    expect(low.isActive()).toBe(false);
    expect(system.activeVoiceCount).toBe(1);
  });

  it('高优先级音效不会被低优先级抢占', () => {
    const { system } = started({
      autoAmbience: false,
      maxVoices: 1,
      extraSounds: [
        makeEntry({ id: 'low', bus: 'weapons', priority: 10 }, silentRender()),
        makeEntry({ id: 'high', bus: 'weapons', priority: 90 }, silentRender()),
      ],
    });
    const high = system.play('high');
    const low = system.play('low');
    expect(low.isActive()).toBe(false);
    expect(high.isActive()).toBe(true);
    expect(system.activeVoiceCount).toBe(1);
  });

  it('stopAll(bus) 只停止该总线，stopAll() 停止全部', () => {
    const { system } = started({ autoAmbience: false });
    system.play(SOUND_IDS.rifle);
    system.play(SOUND_IDS.hit);
    system.play(SOUND_IDS.roundStart);
    expect(system.activeVoiceCount).toBe(3);
    system.stopAll('weapons');
    expect(system.activeVoiceCount).toBe(2);
    system.stopAll();
    expect(system.activeVoiceCount).toBe(0);
  });

  it('一次性音效在源结束后自动回收', () => {
    const { mock, system } = started({ autoAmbience: false });
    system.play(SOUND_IDS.hit);
    expect(system.activeVoiceCount).toBe(1);
    mock.fireAllEnded();
    expect(system.activeVoiceCount).toBe(0);
  });

  it('合成函数抛异常时不占用并发额度', () => {
    const { system } = started({
      autoAmbience: false,
      extraSounds: [
        makeEntry({ id: 'broken', bus: 'weapons' }, () => {
          throw new Error('synth failed');
        }),
      ],
    });
    const handle = system.play('broken');
    expect(handle.isActive()).toBe(false);
    expect(system.activeVoiceCount).toBe(0);
  });

  it('并发上限默认 32', () => {
    const { system } = createHarness({ autoAmbience: false });
    expect(system.maxVoices).toBe(32);
  });
});

describe('总线状态与 listener', () => {
  it('ensure 前的 mute/volume 设置会在初始化后生效', () => {
    const { mock, system } = createHarness({ autoAmbience: false });
    system.setBusMute('weapons', true);
    system.setBusVolume('ui', 0.5);
    system.ensure();
    expect(system.busGains().weapons).toBe(0);
    expect(system.getBusState('ui').volume).toBeCloseTo(0.5, 9);
    const busNodes = mock.created.gain.slice(0, 5) as MockGainNode[];
    expect(busNodes.map((node) => node.gain.value).some((value) => value === 0)).toBe(true);
  });

  it('solo 后其他总线增益为 0，可查询状态', () => {
    const { system } = started({ autoAmbience: false });
    system.setBusSolo('footsteps', true);
    expect(system.getBusState('footsteps').soloed).toBe(true);
    expect(system.busGains().footsteps).toBe(1);
    expect(system.busGains().weapons).toBe(0);
    expect(system.busGains().ui).toBe(0);
    system.setBusSolo('footsteps', false);
    expect(system.busGains().weapons).toBe(1);
  });

  it('setListener 写入 AudioListener，可随视角持续更新', () => {
    const { mock, system } = started({ autoAmbience: false });
    system.setListener({ x: 3, y: 1.62, z: -4 }, { x: 0, y: 0, z: -1 });
    expect(mock.listener.positionX.value).toBeCloseTo(3, 9);
    expect(mock.listener.positionZ.value).toBeCloseTo(-4, 9);
    expect(mock.listener.forwardZ.value).toBeCloseTo(-1, 9);
    system.setListener({ x: -1, y: 1.62, z: 8 }, { x: 1, y: 0, z: 0 });
    expect(mock.listener.positionX.value).toBeCloseTo(-1, 9);
    expect(mock.listener.forwardX.value).toBeCloseTo(1, 9);
    expect(system.getListener().position.z).toBe(8);
  });

  it('ensure 前设置的 listener 在初始化时写入', () => {
    const { mock, system } = createHarness({ autoAmbience: false });
    system.setListener({ x: 5, y: 1, z: 0 }, { x: 0, y: 0, z: -1 });
    system.ensure();
    expect(mock.listener.positionX.value).toBeCloseTo(5, 9);
  });

  it('环境底噪在 ensure 后自动启动并可停止', () => {
    const { system } = started();
    expect(system.activeVoiceCount).toBe(1);
    expect(system.ambienceVoice).not.toBeNull();
    system.stopAll('ambience');
    expect(system.activeVoiceCount).toBe(0);
    expect(system.ambienceVoice).toBeNull();
  });

  it('确定性随机源让抖动可复现', () => {
    const a = started({ autoAmbience: false, rng: seededRng(7) });
    const b = started({ autoAmbience: false, rng: seededRng(7) });
    a.system.play(SOUND_IDS.rifle);
    b.system.play(SOUND_IDS.rifle);
    const gainA = (a.mock.created.gain[5] as MockGainNode).gain.value;
    const gainB = (b.mock.created.gain[5] as MockGainNode).gain.value;
    expect(gainA).toBe(gainB);
  });
});
