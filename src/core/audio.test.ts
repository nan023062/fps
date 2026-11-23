/**
 * A2 接线用到的 facade 契约测试（mock Web Audio，不依赖真实浏览器）。
 *
 * 覆盖 main.ts 现在依赖的三件事：
 * 1. 玩家自身枪声非空间化、Bot 枪声按世界坐标空间化；
 * 2. 脚步按材质取音效，带坐标时空间化；
 * 3. ensure() 返回可用性且在环境不支持时降级而不抛异常；
 * 4. 总线音量/静音/独享经 facade 转发并返回解析后的增益。
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from './audio';
import { createHarness } from '../engine/audio/fixtures';

function facade(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness({ autoAmbience: false, ...options });
  const engine = new AudioEngine(harness.system);
  return { ...harness, engine };
}

describe('AudioEngine facade：A2 接线契约', () => {
  it('shot() 不带坐标时非空间化，带坐标时创建 panner', () => {
    const { engine, mock } = facade();
    engine.ensure();
    const before = mock.created.panner.length;
    engine.shot('rifle');
    expect(mock.created.panner.length).toBe(before);
    // rifle 有 40ms 冷却，推进时间后再打一枪才能真实占用 voice。
    mock.advance(0.1);
    engine.shot('rifle', { x: 4, y: 1.6, z: -6 });
    expect(mock.created.panner.length).toBe(before + 1);
  });

  it('footstep 带坐标时空间化并按材质选音效', () => {
    const { engine, mock, system } = facade();
    engine.ensure();
    const before = mock.created.panner.length;
    engine.footstep('metal', 2.4, { x: 1, y: 0.9, z: 2 });
    expect(mock.created.panner.length).toBe(before + 1);
    expect(system.activeVoiceCount).toBe(1);
    // 无坐标时退化为非空间化，避免声音固定在世界原点。
    engine.footstep('sand', 1.2);
    expect(mock.created.panner.length).toBe(before + 1);
    expect(system.activeVoiceCount).toBe(2);
  });

  it('ensure() 返回可用性；上下文创建失败时降级且不抛', () => {
    const { engine } = facade();
    expect(engine.ensure()).toBe(true);
    expect(engine.status).toBe('running');
    // 同一实例重复 ensure 幂等，不重建上下文。
    expect(engine.ensure()).toBe(true);
    const failed = new AudioEngine();
    expect(() => failed.ensure()).not.toThrow();
    expect(failed.degraded).toBe(true);
    expect(failed.status).toBe('degraded');
    expect(() => failed.shot('rifle')).not.toThrow();
    expect(failed.activeVoiceCount).toBe(0);
  });

  it('总线设置转发并返回解析后的增益', () => {
    const { engine } = facade();
    engine.ensure();
    engine.setBusMute('weapons', true);
    expect(engine.busGains().weapons).toBeCloseTo(0, 9);
    expect(engine.getBusState('weapons').muted).toBe(true);
    engine.setBusMute('weapons', false);
    engine.setBusSolo('footsteps', true);
    const soloed = engine.busGains();
    expect(soloed.footsteps).toBeGreaterThan(0);
    expect(soloed.weapons).toBeCloseTo(0, 9);
    expect(soloed.master).toBeGreaterThan(0);
    engine.setBusSolo('footsteps', false);
    engine.setBusVolume('ui', 0.1);
    expect(engine.busGains().ui).toBeLessThan(engine.busGains().master);
  });
});
