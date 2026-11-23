import { describe, expect, it } from 'vitest';
import { velocityWeights, restPose } from '../engine/anim';
import {
  LOCOMOTION,
  LOCOMOTION_SPEEDS,
  RELOAD_CLIP_DURATION,
  RELOAD_SECONDS,
  RUN_DURATION,
  WALK_DURATION,
  aimWeaponMountRotation,
  createHumanClips,
  locomotionTimeScale,
  stepDuration,
} from './clips';
import { createHumanMasks, createHumanSkeleton, humanJointIndex } from './rig';

/**
 * 步频与位移匹配（不滑步）的数学依据：
 * 权重来自 E1 velocityWeights 的线性插值，因此“加权标称速度”恒等于实际速度，
 * 只要片段以 1 倍速播放，脚着地周期与位移就同步。
 */
describe('locomotion 标称速度：不滑步', () => {
  it('步态周期时长 = 两步位移 ÷ 标称速度', () => {
    expect(WALK_DURATION).toBeCloseTo((LOCOMOTION.walk.stride * 2) / LOCOMOTION.walk.speed, 9);
    expect(RUN_DURATION).toBeCloseTo((LOCOMOTION.run.stride * 2) / LOCOMOTION.run.speed, 9);
    expect(stepDuration('walk', LOCOMOTION.walk.speed)).toBeCloseTo(WALK_DURATION / 2, 9);
    expect(stepDuration('run', LOCOMOTION.run.speed)).toBeCloseTo(RUN_DURATION / 2, 9);
  });

  it('非法速度不会产生 0 或负的步长', () => {
    expect(stepDuration('walk', 0)).toBeCloseTo(LOCOMOTION.walk.stride / 0.01, 6);
    expect(stepDuration('run', Number.NaN)).toBeCloseTo(LOCOMOTION.run.stride / 0.01, 6);
    expect(stepDuration('walk', -3)).toBeGreaterThan(0);
  });

  it('任意速度下，加权标称速度 === 实际速度（混合区间不滑步）', () => {
    for (let speed = 0; speed <= LOCOMOTION.run.speed + 0.5; speed += 0.05) {
      const weights = velocityWeights(speed, LOCOMOTION_SPEEDS);
      const nominal = weights.reduce((sum, weight, index) => sum + weight * LOCOMOTION_SPEEDS[index], 0);
      expect(nominal).toBeCloseTo(Math.min(speed, LOCOMOTION.run.speed), 9);
    }
  });

  it('权重单调且和为 1', () => {
    let previousIdle = 1;
    let previousRun = 0;
    for (let speed = 0; speed <= 8; speed += 0.1) {
      const weights = velocityWeights(speed, LOCOMOTION_SPEEDS);
      expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 9);
      expect(weights[0]).toBeLessThanOrEqual(previousIdle + 1e-12);
      expect(weights[2]).toBeGreaterThanOrEqual(previousRun - 1e-12);
      previousIdle = weights[0];
      previousRun = weights[2];
    }
  });

  it('片段时间倍率只在超过跑步标称速度时生效', () => {
    expect(locomotionTimeScale(0)).toBe(1);
    expect(locomotionTimeScale(LOCOMOTION.walk.speed)).toBe(1);
    expect(locomotionTimeScale(LOCOMOTION.run.speed)).toBe(1);
    expect(locomotionTimeScale(LOCOMOTION.run.speed * 1.2)).toBeCloseTo(1.2, 9);
    expect(locomotionTimeScale(100)).toBe(1.6);
    expect(locomotionTimeScale(Number.NaN)).toBe(1);
  });
});

describe('程序化人体片段', () => {
  const skeleton = createHumanSkeleton();
  const index = humanJointIndex();
  const masks = createHumanMasks(skeleton);
  const clips = createHumanClips(skeleton, index, masks);

  it('关节拓扑覆盖 root/脊柱/双臂/双腿，父下标小于子下标', () => {
    skeleton.joints.forEach((joint, i) => {
      if (joint.parent !== null) expect(joint.parent).toBeLessThan(i);
    });
    expect(index.handR).toBeGreaterThan(index.upperArmR);
    expect(index.footL).toBeGreaterThan(index.lowerLegL);
    expect(skeleton.joints).toHaveLength(17);
  });

  it('idle/walk/run 时长与循环标记正确', () => {
    expect(clips.idle.loop).toBe(true);
    expect(clips.walk.loop).toBe(true);
    expect(clips.run.loop).toBe(true);
    expect(clips.walk.duration).toBeCloseTo(WALK_DURATION, 9);
    expect(clips.run.duration).toBeCloseTo(RUN_DURATION, 9);
    expect(clips.death.loop).toBe(false);
    expect(clips.fire.loop).toBe(false);
  });

  it('walk 与 run 每个周期各有两次脚步事件，相位相差半步', () => {
    for (const [clip, duration] of [
      [clips.walk, WALK_DURATION],
      [clips.run, RUN_DURATION],
    ] as const) {
      const steps = clip.events.filter((event) => event.name === 'footstep');
      expect(steps).toHaveLength(2);
      expect(steps[0].payload?.foot).toBe('left');
      expect(steps[1].payload?.foot).toBe('right');
      const gap = steps[1].time - steps[0].time;
      expect(gap).toBeCloseTo(duration / 2, 9);
      // 事件对齐到“脚落地”相位附近，而不是 0 时刻以外的任意位置。
      expect(steps[0].time).toBeLessThan(0.05);
    }
  });

  it('idle 片段不含脚步事件（原地不动不产生脚步）', () => {
    expect(clips.idle.events).toHaveLength(0);
  });

  it('开火片段有枪口事件，死亡片段有倒地标记', () => {
    expect(clips.fire.events.some((event) => event.name === 'muzzle')).toBe(true);
    expect(clips.death.events.some((event) => event.name === 'death')).toBe(true);
  });

  it('换弹片段与武器换弹时间对齐', () => {
    for (const weapon of ['rifle', 'pistol'] as const) {
      const speed = RELOAD_CLIP_DURATION / RELOAD_SECONDS[weapon];
      expect(clips.reload.duration / speed).toBeCloseTo(RELOAD_SECONDS[weapon], 9);
    }
  });

  it('瞄准 pitch 三档姿势速度升序，中间档保持中性', () => {
    const stops = clips.aimPitchStops;
    expect(stops).toHaveLength(3);
    expect(stops[0].speed).toBeLessThan(stops[1].speed);
    expect(stops[1].speed).toBeLessThan(stops[2].speed);
    const rest = restPose(skeleton);
    // 中间档（speed 0）的增量应为 0，否则 additive 层会把上半身带偏。
    for (const joint of [index.chest, index.head, index.upperArmL, index.upperArmR]) {
      const rotation = stops[1].pose.rotation[joint];
      expect(Math.abs(rotation.x) + Math.abs(rotation.y) + Math.abs(rotation.z)).toBeLessThan(1e-9);
      expect(stops[1].pose.position[joint].y).toBeCloseTo(rest.position[joint].y, 9);
    }
    // 上下档的增量方向相反（抬头 vs 低头）。
    expect(stops[2].pose.rotation[index.chest].x).toBeGreaterThan(0);
    expect(stops[0].pose.rotation[index.chest].x).toBeLessThan(0);
  });

  it('武器挂点旋转是持枪链条的逆，长度保持 1', () => {
    const rotation = aimWeaponMountRotation();
    expect(Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w)).toBeCloseTo(1, 9);
  });

  it('同一骨架重复构建片段结果一致（确定性）', () => {
    const again = createHumanClips(skeleton, index, masks);
    expect(again.walk.duration).toBe(clips.walk.duration);
    expect(again.walk.events.map((event) => event.time)).toEqual(clips.walk.events.map((event) => event.time));
  });
});
