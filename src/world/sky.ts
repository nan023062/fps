import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { LevelLighting } from './level';

export interface SkySystem {
  sky: Sky;
  environment: THREE.Texture | null;
  sunDirection: THREE.Vector3;
  update(dt: number): void;
  dispose(): void;
}

const DEG = Math.PI / 180;

export function sunDirectionFrom(lighting: LevelLighting): THREE.Vector3 {
  const phi = (90 - lighting.sun.elevation) * DEG;
  const theta = lighting.sun.azimuth * DEG;
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

/** 用 onBeforeCompile 给 Sky 的 HDR 输出加一个亮度系数，让天空亮度与场景曝光匹配。 */
function applySkyIntensity(sky: Sky, intensity: number): void {
  const dim = Math.max(0.02, intensity);
  sky.material.onBeforeCompile = (shader) => {
    shader.uniforms['skyIntensity'] = { value: dim };
    shader.fragmentShader =
      'uniform float skyIntensity;\n' +
      shader.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        'gl_FragColor.rgb *= skyIntensity;\n#include <tonemapping_fragment>',
      );
  };
  sky.material.customProgramCacheKey = () => `sky-dim-${dim.toFixed(3)}`;
  sky.material.needsUpdate = true;
}

function applyUniforms(sky: Sky, lighting: LevelLighting, sunDirection: THREE.Vector3): void {
  const uniforms = sky.material.uniforms;
  uniforms['turbidity'].value = lighting.sky.turbidity;
  uniforms['rayleigh'].value = lighting.sky.rayleigh;
  uniforms['mieCoefficient'].value = lighting.sky.mieCoefficient;
  uniforms['mieDirectionalG'].value = lighting.sky.mieDirectionalG;
  uniforms['sunPosition'].value.copy(sunDirection);
  if (lighting.sky.cloudCoverage !== undefined) {
    uniforms['cloudCoverage'].value = lighting.sky.cloudCoverage;
  }
  if (lighting.sky.cloudDensity !== undefined) {
    uniforms['cloudDensity'].value = lighting.sky.cloudDensity;
  }
  if (lighting.sky.cloudElevation !== undefined) {
    uniforms['cloudElevation'].value = lighting.sky.cloudElevation;
  }
  uniforms['time'].value = 0;
}

/**
 * 程序化天空（Preetham 大气散射）+ PMREM 环境贴图。
 * 环境贴图由同一片天空实时烘焙，因此 PBR 材质的高光与反射与天空一致，且不需要 HDR 资源。
 */
export function createSkySystem(renderer: THREE.WebGLRenderer, lighting: LevelLighting): SkySystem {
  const sunDirection = sunDirectionFrom(lighting);

  const sky = new Sky();
  sky.scale.setScalar(4500);
  sky.frustumCulled = false;
  sky.material.depthWrite = false;
  applyUniforms(sky, lighting, sunDirection);
  applySkyIntensity(sky, lighting.sky.skyIntensity ?? 0.3);

  let environment: THREE.Texture | null = null;
  let envTarget: THREE.WebGLRenderTarget | null = null;
  try {
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(60);
    envSky.frustumCulled = false;
    applyUniforms(envSky, lighting, sunDirection);
    applySkyIntensity(envSky, lighting.sky.skyIntensity ?? 0.3);
    envSky.material.uniforms['showSunDisc'].value = 0;
    envScene.add(envSky);

    const pmrem = new THREE.PMREMGenerator(renderer);
    envTarget = pmrem.fromScene(envScene, 0.02, 0.1, 600);
    environment = envTarget.texture;
    pmrem.dispose();
    envSky.geometry.dispose();
    envSky.material.dispose();
  } catch (error) {
    console.warn('程序化环境贴图生成失败，回退到半球光照', error);
  }

  let elapsed = 0;
  return {
    sky,
    environment,
    sunDirection,
    update(dt: number) {
      elapsed += dt;
      sky.material.uniforms['time'].value = elapsed * 24;
    },
    dispose() {
      envTarget?.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
    },
  };
}
