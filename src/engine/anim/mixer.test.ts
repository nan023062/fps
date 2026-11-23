import { describe, expect, it } from 'vitest';
import { AnimationMixer } from './mixer';
import { createClip } from './clip';
import { positionTrack } from './track';
import { createBoneMask } from './blending';
import { restPose } from './skeleton';
import type { Pose } from './skeleton';
import {
  JOINT,
  JOINT_COUNT,
  constantClip,
  moveClip,
  testSkeleton,
} from './fixtures';

function poseAtRootX(pose: Pose): number {
  return pose.position[JOINT.root].x;
}

describe('AnimationMixer basics', () => {
  it('play 后 update(0) 采样起点姿势', () => {
    const skeleton = testSkeleton();
    const mixer = new AnimationMixer(skeleton);
    const clip = moveClip('walk', JOINT.root, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 1);
    const id = mixer.play(clip);
    expect(id).toBe('walk');
    expect(mixer.isPlaying('walk')).toBe(true);
    const frame = mixer.update(0);
    expect(poseAtRootX(frame.pose)).toBeCloseTo(0, 6);
    expect(frame.pose.position[JOINT.hips]).toEqual(restPose(skeleton).position[JOINT.hips]);
    expect(frame.events).toHaveLength(0);
    expect(mixer.time).toBe(0);
  });

  it('update(dt) 推进时间并输出插值后的姿势', () => {
    const mixer = new AnimationMixer(testSkeleton());
    const clip = moveClip('walk', JOINT.root, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 1);
    mixer.play(clip);
    expect(poseAtRootX(mixer.update(0.5).pose)).toBeCloseTo(5, 6);
    expect(poseAtRootX(mixer.update(0.25).pose)).toBeCloseTo(7.5, 6);
    expect(mixer.time).toBeCloseTo(0.75, 6);
    expect(poseAtRootX(mixer.pose)).toBeCloseTo(7.5, 6);
  });

  it('dt <= 0 或非有限值不推进时间也不触发事件', () => {
    const mixer = new AnimationMixer(testSkeleton());
    const clip = createClip({
      name: 'shot',
      duration: 1,
      jointCount: JOINT_COUNT,
      tracks: [positionTrack(JOINT.root, [{ time: 0, value: { x: 0, y: 0, z: 0 } }])],
      events: [{ name: 'muzzle', time: 0.5 }],
    });
    mixer.play(clip);
    mixer.update(0.5);
    expect(poseAtRootX(mixer.update(0).pose)).toBeCloseTo(0, 6);
    expect(mixer.update(-1).events).toHaveLength(0);
    expect(mixer.update(Number.NaN).events).toHaveLength(0);
    expect(mixer.time).toBeCloseTo(0.5, 6);
  });

  it('stop 移除单个动作或清空全部动作', () => {
    const mixer = new AnimationMixer(testSkeleton());
    mixer.play(constantClip('idle', JOINT.root, { x: 0, y: 0, z: 0 }));
    mixer.play(constantClip('walk', JOINT.root, { x: 1, y: 0, z: 0 }));
    expect(mixer.playingIds).toEqual(['idle', 'walk']);
    mixer.stop('idle');
    expect(mixer.isPlaying('idle')).toBe(false);
    expect(mixer.isPlaying('walk')).toBe(true);
    expect(poseAtRootX(mixer.update(0.1).pose)).toBeCloseTo(1, 6);
    mixer.stop();
    expect(mixer.playingIds).toHaveLength(0);
    expect(poseAtRootX(mixer.update(0.1).pose)).toBeCloseTo(0, 6);
    expect(mixer.update(0.1).pose.position[JOINT.hips]).toEqual(
      restPose(testSkeleton()).position[JOINT.hips],
    );
  });
});

describe('AnimationMixer events', () => {
  it('事件跨过时间点只触发一次，循环时下一圈再触发', () => {
    const mixer = new AnimationMixer(testSkeleton());
    const clip = createClip({
      name: 'shot',
      duration: 1,
      jointCount: JOINT_COUNT,
      tracks: [positionTrack(JOINT.root, [{ time: 0, value: { x: 0, y: 0, z: 0 } }])],
      events: [{ name: 'muzzle', time: 0.5 }],
    });
    mixer.play(clip);
    expect(mixer.update(0.4).events).toHaveLength(0);
    const fired = mixer.update(0.2).events;
    expect(fired).toHaveLength(1);
    expect(fired[0].name).toBe('muzzle');
    expect(fired[0].clip).toBe('shot');
    expect(fired[0].actionId).toBe('shot');
    expect(mixer.update(0.2).events).toHaveLength(0);
    const nextLoop = mixer.update(1).events;
    expect(nextLoop).toHaveLength(1);
    expect(nextLoop[0].name).toBe('muzzle');
  });

  it('非循环动作在时长端点只触发一次并停在末帧', () => {
    const mixer = new AnimationMixer(testSkeleton());
    const clip = createClip({
      name: 'reload',
      duration: 1,
      loop: false,
      jointCount: JOINT_COUNT,
      tracks: [
        positionTrack(JOINT.root, [
          { time: 0, value: { x: 0, y: 0, z: 0 } },
          { time: 1, value: { x: 4, y: 0, z: 0 } },
        ]),
      ],
      events: [
        { name: 'footstep', time: 0.8 },
        { name: 'reload', time: 1 },
      ],
    });
    mixer.play(clip);
    const first = mixer.update(2);
    expect(first.events.map((event) => event.name)).toEqual(['footstep', 'reload']);
    expect(poseAtRootX(first.pose)).toBeCloseTo(4, 6);
    const second = mixer.update(1);
    expect(second.events).toHaveLength(0);
    expect(poseAtRootX(second.pose)).toBeCloseTo(4, 6);
  });
});

describe('AnimationMixer crossFade', () => {
  function setup() {
    const mixer = new AnimationMixer(testSkeleton());
    mixer.play(constantClip('idle', JOINT.root, { x: 0, y: 0, z: 0 }));
    mixer.play(constantClip('walk', JOINT.root, { x: 10, y: 0, z: 0 }), { weight: 0 });
    return mixer;
  }

  it('中点权重各 0.5，姿势取中间值', () => {
    const mixer = setup();
    mixer.crossFade('idle', 'walk', 1);
    const frame = mixer.update(0.5);
    expect(mixer.weightOf('idle')).toBeCloseTo(0.5, 6);
    expect(mixer.weightOf('walk')).toBeCloseTo(0.5, 6);
    expect(poseAtRootX(frame.pose)).toBeCloseTo(5, 6);
  });

  it('淡入淡出结束后目标权重 1，来源动作被移除', () => {
    const mixer = setup();
    mixer.crossFade('idle', 'walk', 1);
    mixer.update(0.5);
    const frame = mixer.update(0.5);
    expect(mixer.isPlaying('idle')).toBe(false);
    expect(mixer.weightOf('walk')).toBeCloseTo(1, 6);
    expect(poseAtRootX(frame.pose)).toBeCloseTo(10, 6);
  });

  it('duration <= 0 立即完成切换', () => {
    const mixer = setup();
    mixer.crossFade('idle', 'walk', 0);
    expect(mixer.isPlaying('idle')).toBe(false);
    expect(mixer.weightOf('walk')).toBeCloseTo(1, 6);
    expect(poseAtRootX(mixer.update(0.1).pose)).toBeCloseTo(10, 6);
  });

  it('crossFadeTo 淡出当前 layer 0 动作', () => {
    const mixer = new AnimationMixer(testSkeleton());
    mixer.play(constantClip('idle', JOINT.root, { x: 0, y: 0, z: 0 }));
    const id = mixer.crossFadeTo(constantClip('run', JOINT.root, { x: 6, y: 0, z: 0 }), 1);
    expect(id).toBe('run');
    expect(mixer.update(0.5).pose.position[JOINT.root].x).toBeCloseTo(3, 6);
    expect(mixer.isPlaying('idle')).toBe(true);
    mixer.update(0.5);
    expect(mixer.isPlaying('idle')).toBe(false);
    expect(mixer.update(0.1).pose.position[JOINT.root].x).toBeCloseTo(6, 6);
  });

  it('crossFade 缺少动作时抛错', () => {
    const mixer = setup();
    expect(() => mixer.crossFade('idle', 'missing', 1)).toThrow(/both actions/);
  });
});

describe('AnimationMixer layers and masks', () => {
  function layeredClip(name: string, positions: { joint: number; x: number }[]) {
    return createClip({
      name,
      duration: 1,
      jointCount: JOINT_COUNT,
      tracks: positions.map((entry) =>
        positionTrack(entry.joint, [{ time: 0, value: { x: entry.x, y: 0, z: 0 } }]),
      ),
    });
  }

  it('上半身 override 层只改遮罩关节，下半身保持 base', () => {
    const skeleton = testSkeleton();
    const mixer = new AnimationMixer(skeleton);
    mixer.play(
      layeredClip('base', [
        { joint: JOINT.root, x: 1 },
        { joint: JOINT.spine, x: 2 },
        { joint: JOINT.head, x: 2 },
        { joint: JOINT.leftLeg, x: 2 },
      ]),
    );
    const upper = createBoneMask(skeleton, ['spine']);
    mixer.play(
      layeredClip('upper', [
        { joint: JOINT.spine, x: 5 },
        { joint: JOINT.head, x: 5 },
        { joint: JOINT.leftLeg, x: 5 },
      ]),
      { id: 'upper', layer: 1, mask: upper, mode: 'override' },
    );
    const pose = mixer.update(0).pose;
    expect(pose.position[JOINT.spine].x).toBeCloseTo(5, 6);
    expect(pose.position[JOINT.head].x).toBeCloseTo(5, 6);
    expect(pose.position[JOINT.root].x).toBeCloseTo(1, 6);
    expect(pose.position[JOINT.leftLeg].x).toBeCloseTo(2, 6);
    expect(pose.position[JOINT.rightLeg]).toEqual({ x: -0.15, y: 0, z: 0 });
  });

  it('层权重为 0 时上层完全不生效', () => {
    const skeleton = testSkeleton();
    const mixer = new AnimationMixer(skeleton);
    mixer.play(layeredClip('base', [{ joint: JOINT.spine, x: 2 }]));
    const upper = createBoneMask(skeleton, ['spine']);
    mixer.play(layeredClip('upper', [{ joint: JOINT.spine, x: 9 }]), {
      id: 'upper',
      layer: 1,
      mask: upper,
    });
    mixer.setLayerWeight(1, 0);
    expect(mixer.layerWeight(1)).toBe(0);
    expect(mixer.update(0.1).pose.position[JOINT.spine].x).toBeCloseTo(2, 6);
    mixer.setLayerWeight(1, 1);
    expect(mixer.update(0.1).pose.position[JOINT.spine].x).toBeCloseTo(9, 6);
  });

  it('additive 层按动作权重叠加增量，未遮罩关节不变', () => {
    const skeleton = testSkeleton();
    const mixer = new AnimationMixer(skeleton);
    mixer.play(layeredClip('base', [{ joint: JOINT.spine, x: 1 }]));
    const upper = createBoneMask(skeleton, ['spine']);
    mixer.play(layeredClip('aim', [{ joint: JOINT.spine, x: 3 }]), {
      id: 'aim',
      layer: 1,
      mask: upper,
      mode: 'additive',
      weight: 0.5,
    });
    const pose = mixer.update(0.1).pose;
    // base 1 + 0.5 * (3 - rest 0) = 2.5
    expect(pose.position[JOINT.spine].x).toBeCloseTo(2.5, 6);
    expect(pose.position[JOINT.root].x).toBeCloseTo(0, 6);
    expect(pose.position[JOINT.leftLeg]).toEqual({ x: 0.15, y: 0, z: 0 });
  });

  it('没有遮罩的第 1 层按整具骨架权重混合', () => {
    const mixer = new AnimationMixer(testSkeleton());
    mixer.play(constantClip('base', JOINT.root, { x: 0, y: 0, z: 0 }));
    mixer.play(constantClip('upper', JOINT.root, { x: 8, y: 0, z: 0 }), {
      id: 'upper',
      layer: 1,
      weight: 0.25,
    });
    expect(poseAtRootX(mixer.update(0.1).pose)).toBeCloseTo(2, 6);
  });
});
