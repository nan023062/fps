export interface InputSnapshot {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
  fire: boolean;
  scoreboard: boolean;
  reloadRequest: boolean;
  switchRequest: 'rifle' | 'pistol' | null;
  mouseDX: number;
  mouseDY: number;
  pointerLocked: boolean;
}

export class InputManager {
  private readonly keys = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private fireDown = false;
  private reloadRequest = false;
  private switchRequest: 'rifle' | 'pistol' | null = null;

  constructor(
    private readonly canvas: HTMLElement,
    private readonly onLockChange: (locked: boolean) => void,
  ) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestLock(): void {
    if (this.locked) return;
    const result = this.canvas.requestPointerLock() as unknown as Promise<void> | void;
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        this.onLockChange(this.locked);
      });
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  snapshot(): InputSnapshot {
    const snap: InputSnapshot = {
      forward: this.keys.has('KeyW'),
      back: this.keys.has('KeyS'),
      left: this.keys.has('KeyA'),
      right: this.keys.has('KeyD'),
      jump: this.keys.has('Space'),
      crouch: this.keys.has('ControlLeft') || this.keys.has('KeyC'),
      walk: this.keys.has('ShiftLeft'),
      fire: this.fireDown && this.locked,
      scoreboard: this.keys.has('Tab'),
      reloadRequest: this.reloadRequest,
      switchRequest: this.switchRequest,
      mouseDX: this.mouseDX,
      mouseDY: this.mouseDY,
      pointerLocked: this.locked,
    };
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.reloadRequest = false;
    this.switchRequest = null;
    return snap;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.locked && (event.code === 'Tab' || event.code === 'Space')) {
      event.preventDefault();
    }
    if (event.code === 'KeyR' && !event.repeat) {
      this.reloadRequest = true;
    }
    if (event.code === 'Digit1' && !event.repeat) {
      this.switchRequest = 'rifle';
    }
    if (event.code === 'Digit2' && !event.repeat) {
      this.switchRequest = 'pistol';
    }
    this.keys.add(event.code);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly handleBlur = (): void => {
    this.keys.clear();
    this.fireDown = false;
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button === 0 && this.locked) {
      this.fireDown = true;
    }
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) {
      this.fireDown = false;
    }
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDX += event.movementX;
    this.mouseDY += event.movementY;
  };

  private readonly handlePointerLockChange = (): void => {
    if (!this.locked) {
      this.fireDown = false;
      this.keys.clear();
    }
    this.onLockChange(this.locked);
  };

  private readonly handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };
}
