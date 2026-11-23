import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import type { QualityPreset } from './quality';

/**
 * 后处理链。顺序（高档）：
 *   RenderPass → GTAO → Bloom → SMAA（线性空间） → OutputPass(ACES + sRGB) → 暗角/色彩分级
 * 中档把 GTAO 换成更便宜的 SSAO、SMAA 换成 FXAA；低档整条链不创建，直接 renderer.render。
 */

const GradeShader = {
  name: 'DustGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignetteStrength: { value: 0.85 },
    vignetteStart: { value: 0.55 },
    contrast: { value: 1.05 },
    saturation: { value: 1.06 },
    lift: { value: new THREE.Vector3(0.0, 0.004, 0.01) },
    tint: { value: new THREE.Vector3(1.015, 1.0, 0.985) },
    grain: { value: 0.028 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignetteStrength;
    uniform float vignetteStart;
    uniform float contrast;
    uniform float saturation;
    uniform vec3 lift;
    uniform vec3 tint;
    uniform float grain;
    uniform float time;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(41.13, 289.7)) + time) * 43758.5453);
    }

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;

      // 色彩分级：对比、饱和、暖色偏移、轻微抬黑（胶片感）
      color = (color - 0.5) * contrast + 0.5;
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, saturation);
      color *= tint;
      color += lift;

      // 暗角
      vec2 centered = vUv - 0.5;
      float dist = length(centered) * 1.4142;
      float vignette = smoothstep(vignetteStart, 1.05, dist);
      color *= 1.0 - vignette * vignetteStrength;

      // 极轻颗粒，避免大面积平坦墙面出现色带
      color += (hash(vUv * 1024.0) - 0.5) * grain;

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

export class PostPipeline {
  readonly composer: EffectComposer;
  private readonly passNames: string[] = [];
  private readonly gradePass: ShaderPass | null;
  private time = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    preset: QualityPreset,
    width: number,
    height: number,
    pixelRatio: number,
  ) {
    this.composer = new EffectComposer(renderer);

    this.composer.addPass(new RenderPass(scene, camera));
    this.passNames.push('render');

    if (preset.ao === 'gtao') {
      const gtao = new GTAOPass(scene, camera, width, height);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({
        radius: 0.9,
        distanceExponent: 1.2,
        thickness: 1.2,
        distanceFallOff: 1,
        scale: 1,
        samples: 16,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      this.composer.addPass(gtao);
      this.passNames.push('gtao');
    } else if (preset.ao === 'ssao') {
      const ssao = new SSAOPass(scene, camera, width, height, 24);
      ssao.kernelRadius = 0.8;
      ssao.minDistance = 0.002;
      ssao.maxDistance = 0.2;
      this.composer.addPass(ssao);
      this.passNames.push('ssao');
    }

    // SMAA 必须在线性空间执行（OutputPass 之前）。
    if (preset.antiAliasing === 'smaa') {
      this.composer.addPass(new SMAAPass());
      this.passNames.push('smaa');
    }

    // OutputPass 负责 ACES 色调映射与 sRGB 输出；其后的 pass 在 sRGB 空间工作。
    this.composer.addPass(new OutputPass());
    this.passNames.push('output');

    // Bloom 放在 OutputPass 之后：在 LDR 上做高光溢出，避免 HDR 天空把整幅画面洗白。
    if (preset.bloom) {
      this.composer.addPass(
        new UnrealBloomPass(
          new THREE.Vector2(width, height),
          preset.bloomStrength,
          preset.bloomRadius,
          preset.bloomThreshold,
        ),
      );
      this.passNames.push('bloom');
    }

    // FXAA 需要 sRGB 输入，放在 OutputPass 之后。
    if (preset.antiAliasing === 'fxaa') {
      this.composer.addPass(new FXAAPass());
      this.passNames.push('fxaa');
    }

    if (preset.grading) {
      const gradePass = new ShaderPass(GradeShader);
      this.gradePass = gradePass;
      this.composer.addPass(gradePass);
      this.passNames.push('grade');
    } else {
      this.gradePass = null;
    }

    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(dt: number): void {
    this.time += dt;
    if (this.gradePass) {
      this.gradePass.uniforms['time'].value = this.time;
    }
    this.composer.render(dt);
  }

  dispose(): void {
    for (const pass of this.composer.passes) {
      pass.dispose();
      // three r187 的 SSAOPass.dispose() 没有释放自己生成的噪声贴图（DataTexture），
      // 反复切档会把一张张贴图留在 GPU 里，这里补上。
      const noise = (pass as unknown as { noiseTexture?: THREE.Texture }).noiseTexture;
      noise?.dispose();
    }
    this.composer.dispose();
  }

  /** 供调试/交付报告使用：实际挂载的效果名。 */
  describe(): string[] {
    return [...this.passNames];
  }
}
