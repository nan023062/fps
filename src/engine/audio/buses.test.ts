import { describe, expect, it } from 'vitest';
import {
  BusMixer,
  cloneMixState,
  createBusMixState,
  resolveBusGains,
  type BusMixState,
} from './buses';
import { MockAudioContext, type MockGainNode } from './fixtures';
import type { BusId } from './types';

function mockNode(node: GainNode): MockGainNode {
  return node as unknown as MockGainNode;
}

function mix(overrides: Partial<Record<BusId, Partial<BusMixState[BusId]>>> = {}): Record<BusId, BusMixState[BusId]> {
  const state = createBusMixState({ master: 0.8, weapons: 1, footsteps: 1, ambience: 1, ui: 1 });
  for (const [bus, patch] of Object.entries(overrides)) {
    state[bus as BusId] = { ...state[bus as BusId], ...patch };
  }
  return state;
}

describe('总线增益解析（纯函数）', () => {
  it('默认全部音量时各总线增益等于自身 volume，master 独立', () => {
    const gains = resolveBusGains(mix());
    expect(gains.master).toBeCloseTo(0.8, 9);
    expect(gains.weapons).toBe(1);
    expect(gains.footsteps).toBe(1);
    expect(gains.ambience).toBe(1);
    expect(gains.ui).toBe(1);
  });

  it('mute 单总线只影响该总线', () => {
    const gains = resolveBusGains(mix({ footsteps: { muted: true } }));
    expect(gains.footsteps).toBe(0);
    expect(gains.weapons).toBe(1);
  });

  it('master mute 只清零 master，子总线保持自身音量', () => {
    const gains = resolveBusGains(mix({ master: { muted: true } }));
    expect(gains.master).toBe(0);
    expect(gains.weapons).toBe(1);
  });

  it('solo 时非 solo 总线全部静音', () => {
    const gains = resolveBusGains(mix({ weapons: { soloed: true } }));
    expect(gains.weapons).toBe(1);
    expect(gains.footsteps).toBe(0);
    expect(gains.ambience).toBe(0);
    expect(gains.ui).toBe(0);
    expect(gains.master).toBeCloseTo(0.8, 9);
  });

  it('多个 solo 同时可听', () => {
    const gains = resolveBusGains(mix({ weapons: { soloed: true }, ui: { soloed: true } }));
    expect(gains.weapons).toBe(1);
    expect(gains.ui).toBe(1);
    expect(gains.footsteps).toBe(0);
  });

  it('solo 与 mute 叠加时静音优先', () => {
    const gains = resolveBusGains(mix({ weapons: { soloed: true, muted: true } }));
    expect(gains.weapons).toBe(0);
    expect(gains.ui).toBe(0);
  });

  it('volume 参与乘法并夹到 0..1', () => {
    const gains = resolveBusGains(mix({ ui: { volume: 0.25 }, weapons: { volume: 5 } }));
    expect(gains.ui).toBeCloseTo(0.25, 9);
    expect(gains.weapons).toBe(1);
  });

  it('cloneMixState 复制而不共享引用', () => {
    const source = mix();
    const copy = cloneMixState(source);
    copy.weapons = { ...copy.weapons, volume: 0.1 };
    expect(source.weapons.volume).toBe(1);
    expect(copy.weapons.volume).toBeCloseTo(0.1, 9);
  });
});

describe('BusMixer 节点图', () => {
  it('创建 Master 与 4 个子总线，Master 接 destination，子总线接 Master', () => {
    const ctx = new MockAudioContext();
    const mixer = new BusMixer(ctx.asAudioContext(), { state: mix() });
    expect(ctx.created.gain).toHaveLength(5);
    const master = mockNode(mixer.node('master'));
    expect(master.connections).toContain(ctx.destination);
    for (const bus of ['weapons', 'footsteps', 'ambience', 'ui'] as const) {
      expect(mockNode(mixer.node(bus)).connections).toContain(master);
    }
    expect(mixer.getState('weapons').volume).toBe(1);
  });

  it('初始增益直接落值（不产生开局淡入）', () => {
    const ctx = new MockAudioContext();
    const mixer = new BusMixer(ctx.asAudioContext(), { state: mix({ ui: { volume: 0.3 } }) });
    expect(mixer.node('master').gain.value).toBeCloseTo(0.8, 6);
    expect(mixer.node('ui').gain.value).toBeCloseTo(0.3, 6);
  });

  it('setVolume 走 setTargetAtTime 平滑', () => {
    const ctx = new MockAudioContext();
    const mixer = new BusMixer(ctx.asAudioContext(), { smoothTime: 0.08 });
    mixer.setVolume('weapons', 0.4);
    const events = mockNode(mixer.node('weapons')).gain.eventsOfType('setTargetAtTime');
    expect(events).toHaveLength(1);
    expect(events[0].value).toBeCloseTo(0.4, 9);
    expect(events[0].timeConstant).toBeCloseTo(0.08, 9);
    expect(mixer.node('weapons').gain.value).toBeCloseTo(0.4, 9);
  });

  it('setMute / setSolo 更新可查询状态与节点增益', () => {
    const ctx = new MockAudioContext();
    const mixer = new BusMixer(ctx.asAudioContext());
    mixer.setMute('ambience', true);
    expect(mixer.getState('ambience').muted).toBe(true);
    expect(mixer.node('ambience').gain.value).toBe(0);
    mixer.setMute('ambience', false);
    mixer.setSolo('weapons', true);
    expect(mixer.node('weapons').gain.value).toBe(1);
    expect(mixer.node('footsteps').gain.value).toBe(0);
    expect(mixer.node('ui').gain.value).toBe(0);
    expect(mixer.gains().ui).toBe(0);
  });

  it('master solo 被忽略，避免误把整条链静音', () => {
    const ctx = new MockAudioContext();
    const mixer = new BusMixer(ctx.asAudioContext());
    mixer.setSolo('master', true);
    expect(mixer.getState('master').soloed).toBe(false);
    expect(mixer.node('weapons').gain.value).toBe(1);
  });

  it('dispose 断开全部总线节点，之后写入不再产生事件', () => {
    const ctx = new MockAudioContext();
    const mixer = new BusMixer(ctx.asAudioContext());
    const master = mockNode(mixer.node('master'));
    mixer.dispose();
    expect(master.disconnectCount).toBe(1);
    expect(mockNode(mixer.node('weapons')).disconnectCount).toBe(1);
    mixer.setVolume('weapons', 0.2);
    expect(mixer.node('weapons').gain.value).toBe(1);
  });
});
