/**
 * 设置面板（DOM 表现层，只与纯逻辑 settings.ts 交互）。
 *
 * 约定：
 * - 节点只创建一次；sync() 只在值变化时写 DOM，不每帧重建。
 * - 原生 range/checkbox/button 提供鼠标与键盘（Tab/方向键/Enter/Space）操作；
 *   面板额外处理 Esc 关闭与 Tab 循环，关闭后把焦点还给打开它的按钮。
 * - 面板只上报改动（onChange），由 main.ts 决定如何生效与持久化，
 *   这里不直接读写 localStorage，也不碰音频/相机实现。
 */
import { DEFAULT_SETTINGS, settingsEqual, type GameSettings, type SettingsPatch } from './settings';

type SliderField = 'master' | 'sfx' | 'ambience' | 'sensitivity' | 'fov';

interface SliderSpec {
  field: SliderField;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}

/** 三个音量 + 灵敏度 + FOV：顺序即 Tab 顺序，也是界面自上而下的顺序。 */
const SLIDERS: readonly SliderSpec[] = [
  {
    field: 'master',
    label: '主音量',
    hint: '全部声音的总增益，0 表示完全静音',
    min: 0,
    max: 100,
    step: 1,
    format: (value) => `${Math.round(value)}`,
  },
  {
    field: 'sfx',
    label: '音效音量',
    hint: '枪声与脚步声（Weapons + Footsteps 合并）',
    min: 0,
    max: 100,
    step: 1,
    format: (value) => `${Math.round(value)}`,
  },
  {
    field: 'ambience',
    label: '环境音量',
    hint: '环境底噪与环境提示音',
    min: 0,
    max: 100,
    step: 1,
    format: (value) => `${Math.round(value)}`,
  },
  {
    field: 'sensitivity',
    label: '鼠标灵敏度',
    hint: '0.30× – 2.00×，1.00× 为默认手感',
    min: 0.3,
    max: 2,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
  {
    field: 'fov',
    label: '视野 FOV',
    hint: '70° – 110°，默认 74°',
    min: 70,
    max: 110,
    step: 1,
    format: (value) => `${Math.round(value)}°`,
  },
];

export class SettingsPanel {
  private readonly root: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private readonly inputs = new Map<SliderField, HTMLInputElement>();
  private readonly readouts = new Map<SliderField, HTMLSpanElement>();
  private readonly shakeInput: HTMLInputElement;
  private readonly shakeReadout: HTMLSpanElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  private rendered: GameSettings | null = null;
  private changeHandler: ((patch: SettingsPatch) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private returnFocus: HTMLElement | null = null;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'overlay overlay--settings';
    this.root.dataset.role = 'settings-overlay';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `
      <div class="overlay__panel settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="menu__tag">SETTINGS</div>
        <h2 class="settings__title" id="settings-title">设置</h2>
        <p class="settings__intro">改动立即生效并保存在本机，与画质档互不影响。</p>
        <div class="settings__list" role="group" aria-label="音量与视角设置"></div>
        <div class="settings__actions">
          <button type="button" class="button" data-action="reset-settings">恢复默认</button>
          <button type="button" class="button button--primary" data-action="close-settings">返回</button>
        </div>
        <p class="settings__footnote">Esc 关闭 · 方向键调整数值 · Tab 切换项目</p>
      </div>
    `;
    parent.appendChild(this.root);

    this.dialog = this.root.querySelector('.settings') as HTMLDivElement;
    this.dialog.tabIndex = -1;
    const list = this.root.querySelector('.settings__list') as HTMLDivElement;
    for (const spec of SLIDERS) this.buildSlider(list, spec);
    this.buildShakeToggle(list);

    this.shakeInput = this.root.querySelector('#setting-cameraShake') as HTMLInputElement;
    this.shakeReadout = this.root.querySelector('[data-role="value-cameraShake"]') as HTMLSpanElement;
    this.resetButton = this.root.querySelector('[data-action="reset-settings"]') as HTMLButtonElement;
    this.closeButton = this.root.querySelector('[data-action="close-settings"]') as HTMLButtonElement;

    this.shakeInput.addEventListener('change', () => {
      this.changeHandler?.({ cameraShake: this.shakeInput.checked });
    });
    this.resetButton.addEventListener('click', () => {
      this.changeHandler?.({ ...DEFAULT_SETTINGS });
    });
    this.closeButton.addEventListener('click', () => this.requestClose());
    this.root.addEventListener('keydown', this.handleKeyDown);
  }

  onChange(handler: (patch: SettingsPatch) => void): void {
    this.changeHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  get isOpen(): boolean {
    return this.visible;
  }

  /** 按值差异更新控件；值相同则完全不写 DOM（滑块拖动时不会抖动）。 */
  sync(settings: GameSettings): void {
    if (this.rendered && settingsEqual(this.rendered, settings)) return;
    this.rendered = { ...settings };

    for (const spec of SLIDERS) {
      const value = settings[spec.field];
      const input = this.inputs.get(spec.field);
      const readout = this.readouts.get(spec.field);
      const text = String(value);
      if (input) {
        if (input.value !== text) input.value = text;
        const valueText = spec.format(value);
        if (input.getAttribute('aria-valuetext') !== valueText) {
          input.setAttribute('aria-valuetext', valueText);
        }
      }
      if (readout) {
        const label = spec.format(value);
        if (readout.textContent !== label) readout.textContent = label;
      }
    }

    if (this.shakeInput.checked !== settings.cameraShake) {
      this.shakeInput.checked = settings.cameraShake;
    }
    const shakeText = settings.cameraShake ? '开' : '关';
    if (this.shakeReadout.textContent !== shakeText) this.shakeReadout.textContent = shakeText;
  }

  /** 打开面板并把焦点移入；opener 用于关闭后把焦点还回去。 */
  show(opener: HTMLElement | null = null): void {
    if (this.visible) return;
    this.returnFocus =
      opener ??
      (document.activeElement instanceof HTMLElement ? (document.activeElement as HTMLElement) : null);
    this.visible = true;
    this.root.classList.add('is-visible');
    this.root.setAttribute('aria-hidden', 'false');
    const first = this.focusable()[0] ?? this.dialog;
    first.focus({ preventScroll: true });
  }

  /** 关闭面板并恢复焦点；没有打开时是空操作。 */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.remove('is-visible');
    this.root.setAttribute('aria-hidden', 'true');
    const target = this.returnFocus;
    this.returnFocus = null;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  }

  private requestClose(): void {
    this.hide();
    this.closeHandler?.();
  }

  private buildSlider(list: HTMLDivElement, spec: SliderSpec): void {
    const row = document.createElement('div');
    row.className = 'setting';
    row.dataset.setting = spec.field;

    const label = document.createElement('label');
    label.className = 'setting__head';
    label.htmlFor = `setting-${spec.field}`;
    label.innerHTML = `<span class="setting__label">${spec.label}</span><span class="setting__value" data-role="value-${spec.field}"></span>`;

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'setting__slider';
    input.id = `setting-${spec.field}`;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(DEFAULT_SETTINGS[spec.field]);
    input.setAttribute('aria-valuetext', spec.format(DEFAULT_SETTINGS[spec.field]));
    input.setAttribute('aria-describedby', `setting-${spec.field}-hint`);
    input.addEventListener('input', () => {
      this.changeHandler?.({ [spec.field]: Number(input.value) } as SettingsPatch);
    });

    const hint = document.createElement('p');
    hint.className = 'setting__hint';
    hint.id = `setting-${spec.field}-hint`;
    hint.textContent = spec.hint;

    row.append(label, input, hint);
    list.appendChild(row);
    this.inputs.set(spec.field, input);
    this.readouts.set(
      spec.field,
      label.querySelector(`[data-role="value-${spec.field}"]`) as HTMLSpanElement,
    );
  }

  private buildShakeToggle(list: HTMLDivElement): void {
    const row = document.createElement('div');
    row.className = 'setting setting--toggle';
    row.dataset.setting = 'cameraShake';
    row.innerHTML = `
      <label class="setting__head" for="setting-cameraShake">
        <span class="setting__label">相机震动</span>
        <span class="setting__value" data-role="value-cameraShake"></span>
      </label>
      <input type="checkbox" class="setting__checkbox" id="setting-cameraShake" checked aria-describedby="setting-cameraShake-hint">
      <p class="setting__hint" id="setting-cameraShake-hint">开火后坐力与死亡冲击的镜头晃动；关闭后仍会保留视角朝向</p>
    `;
    list.appendChild(row);
  }

  private focusable(): HTMLElement[] {
    return [...this.dialog.querySelectorAll<HTMLElement>('input, button')].filter(
      (element) => !element.hasAttribute('disabled') && element.tabIndex !== -1,
    );
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.visible) return;
    if (event.key === 'Escape') {
      // 面板在最上层：Esc 先关面板，不再穿透到画质/相机/暂停的窗口级快捷键。
      event.preventDefault();
      event.stopPropagation();
      this.requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = this.focusable();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = active !== null && this.dialog.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };
}
