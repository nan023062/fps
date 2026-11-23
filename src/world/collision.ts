import { normalize, rayAabb, sub, length, type Aabb, type Vec3 } from '../core/math';

export interface RayHit {
  distance: number;
  point: Vec3;
  box: Aabb;
}

export interface MoveResult {
  position: Vec3;
  grounded: boolean;
  blocked: boolean;
}

const EPS = 1e-4;

export class WorldCollider {
  constructor(public readonly boxes: Aabb[]) {}

  raycast(origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
    let best: RayHit | null = null;
    for (const box of this.boxes) {
      const t = rayAabb(origin, dir, box, maxDist);
      if (t !== null && (best === null || t < best.distance)) {
        best = {
          distance: t,
          point: {
            x: origin.x + dir.x * t,
            y: origin.y + dir.y * t,
            z: origin.z + dir.z * t,
          },
          box,
        };
      }
    }
    return best;
  }

  lineOfSight(from: Vec3, to: Vec3): boolean {
    const delta = sub(to, from);
    const dist = length(delta);
    if (dist < 1e-6) return true;
    const hit = this.raycast(from, normalize(delta), dist);
    return hit === null || hit.distance >= dist - 0.05;
  }

  isFree(position: Vec3, radius: number, height: number): boolean {
    return !this.collides(position, radius, height);
  }

  move(position: Vec3, radius: number, height: number, delta: Vec3, stepHeight = 0.45): MoveResult {
    let x = position.x;
    let y = position.y;
    let z = position.z;
    let blocked = false;

    const wasGrounded = this.isGrounded({ x, y, z }, radius);

    const moveAxis = (axis: 'x' | 'z', amount: number): void => {
      if (amount === 0) return;
      const nx = axis === 'x' ? x + amount : x;
      const nz = axis === 'z' ? z + amount : z;
      if (!this.collides({ x: nx, y, z: nz }, radius, height)) {
        x = nx;
        z = nz;
        return;
      }
      if (wasGrounded) {
        const steppedY = y + stepHeight;
        const stepped = { x: nx, y: steppedY, z: nz };
        if (!this.collides(stepped, radius, height) && this.groundBelow(stepped, radius) >= y - 0.01) {
          x = nx;
          z = nz;
          y = steppedY;
          return;
        }
      }
      blocked = true;
    };

    moveAxis('x', delta.x);
    moveAxis('z', delta.z);

    let grounded = false;
    if (delta.y > 0) {
      const ny = y + delta.y;
      if (this.collides({ x, y: ny, z }, radius, height)) {
        blocked = true;
      } else {
        y = ny;
      }
    } else if (delta.y < 0) {
      const floor = this.groundBelow({ x, y, z }, radius);
      const ny = y + delta.y;
      if (ny <= floor) {
        y = floor;
        grounded = true;
      } else {
        y = ny;
      }
    }

    const floor = this.groundBelow({ x, y, z }, radius);
    if (y <= floor + 1e-3) {
      if (y < floor) y = floor;
      grounded = true;
    }

    return { position: { x, y, z }, grounded, blocked };
  }

  private isGrounded(position: Vec3, radius: number): boolean {
    return position.y <= this.groundBelow(position, radius) + 1e-3;
  }

  /** Highest surface at or below the given feet position, considering only XZ overlap. */
  private groundBelow(position: Vec3, radius: number): number {
    let floor = 0;
    for (const box of this.boxes) {
      if (this.overlapsXZ(position, radius, box) && box.max.y <= position.y + 0.02 && box.max.y > floor) {
        floor = box.max.y;
      }
    }
    return floor;
  }

  private overlapsXZ(position: Vec3, radius: number, box: Aabb): boolean {
    return (
      position.x + radius > box.min.x + EPS &&
      position.x - radius < box.max.x - EPS &&
      position.z + radius > box.min.z + EPS &&
      position.z - radius < box.max.z - EPS
    );
  }

  private collides(position: Vec3, radius: number, height: number): boolean {
    for (const box of this.boxes) {
      if (
        position.x + radius > box.min.x + EPS &&
        position.x - radius < box.max.x - EPS &&
        position.z + radius > box.min.z + EPS &&
        position.z - radius < box.max.z - EPS &&
        position.y + height > box.min.y + EPS &&
        position.y < box.max.y - EPS
      ) {
        return true;
      }
    }
    return false;
  }
}
