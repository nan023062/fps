import { describe, expect, it } from 'vitest';
import {
  animationParams,
  createRenderState,
  isReloading,
  readRenderState,
  speedFromPositions,
  transitionEvents,
  type CharacterRenderState,
  type RenderStateSource,
} from './state';
import { LOCOMOTION_SPEEDS } from './clips';

function source(overrides: Partial<RenderStateSource> = {}): RenderStateSource {
  return {
    position: { x: 1, y: 0, z: -2 },
    yaw: 0.5,
    pitch: 0.2,
    alive: true,
    team: 'ct',
    weapon: { id: 'rifle', reloading: false },
    ...overrides,
  };
}

describe('CharacterRenderState：纯数据输入', () => {
  it('默认状态存活、持步枪、速度为 0', () => {
    const state = createRenderState();
    expect(state.alive).toBe(true);
    expect(state.weaponId).toBe('rifle');
    expect(state.team).toBe('ct');
    expect(state.speed).toBe(0);
    expect(state.crouch).toBe(0);
    expect(state.firing).toBe(false);
  });

  it('readRenderState 就地写入，不替换 position 对象', () => {
    const state = createRenderState('t', 'pistol', 2);
    const position = state.position;
    readRenderState(state, source({ team: 't', weapon: { id: 'pistol', reloading: true } }));
    expect(state.position).toBe(position);
    expect(state.position).toEqual({ x: 1, y: 0, z: -2 });
    expect(state.yaw).toBe(0.5);
    expect(state.aimPitch).toBe(0.2);
    expect(state.team).toBe('t');
    expect(state.weaponId).toBe('pistol');
    expect(state.reloading).toBe(true);
  });

  it('速度与蹲伏被夹取到合法区间', () => {
    const state = createRenderState();
    readRenderState(state, source(), { speed: 99, crouch: 3 });
    expect(state.speed).toBe(24);
    readRenderState(state, source(), { speed: -8, crouch: -1 });
    expect(state.speed).toBe(0);
    expect(state.crouch).toBe(0);
    readRenderState(state, source(), { speed: Number.NaN, crouch: Number.POSITIVE_INFINITY });
    expect(state.speed).toBe(0);
    expect(state.crouch).toBe(0);
  });

  it('非有限的朝向/俯仰角回退为 0，避免 NaN 进入骨骼', () => {
    const state = createRenderState();
    readRenderState(state, source({ yaw: Number.NaN, pitch: Number.POSITIVE_INFINITY }));
    expect(state.yaw).toBe(0);
    expect(state.aimPitch).toBe(0);
  });

  it('extras 未提供 speed 时保留上一次速度', () => {
    const state = createRenderState();
    readRenderState(state, source(), { speed: 3 });
    readRenderState(state, source(), { firing: true });
    expect(state.speed).toBe(3);
    expect(state.firing).toBe(true);
  });
});

describe('speedFromPositions：位置差测速', () => {
  it('缺少上一帧、dt 非法或为负时返回 0', () => {
    expect(speedFromPositions(null, { x: 0, y: 0, z: 0 }, 0.016)).toBe(0);
    expect(speedFromPositions({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0)).toBe(0);
    expect(speedFromPositions({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, -1)).toBe(0);
    expect(speedFromPositions({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, Number.NaN)).toBe(0);
  });

  it('只统计水平位移，并夹取到最大速度', () => {
    const previous = { x: 0, y: 0, z: 0 };
    expect(speedFromPositions(previous, { x: 0.8, y: 9, z: 0 }, 0.5)).toBeCloseTo(1.6, 6);
    expect(speedFromPositions(previous, { x: 2.9, y: 0, z: 0 }, 0.01)).toBe(24);
  });

  it('单帧位移超过 3 米视为重生/传送，返回 0', () => {
    expect(speedFromPositions({ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 4 }, 1 / 60)).toBe(0);
  });

  it('坐标非有限时不产生 NaN 速度', () => {
    expect(speedFromPositions({ x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 0 }, 0.016)).toBe(0);
  });
});

describe('animationParams：状态 → 动画参数', () => {
  const speeds = [0, 0.4, 0.8, 1.2, 1.6, 2.2, 2.85, 3.5, 4.1, 6, 12];

  it('locomotion 权重和为 1，且随速度单调变化', () => {
    const rows = speeds.map((speed) => animationParams({ ...createRenderState(), speed }).weights);
    rows.forEach((weights) => {
      expect(weights.idle + weights.walk + weights.run).toBeCloseTo(1, 9);
    });
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].idle).toBeLessThanOrEqual(rows[i - 1].idle + 1e-12);
      expect(rows[i].run).toBeGreaterThanOrEqual(rows[i - 1].run - 1e-12);
    }
  });

  it('站立为纯 idle，跑步标称速度处为纯 run', () => {
    expect(animationParams({ ...createRenderState(), speed: 0 }).weights).toEqual({
      idle: 1,
      walk: 0,
      run: 0,
    });
    expect(animationParams({ ...createRenderState(), speed: LOCOMOTION_SPEEDS[2] }).weights).toEqual({
      idle: 0,
      walk: 0,
      run: 1,
    });
  });

  it('换弹、死亡切换 mode 并归零上半身层', () => {
    const reloading: CharacterRenderState = { ...createRenderState(), reloading: true };
    const reloadParams = animationParams(reloading);
    expect(reloadParams.mode).toBe('reload');
    expect(reloadParams.reloadWeight).toBe(1);
    expect(reloadParams.aimWeight).toBe(1);

    const dead: CharacterRenderState = { ...createRenderState(), alive: false, reloading: true };
    const deadParams = animationParams(dead);
    expect(deadParams.mode).toBe('dead');
    expect(deadParams.aimWeight).toBe(0);
    expect(deadParams.reloadWeight).toBe(0);
  });

  it('俯仰与蹲伏被夹取，时间倍率不超过 1.6', () => {
    const params = animationParams({
      ...createRenderState(),
      aimPitch: 9,
      crouch: 5,
      speed: 100,
    });
    expect(params.aimPitch).toBe(1.2);
    expect(params.crouch).toBe(1);
    expect(params.timeScale).toBe(1.6);
    expect(animationParams({ ...createRenderState(), speed: 4.1 }).timeScale).toBe(1);
    expect(animationParams({ ...createRenderState(), speed: Number.NaN }).timeScale).toBe(1);
  });
});

describe('transitionEvents：死亡与换弹跳变', () => {
  it('首次 update 不产生事件', () => {
    expect(transitionEvents(null, { alive: false, reloading: true })).toEqual([]);
  });

  it('存活→死亡上报一次 death', () => {
    const events = transitionEvents({ alive: true, reloading: false }, { alive: false, reloading: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'death', source: 'state' });
  });

  it('死亡→复活不产生事件', () => {
    expect(transitionEvents({ alive: false, reloading: false }, { alive: true, reloading: false })).toEqual([]);
  });

  it('换弹开始与结束分别上报一次', () => {
    const start = transitionEvents({ alive: true, reloading: false }, { alive: true, reloading: true });
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ kind: 'reload', phase: 'start', source: 'state' });

    const end = transitionEvents({ alive: true, reloading: true }, { alive: true, reloading: false });
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ kind: 'reload', phase: 'end' });
  });

  it('状态不变时没有事件', () => {
    expect(transitionEvents({ alive: true, reloading: true }, { alive: true, reloading: true })).toEqual([]);
  });

  it('死亡时不再算作换弹中', () => {
    const state: CharacterRenderState = { ...createRenderState(), reloading: true };
    expect(isReloading(state)).toBe(true);
    expect(isReloading({ ...state, alive: false })).toBe(false);
  });
});
