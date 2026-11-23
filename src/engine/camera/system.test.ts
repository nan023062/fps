import { describe, expect, it } from 'vitest';
import { CameraSystem } from './system';
import { applyCameraPose, type CameraLike } from './apply';
import { candidate, box, makeTarget, runFrames } from './fixtures';

function system(options: ConstructorParameters<typeof CameraSystem>[0] = {}): CameraSystem {
  return new CameraSystem(options);
}

describe('模式切换与姿态输出', () => {
  it('第一人称把视点放在眼睛位置', () => {
    const camera = system();
    const pose = camera.compute(1 / 60, makeTarget({ eye: { x: 1, y: 1.62, z: -2 } }));
    expect(pose.position).toEqual({ x: 1, y: 1.62, z: -2 });
    expect(pose.mode).toBe('firstPerson');
    expect(pose.fov).toBe(74);
    expect(Math.hypot(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w)).toBeCloseTo(1, 12);
  });

  it('蹲伏按 crouchDrop 下沉视点', () => {
    const stand = system().compute(1 / 60, makeTarget({ crouch: 0 }));
    const crouched = system().compute(1 / 60, makeTarget({ crouch: 1 }));
    expect(stand.position.y).toBeCloseTo(1.62, 9);
    expect(crouched.position.y).toBeCloseTo(1.1, 9);
  });

  it('调试第三人称紧跟焦点后上方并注视同一方向', () => {
    const camera = system({ mode: 'thirdPersonDebug' });
    const target = makeTarget({ yaw: 0, pitch: 0 });
    const pose = camera.compute(1 / 60, target);
    expect(pose.position.x).toBeCloseTo(0, 9);
    expect(pose.position.y).toBeCloseTo(1.62 + 0.55, 9);
    expect(pose.position.z).toBeCloseTo(3.2, 9);
    expect(pose.mode).toBe('thirdPersonDebug');
    expect(pose.distance).toBeCloseTo(Math.hypot(0.55, 3.2), 9);
  });

  it('第三人称按 target.velocity 滞后焦点（跟随拖尾）', () => {
    const still = system({ mode: 'thirdPersonDebug' }).compute(1 / 60, makeTarget());
    const moving = system({ mode: 'thirdPersonDebug' }).compute(
      1 / 60,
      makeTarget({ velocity: { x: 0, y: 0, z: 6 } }),
    );
    expect(moving.position.z).toBeCloseTo(still.position.z - 6 * 0.06, 6);
    expect(moving.distance).toBeCloseTo(still.distance, 6);
  });

  it('setMode 切换后立即吸附到新模式期望姿态', () => {
    const camera = system();
    const target = makeTarget();
    camera.compute(1 / 60, target);

    camera.setMode('thirdPersonDebug');
    const third = camera.compute(1 / 60, target);
    expect(third.mode).toBe('thirdPersonDebug');
    expect(third.position.z).toBeCloseTo(3.2, 9);

    camera.setMode('spectate');
    target.spectate = { candidates: [candidate('mate', { x: 4, y: 1.6, z: 1 })], preferredId: 'mate' };
    const spectate = camera.compute(1 / 60, target);
    expect(spectate.mode).toBe('spectate');
    expect(spectate.position).toEqual({ x: 4, y: 1.6, z: 1 });
    expect(camera.spectateId).toBe('mate');

    camera.setMode('firstPerson');
    const first = camera.compute(1 / 60, target);
    expect(first.mode).toBe('firstPerson');
    expect(first.position).toEqual({ x: 0, y: 1.62, z: 0 });
    expect(camera.spectateId).toBeNull();
  });

  it('compute 返回新对象，不写全局状态', () => {
    const camera = system();
    const target = makeTarget();
    const a = camera.compute(1 / 60, target);
    const b = camera.compute(1 / 60, target);
    expect(a).not.toBe(b);
    expect(a.position).not.toBe(b.position);
    expect(a.quaternion).not.toBe(b.quaternion);
  });
});

describe('平滑阻尼', () => {
  it('位置指数收敛：单帧不跳变，1 秒内贴合', () => {
    const camera = system();
    const target = makeTarget({ eye: { x: 0, y: 1.62, z: 0 } });
    camera.compute(1 / 60, target);
    target.eye.x = 0.8;

    const first = camera.compute(1 / 60, target);
    expect(first.position.x).toBeGreaterThan(0);
    expect(first.position.x).toBeLessThan(0.8);

    const converged = runFrames(camera, target, 60);
    expect(converged.position.x).toBeCloseTo(0.8, 3);
  });

  it('朝向走最短弧收敛（跨 ±π 不反向绕远路）', () => {
    const camera = system();
    const target = makeTarget({ yaw: 0 });
    camera.compute(1 / 60, target);
    target.yaw = -3.1;

    const step1 = camera.compute(1 / 60, target);
    expect(step1.yaw).toBeLessThan(0);
    expect(step1.yaw).toBeGreaterThan(-3.1);

    const converged = runFrames(camera, target, 200);
    expect(converged.yaw).toBeCloseTo(-3.1, 3);
  });

  it('远距离跳变（重生/换观战目标）直接吸附，不做长距离插值', () => {
    const camera = system();
    const target = makeTarget();
    camera.compute(1 / 60, target);
    target.eye = { x: 40, y: 1.62, z: 30 };
    const snapped = camera.compute(1 / 60, target);
    expect(snapped.position.x).toBeCloseTo(40, 9);
    expect(snapped.position.z).toBeCloseTo(30, 9);
  });
});

describe('trauma 抖动衰减', () => {
  it('trauma 单调递减并归零', () => {
    const camera = system({ traumaDecay: 0.85 });
    const target = makeTarget();
    camera.compute(1 / 60, target);
    camera.addTrauma(0.5);
    expect(camera.traumaLevel).toBeCloseTo(0.5, 9);

    let previous = camera.traumaLevel;
    for (let i = 0; i < 20; i += 1) {
      camera.compute(1 / 60, target);
      expect(camera.traumaLevel).toBeLessThanOrEqual(previous);
      previous = camera.traumaLevel;
    }
    runFrames(camera, target, 40);
    expect(camera.traumaLevel).toBe(0);
  });

  it('target.shake 也能驱动抖动（与系统冲量取较大值）', () => {
    const camera = system();
    const calm = camera.compute(1 / 60, makeTarget({ shake: 0 }));
    expect(calm.roll).toBe(0);
    const shaken = camera.compute(1 / 60, makeTarget({ shake: 0.8 }));
    expect(shaken.roll).not.toBe(0);
    expect(camera.debugState().trauma).toBe(0);

    const back = camera.compute(1 / 60, makeTarget({ shake: 0 }));
    expect(back.roll).toBe(0);
  });

  it('trauma 有上限，抖动扰动朝向但稳态无偏移', () => {
    const camera = system();
    const target = makeTarget();
    camera.compute(1 / 60, target);
    camera.addTrauma(5);
    expect(camera.traumaLevel).toBe(1);

    const jittered = camera.compute(1 / 60, target);
    expect(jittered.roll).not.toBe(0);
    expect(Math.abs(jittered.roll)).toBeLessThanOrEqual(0.045 + 1e-12);

    const settled = runFrames(camera, target, 120);
    expect(settled.roll).toBe(0);
    expect(settled.pitch).toBeCloseTo(0, 6);
    expect(settled.position.x).toBeCloseTo(0, 6);
  });
});

describe('FOV 过渡与后坐力', () => {
  it('FOV 平滑过渡：单帧只走一小步，最终贴合目标', () => {
    const camera = system();
    const target = makeTarget({ fov: 74 });
    camera.compute(1 / 60, target);

    target.fov = 90;
    const step1 = camera.compute(1 / 60, target);
    expect(step1.fov).toBeGreaterThan(74);
    expect(step1.fov).toBeLessThan(85);

    const converged = runFrames(camera, target, 180);
    expect(converged.fov).toBeCloseTo(90, 3);
  });

  it('FOV 被夹到合法区间', () => {
    const camera = system();
    const pose = runFrames(camera, makeTarget({ fov: 500 }), 240);
    expect(pose.fov).toBeCloseTo(140, 3);
  });

  it('后坐力叠加到朝向并随时间衰减回 0', () => {
    const camera = system();
    const target = makeTarget({ pitch: 0 });
    camera.compute(1 / 60, target);

    camera.addRecoil(0.05, 0.01);
    const kicked = camera.compute(1 / 60, target);
    expect(kicked.pitch).toBeGreaterThan(0);
    expect(kicked.pitch).toBeLessThanOrEqual(0.05);
    expect(kicked.yaw).toBeGreaterThan(0);

    // 冲量本身也在衰减，因此峰值很快出现并单调回落
    let peak = kicked.pitch;
    for (let i = 0; i < 20; i += 1) {
      peak = Math.max(peak, camera.compute(1 / 60, target).pitch);
    }
    expect(peak).toBeLessThanOrEqual(0.05);
    expect(peak).toBeGreaterThan(kicked.pitch);

    const settled = runFrames(camera, target, 120);
    expect(settled.pitch).toBeCloseTo(0, 4);
    expect(settled.yaw).toBeCloseTo(0, 4);
  });

  it('target.recoil 直接并入第一人称朝向', () => {
    const camera = system();
    const target = makeTarget({ pitch: 0.1, recoil: { pitch: 0.02, yaw: -0.01 } });
    const pose = camera.compute(1 / 60, target);
    expect(pose.pitch).toBeCloseTo(0.12, 6);
    expect(pose.yaw).toBeCloseTo(-0.01, 6);

    // 第三人称不叠加瞄准后坐力，保持跟随视角稳定
    camera.setMode('thirdPersonDebug');
    const third = camera.compute(1 / 60, makeTarget({ pitch: 0.1, recoil: { pitch: 0.02, yaw: -0.01 } }));
    expect(third.pitch).toBeCloseTo(0.1, 6);
    expect(third.yaw).toBeCloseTo(0, 6);
  });
});

describe('观战目标选择与失效回退', () => {
  const a = candidate('a', { x: 1, y: 1.6, z: 0 });
  const b = candidate('b', { x: 2, y: 1.6, z: 0 });

  it('跟随首选目标', () => {
    const camera = system({ mode: 'spectate' });
    const pose = camera.compute(1 / 60, makeTarget({ spectate: { candidates: [a, b], preferredId: 'b' } }));
    expect(pose.position).toEqual({ x: 2, y: 1.6, z: 0 });
    expect(camera.spectateId).toBe('b');
  });

  it('首选目标死亡时自动切到存活队友', () => {
    const camera = system({ mode: 'spectate' });
    const died = candidate('a', { x: 1, y: 1.6, z: 0 }, { alive: false });
    const pose = camera.compute(1 / 60, makeTarget({ spectate: { candidates: [died, b], preferredId: 'a' } }));
    expect(pose.position).toEqual({ x: 2, y: 1.6, z: 0 });
    expect(camera.spectateId).toBe('b');
  });

  it('没有可用队友时回退到死亡位置（target.eye）', () => {
    const camera = system({ mode: 'spectate' });
    const dead = candidate('a', { x: 1, y: 1.6, z: 0 }, { alive: false });
    const target = makeTarget({
      eye: { x: -3, y: 0.6, z: 5 },
      yaw: 1.2,
      pitch: 0.1,
      alive: false,
      spectate: { candidates: [dead], preferredId: 'a' },
    });
    const pose = camera.compute(1 / 60, target);
    expect(pose.position).toEqual({ x: -3, y: 0.6, z: 5 });
    expect(pose.yaw).toBeCloseTo(1.2, 9);
    expect(camera.spectateId).toBeNull();
  });

  it('观战切换目标时吸附而不是飞过去（远距离跨图）', () => {
    const camera = system({ mode: 'spectate' });
    const far = candidate('far', { x: 26, y: 1.6, z: -14 });
    camera.compute(1 / 60, makeTarget({ spectate: { candidates: [a, far], preferredId: 'a' } }));
    const switched = camera.compute(
      1 / 60,
      makeTarget({ spectate: { candidates: [a, far], preferredId: 'far' } }),
    );
    expect(switched.position).toEqual({ x: 26, y: 1.6, z: -14 });
  });
});

describe('遮挡回退', () => {
  it('第三人称相机不穿墙：距离被射线限制在命中点之前', () => {
    const camera = system({ mode: 'thirdPersonDebug' });
    camera.setOccluders([box(-2, 0, 1, 2, 3, 1.2)]);
    const pose = camera.compute(1 / 60, makeTarget({ yaw: 0, pitch: 0 }));
    expect(pose.position.z).toBeLessThan(1);
    expect(pose.distance).toBeLessThan(3.2);
    // 命中点 z=1 减去默认 margin(0.22)，沿单位方向缩放
    expect(pose.distance).toBeCloseTo((1 - 0.22) * (3.247 / 3.2), 2);
  });

  it('没有遮挡时保持完整体验距离', () => {
    const camera = system({ mode: 'thirdPersonDebug' });
    camera.setOccluders([box(-2, 0, -6, 2, 3, -5)]);
    const pose = camera.compute(1 / 60, makeTarget({ yaw: 0, pitch: 0 }));
    expect(pose.position.z).toBeCloseTo(3.2, 9);
  });

  it('第一人称不做遮挡回退（视点本来就在头部）', () => {
    const camera = system();
    camera.setOccluders([box(-2, 0, -2, 2, 3, 2)]);
    const pose = camera.compute(1 / 60, makeTarget());
    expect(pose.position).toEqual({ x: 0, y: 1.62, z: 0 });
    expect(pose.distance).toBe(0);
  });
});

describe('applyCameraPose', () => {
  it('写入位置、四元数与 FOV，并在 FOV 变化时更新投影矩阵', () => {
    const camera = system();
    const pose = camera.compute(1 / 60, makeTarget({ fov: 90, yaw: 0.3, pitch: -0.2 }));
    const written = {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      fov: 74,
      updates: 0,
    };
    const fake: CameraLike = {
      position: {
        set(x: number, y: number, z: number) {
          written.position = { x, y, z };
        },
      },
      quaternion: {
        set(x: number, y: number, z: number, w: number) {
          written.quaternion = { x, y, z, w };
        },
      },
      get fov() {
        return written.fov;
      },
      set fov(value: number) {
        written.fov = value;
      },
      updateProjectionMatrix() {
        written.updates += 1;
      },
    };

    applyCameraPose(fake, pose);
    expect(written.position.x).toBe(pose.position.x);
    expect(written.position.z).toBe(pose.position.z);
    expect(written.quaternion.x).toBe(pose.quaternion.x);
    expect(written.quaternion.w).toBe(pose.quaternion.w);
    expect(written.fov).toBe(pose.fov);
    expect(written.updates).toBe(1);

    const sameFovPose = { ...pose, fov: written.fov };
    applyCameraPose(fake, sameFovPose);
    expect(written.updates).toBe(1);
  });
});

describe('确定性', () => {
  it('相同输入序列产生完全相同的姿态', () => {
    const target = makeTarget({ yaw: 0.4, pitch: -0.1 });
    const first = runFrames(system(), target, 30);
    const second = runFrames(system(), target, 30);
    expect(second.position).toEqual(first.position);
    expect(second.quaternion).toEqual(first.quaternion);
    expect(second.fov).toBe(first.fov);
  });

  it('reset 后重新初始化到目标姿态', () => {
    const camera = system({ mode: 'thirdPersonDebug' });
    const target = makeTarget({ eye: { x: 12, y: 1.62, z: -4 } });
    camera.compute(1 / 60, target);
    camera.addTrauma(1);
    camera.addRecoil(0.1);
    camera.reset();
    expect(camera.traumaLevel).toBe(0);
    expect(camera.debugState().recoilPitch).toBe(0);
    const pose = camera.compute(1 / 60, target);
    expect(pose.position.z).toBeCloseTo(-4 + 3.2, 9);
    expect(pose.position.x).toBeCloseTo(12, 9);
  });
});
