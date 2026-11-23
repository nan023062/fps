import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CharacterView, AIM_PITCH_EPSILON, CORPSE_VISIBLE_SECONDS, FOOTSTEP_MIN_WEIGHT } from './view';
import { createRenderState, type CharacterRenderState } from './state';
import { RUN_DURATION, WALK_DURATION } from './clips';

const STEP = 1 / 60;

function makeView(): CharacterView {
  return new CharacterView({ team: 'ct', accent: 0x4a90e2, variant: 1 });
}

function stateWith(changes: Partial<CharacterRenderState> = {}): CharacterRenderState {
  return { ...createRenderState('ct', 'rifle', 1), ...changes };
}

function runFor(view: CharacterView, state: CharacterRenderState, seconds: number, dt = STEP) {
  const events = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    events.push(...view.update(dt, state));
  }
  return events;
}

/** 同类事件带上播放轴时间，用于校验步频（at 是片段内局部时间，不能跨循环比较）。 */
function runTimed(view: CharacterView, state: CharacterRenderState, seconds: number, dt = STEP) {
  const rows: Array<{ t: number; kind?: string; gait?: string; foot?: string }> = [];
  const steps = Math.round(seconds / dt);
  let t = 0;
  for (let i = 0; i < steps; i += 1) {
    t += dt;
    for (const event of view.update(dt, state)) {
      rows.push({ t, kind: event.kind, gait: event.gait, foot: event.foot });
    }
  }
  return rows;
}

describe('CharacterView：速度 → locomotion 权重', () => {
  it('站立为 idle，走路速度处为 walk，跑步速度处为 run', () => {
    const view = makeView();
    view.update(STEP, stateWith({ speed: 0 }));

    runFor(view, stateWith({ speed: 1.6 }), 0.3);
    expect(view.currentWeights().idle).toBe(0);
    expect(view.currentWeights().walk).toBeCloseTo(1, 3);
    expect(view.currentWeights().run).toBe(0);

    runFor(view, stateWith({ speed: 4.1 }), 0.3);
    expect(view.currentWeights().run).toBeCloseTo(1, 3);
    expect(view.currentWeights().walk).toBe(0);
  });

  it('中间速度混合两条步态，权重和为 1 且单调', () => {
    const view = makeView();
    const speeds = [0, 0.6, 1.2, 1.6, 2.2, 2.9, 3.6, 4.1];
    const rows = speeds.map((speed) => {
      runFor(view, stateWith({ speed }), 0.15);
      const weights = view.currentWeights();
      expect(weights.idle + weights.walk + weights.run).toBeCloseTo(1, 3);
      return weights;
    });
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].idle).toBeLessThanOrEqual(rows[i - 1].idle + 1e-9);
      expect(rows[i].run).toBeGreaterThanOrEqual(rows[i - 1].run - 1e-9);
    }
  });
});

describe('CharacterView：脚步事件', () => {
  it('原地不动不产生任何脚步事件', () => {
    const view = makeView();
    const events = runFor(view, stateWith({ speed: 0 }), 6);
    expect(events.filter((event) => event.kind === 'footstep')).toHaveLength(0);
    expect(view.debug().events.footstep).toBe(0);
  });

  it('走路按半步周期出脚，左右脚交替', () => {
    const view = makeView();
    view.update(STEP, stateWith({ speed: 1.6 }));
    const rows = runTimed(view, stateWith({ speed: 1.6 }), WALK_DURATION * 2);
    const steps = rows.filter((row) => row.kind === 'footstep');
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.every((step) => step.gait === 'walk')).toBe(true);
    expect(new Set(steps.map((step) => step.foot))).toEqual(new Set(['left', 'right']));
    // 相邻两次脚步的间隔 = 半步时长（步频与位移匹配），误差不超过一帧。
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i].t - steps[i - 1].t).toBeCloseTo(WALK_DURATION / 2, 1);
      expect(Math.abs(steps[i].t - steps[i - 1].t - WALK_DURATION / 2)).toBeLessThanOrEqual(STEP);
    }
  });

  it('混合区间只让主导步态出脚（不会走跳双倍步频）', () => {
    const view = makeView();
    runFor(view, stateWith({ speed: 2.85 }), 0.05);
    const events = runFor(view, stateWith({ speed: 2.85 }), RUN_DURATION * 2);
    const steps = events.filter((event) => event.kind === 'footstep');
    // 两个周期最多 4 次脚步；若 walk/run 同时出脚会是 6–8 次。
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(5);
    const gaits = new Set(steps.map((step) => step.gait));
    expect(gaits.size).toBe(1);
  });

  it('跑步只由 run 片段出脚，不叠加 walk 的脚步', () => {
    const view = makeView();
    runFor(view, stateWith({ speed: 4.1 }), 0.05);
    const events = runFor(view, stateWith({ speed: 4.1 }), RUN_DURATION * 1.5);
    const steps = events.filter((event) => event.kind === 'footstep');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.gait === 'run')).toBe(true);
    // 一个周期两次脚步；1.5 个周期最多 3 次，若 walk 也在出脚会翻倍。
    expect(steps.length).toBeLessThanOrEqual(4);
    expect(FOOTSTEP_MIN_WEIGHT).toBeGreaterThan(0);
  });
});

describe('CharacterView：死亡与重生', () => {
  it('死亡只上报一次，之后不再重复，姿势倒地', () => {
    const view = makeView();
    runFor(view, stateWith({ speed: 0 }), 0.2);
    const standingHip = view.model.bones[view.index.pelvis].position.y;

    const deathEvents = runFor(view, stateWith({ alive: false }), 1.5);
    expect(deathEvents.filter((event) => event.kind === 'death')).toHaveLength(1);
    expect(view.isAlive).toBe(false);
    expect(view.debug().mode).toBe('dead');
    expect(view.debug().aimWeight).toBe(0);
    expect(view.debug().reloadWeight).toBe(0);
    expect(view.deathAge).toBeGreaterThan(1);
    expect(view.model.bones[view.index.pelvis].position.y).toBeLessThan(standingHip - 0.3);
  });

  it('重生恢复正常姿态与权重，死亡时长归零', () => {
    const view = makeView();
    runFor(view, stateWith({ alive: false }), 1.2);
    expect(view.deathAge).toBeGreaterThan(0);
    runFor(view, stateWith({ speed: 0 }), 0.4);
    expect(view.isAlive).toBe(true);
    expect(view.deathAge).toBe(0);
    expect(view.debug().mode).toBe('locomotion');
    expect(view.currentWeights().idle).toBeCloseTo(1, 3);
    const hip = view.model.bones[view.index.pelvis].position.y;
    expect(hip).toBeGreaterThan(0.85);
    expect(hip).toBeLessThan(1.02);
    expect(CORPSE_VISIBLE_SECONDS).toBeGreaterThan(0);
  });

  it('死亡期间不产生脚步事件', () => {
    const view = makeView();
    runFor(view, stateWith({ alive: false, speed: 4.1 }), 2);
    expect(view.debug().events.footstep).toBe(0);
  });
});

describe('CharacterView：武器切换与挂点', () => {
  it('切换武器只改可见性，换弹节奏随之更新', () => {
    const view = makeView();
    expect(view.currentWeapon).toBe('rifle');
    expect(view.model.weapons.rifle.group.visible).toBe(true);
    expect(view.model.weapons.pistol.group.visible).toBe(false);

    view.setWeapon('pistol');
    expect(view.currentWeapon).toBe('pistol');
    expect(view.model.weapons.rifle.group.visible).toBe(false);
    expect(view.model.weapons.pistol.group.visible).toBe(true);
    expect(view.debug().perf.weaponMeshes).toBe(4);
    expect(view.debug().perf.weaponTriangles).toBeGreaterThan(0);

    view.setWeapon('rifle');
    expect(view.debug().perf.weaponMeshes).toBe(8);
  });

  it('武器挂在右手骨骼的挂点上，枪口朝向角色正面', () => {
    const view = makeView();
    runFor(view, stateWith({ speed: 0 }), 0.2);
    view.group.updateMatrixWorld(true);
    const hand = view.model.bones[view.index.handR];
    expect(view.model.weaponMount.parent).toBe(hand);

    const mount = new THREE.Vector3();
    view.model.weaponMount.getWorldPosition(mount);
    view.group.worldToLocal(mount);
    // 角色正面为 -Z：枪在身前、胸口高度。
    expect(mount.z).toBeLessThan(-0.25);
    expect(mount.y).toBeGreaterThan(1.15);
    expect(mount.y).toBeLessThan(1.7);
  });
});

describe('CharacterView：事件转发', () => {
  it('开火边沿只上报一次枪口事件', () => {
    const view = makeView();
    runFor(view, stateWith({ speed: 0 }), 0.1);
    const first = view.update(STEP, stateWith({ firing: true }));
    // fire 片段的枪口事件在片段内 0.02s 处，因此边沿当帧之后才到达。
    expect(first.filter((event) => event.kind === 'muzzle')).toHaveLength(0);
    const after = runFor(view, stateWith({ firing: true }), 0.3);
    expect(after.filter((event) => event.kind === 'muzzle')).toHaveLength(1);
    expect(view.debug().events.muzzle).toBe(1);
  });

  it('换弹开始与结束各转发一次 reload', () => {
    const view = makeView();
    view.update(STEP, stateWith({ reloading: false }));
    const start = view.update(STEP, stateWith({ reloading: true }));
    expect(start).toEqual([{ kind: 'reload', source: 'state', phase: 'start' }]);
    const end = view.update(STEP, stateWith({ reloading: false }));
    expect(end).toEqual([{ kind: 'reload', source: 'state', phase: 'end' }]);
  });

  it('事件对象带来源与阶段，便于表现层消费', () => {
    const view = makeView();
    runFor(view, stateWith({ speed: 1.6 }), 0.2);
    const events = runFor(view, stateWith({ speed: 1.6 }), WALK_DURATION);
    const step = events.find((event) => event.kind === 'footstep');
    expect(step).toBeDefined();
    expect(step?.source).toBe('walk');
    expect(step?.speed).toBeCloseTo(1.6, 3);
    expect(step?.foot === 'left' || step?.foot === 'right').toBe(true);
  });
});

describe('CharacterView：上半身遮罩不影响下半身', () => {
  it('水平瞄准（pitch 0）与极小 pitch 的骨骼完全一致（跳过空增量层）', () => {
    const level = makeView();
    const tiny = makeView();
    runFor(level, stateWith({ speed: 0, aimPitch: 0 }), 0.3);
    runFor(tiny, stateWith({ speed: 0, aimPitch: AIM_PITCH_EPSILON / 4 }), 0.3);
    for (let i = 0; i < level.model.bones.length; i += 1) {
      const a = level.model.bones[i].quaternion;
      const b = tiny.model.bones[i].quaternion;
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)).toBeLessThan(1e-9);
    }
  });

  it('瞄准俯仰只改变上半身骨骼', () => {
    const up = makeView();
    const down = makeView();
    runFor(up, stateWith({ speed: 0, aimPitch: 0.8 }), 0.4);
    runFor(down, stateWith({ speed: 0, aimPitch: -0.8 }), 0.4);

    for (const joint of ['upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'footR', 'pelvis'] as const) {
      const a = up.model.bones[up.index[joint]].quaternion;
      const b = down.model.bones[down.index[joint]].quaternion;
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
      expect(Math.abs(a.z - b.z)).toBeLessThan(1e-6);
      expect(Math.abs(a.w - b.w)).toBeLessThan(1e-6);
    }
    const handA = up.model.bones[up.index.upperArmR].quaternion;
    const handB = down.model.bones[down.index.upperArmR].quaternion;
    expect(Math.abs(handA.x - handB.x) + Math.abs(handA.z - handB.z)).toBeGreaterThan(0.01);
  });
});

describe('CharacterView：退化输入', () => {
  it('dt = 0 / NaN 不推进动画、不产生事件、不写 NaN', () => {
    const view = makeView();
    runFor(view, stateWith({ speed: 1.6 }), 0.3);
    const before = view.debug().events.footstep;
    for (const dt of [0, -1, Number.NaN]) {
      const events = view.update(dt, stateWith({ speed: 1.6 }));
      expect(events).toHaveLength(0);
    }
    expect(view.debug().events.footstep).toBe(before);
    for (const bone of view.model.bones) {
      expect(Number.isFinite(bone.position.x)).toBe(true);
      expect(Number.isFinite(bone.quaternion.w)).toBe(true);
    }
  });

  it('速度/俯仰/位置非法时仍输出有限姿势', () => {
    const view = makeView();
    view.update(STEP, stateWith({
      speed: Number.NaN,
      aimPitch: Number.POSITIVE_INFINITY,
      crouch: Number.NaN,
      position: { x: 0, y: 0, z: 0 },
    }));
    expect(Number.isFinite(view.debug().speed)).toBe(true);
    for (const bone of view.model.bones) {
      expect(Number.isFinite(bone.position.y)).toBe(true);
      expect(Number.isFinite(bone.quaternion.x)).toBe(true);
    }
  });

  it('位置与朝向被写入角色组', () => {
    const view = makeView();
    view.update(STEP, stateWith({ position: { x: 3, y: 0, z: -4 }, yaw: 1.1 }));
    expect(view.group.position.x).toBe(3);
    expect(view.group.position.z).toBe(-4);
    expect(view.group.rotation.y).toBeCloseTo(1.1, 6);
  });
});

describe('CharacterView：性能预算与释放', () => {
  it('单角色网格数与阴影投射者受限（合批后）', () => {
    const view = makeView();
    const perf = view.debug().perf;
    expect(perf.bodyMeshes).toBeLessThanOrEqual(9);
    expect(perf.shadowCasters).toBeLessThanOrEqual(3);
    expect(perf.drawCalls).toBe(perf.bodyMeshes + perf.weaponMeshes);
    expect(perf.bodyTriangles).toBeGreaterThan(1000);
    expect(perf.bodyTriangles).toBeLessThan(12000);
    expect(perf.triangles).toBe(perf.bodyTriangles + perf.weaponTriangles);
  });

  it('dispose 后角色组脱离父节点', () => {
    const view = makeView();
    const parent = view.group.parent;
    expect(parent).toBeNull();
    view.dispose();
    expect(view.group.parent).toBeNull();
  });
});
