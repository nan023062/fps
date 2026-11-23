import * as THREE from 'three';

interface Tracer {
  line: THREE.Line;
  life: number;
  max: number;
}

interface Burst {
  points: THREE.Points;
  velocities: THREE.Vector3[];
  life: number;
  max: number;
}

export class Effects {
  private readonly tracers: Tracer[] = [];
  private readonly bursts: Burst[] = [];
  private readonly flash: THREE.PointLight;
  private flashLife = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.flash = new THREE.PointLight(0xffd28a, 0, 9, 2);
    this.scene.add(this.flash);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const material = new THREE.LineBasicMaterial({
      color: 0xffe2a8,
      transparent: true,
      opacity: 0.85,
    });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.06, max: 0.06 });
  }

  impact(point: THREE.Vector3): void {
    const count = 10;
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;
      velocities.push(
        new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(
          2.2,
        ),
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xd9c39a,
      size: 0.09,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    this.bursts.push({ points, velocities, life: 0.45, max: 0.45 });
  }

  muzzle(point: THREE.Vector3): void {
    this.flash.position.copy(point);
    this.flash.intensity = 9;
    this.flashLife = 0.05;
  }

  update(dt: number): void {
    this.flashLife -= dt;
    if (this.flashLife <= 0) {
      this.flash.intensity = 0;
    }

    for (let i = this.tracers.length - 1; i >= 0; i -= 1) {
      const tracer = this.tracers[i];
      tracer.life -= dt;
      const material = tracer.line.material as THREE.LineBasicMaterial;
      material.opacity = Math.max(0, tracer.life / tracer.max) * 0.85;
      if (tracer.life <= 0) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        material.dispose();
        this.tracers.splice(i, 1);
      }
    }

    for (let i = this.bursts.length - 1; i >= 0; i -= 1) {
      const burst = this.bursts[i];
      burst.life -= dt;
      const attribute = burst.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let p = 0; p < burst.velocities.length; p += 1) {
        const velocity = burst.velocities[p];
        const x = attribute.getX(p) + velocity.x * dt;
        const y = attribute.getY(p) + velocity.y * dt;
        const z = attribute.getZ(p) + velocity.z * dt;
        velocity.y -= 6 * dt;
        attribute.setXYZ(p, x, y, z);
      }
      attribute.needsUpdate = true;
      const material = burst.points.material as THREE.PointsMaterial;
      material.opacity = Math.max(0, burst.life / burst.max);
      if (burst.life <= 0) {
        this.scene.remove(burst.points);
        burst.points.geometry.dispose();
        material.dispose();
        this.bursts.splice(i, 1);
      }
    }
  }
}
