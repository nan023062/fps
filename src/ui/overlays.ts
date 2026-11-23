import type { Team } from '../game/types';
import { QUALITY_PRESETS, type QualityLevel } from '../world/quality';
import { SettingsPanel } from './settings-panel';
import type { GameSettings, SettingsPatch } from './settings';

/** 画质档展示顺序：低 → 中 → 高，标签直接取自 QUALITY_PRESETS。 */
const QUALITY_ORDER: QualityLevel[] = ['low', 'medium', 'high'];

/** 与 QUALITY_PRESETS 各档实际差异对应的简短中文说明。 */
const QUALITY_HINTS: Record<QualityLevel, string> = {
  low: '最流畅 · 关闭后处理与抗锯齿',
  medium: '平衡 · SSAO 环境光遮蔽 + SMAA',
  high: '最细腻 · GTAO + 软阴影 + 泛光',
};

export class Overlays {
  private readonly menu: HTMLDivElement;
  private readonly pause: HTMLDivElement;
  private readonly result: HTMLDivElement;
  private readonly resultTitle: HTMLDivElement;
  private readonly resultScore: HTMLDivElement;
  private readonly resultHint: HTMLDivElement;
  private readonly qualityGroup: HTMLDivElement;
  private readonly qualityNote: HTMLSpanElement;
  private readonly pauseQuality: HTMLParagraphElement;
  private readonly pauseSettings: HTMLParagraphElement;
  private readonly qualityButtons = new Map<QualityLevel, HTMLButtonElement>();
  /** 设置面板：菜单与暂停共用同一个实例，内部维护焦点返回。 */
  private readonly settingsPanel: SettingsPanel;
  private settingsSummary = '';

  private startHandler: (() => void) | null = null;
  private resumeHandler: (() => void) | null = null;
  private restartHandler: (() => void) | null = null;
  private qualityHandler: ((level: QualityLevel) => void) | null = null;
  private settingsHandler: ((patch: SettingsPatch) => void) | null = null;
  private qualityLevel: QualityLevel | null = null;
  private qualityNoteText = '';

  constructor(parent: HTMLElement) {
    this.menu = document.createElement('div');
    this.menu.className = 'overlay overlay--menu is-visible';
    this.menu.innerHTML = `
      <div class="overlay__panel menu">
        <div class="menu__tag">BROWSER TACTICAL FPS</div>
        <h1 class="menu__title">DUST<span>STRIKE</span></h1>
        <p class="menu__subtitle">原创低多边形沙漠竞技场 · 3v3 回合歼灭 · 先取 5 分者胜</p>
        <div class="menu__quality" data-role="quality">
          <div class="menu__quality-head">
            <span class="menu__quality-title">画质档</span>
            <span class="menu__quality-note" data-role="quality-note"></span>
          </div>
          <div class="quality-options" role="group" aria-label="画质档位" data-role="quality-options"></div>
        </div>
        <div class="menu__controls">
          <div><kbd>W A S D</kbd><span>移动</span></div>
          <div><kbd>鼠标</kbd><span>瞄准</span></div>
          <div><kbd>左键</kbd><span>射击</span></div>
          <div><kbd>R</kbd><span>换弹</span></div>
          <div><kbd>Space</kbd><span>跳跃</span></div>
          <div><kbd>Ctrl / C</kbd><span>下蹲</span></div>
          <div><kbd>Shift</kbd><span>静步</span></div>
          <div><kbd>1 / 2</kbd><span>切换武器</span></div>
          <div><kbd>Tab</kbd><span>计分板</span></div>
          <div><kbd>Esc</kbd><span>暂停</span></div>
        </div>
        <div class="menu__actions">
          <button class="button button--primary" data-action="start">开始对局</button>
          <button class="button" data-action="open-settings" aria-haspopup="dialog">设置</button>
        </div>
        <p class="menu__footnote">点击后将锁定鼠标。按 Esc 释放并暂停。</p>
      </div>
    `;
    parent.appendChild(this.menu);

    this.pause = document.createElement('div');
    this.pause.className = 'overlay overlay--pause';
    this.pause.innerHTML = `
      <div class="overlay__panel pause">
        <div class="menu__tag">PAUSED</div>
        <h2>已暂停</h2>
        <p>鼠标已释放，对局暂停。继续后重新锁定鼠标。</p>
        <p class="pause__quality" data-role="pause-quality"></p>
        <p class="pause__settings" data-role="pause-settings"></p>
        <div class="pause__actions">
          <button class="button button--primary" data-action="resume">继续对局</button>
          <button class="button" data-action="restart">重新开始</button>
          <button class="button" data-action="open-settings" aria-haspopup="dialog">设置</button>
        </div>
      </div>
    `;
    parent.appendChild(this.pause);

    this.result = document.createElement('div');
    this.result.className = 'overlay overlay--result';
    this.result.innerHTML = `
      <div class="overlay__panel result">
        <div class="menu__tag">MATCH COMPLETE</div>
        <div class="result__title" data-role="result-title"></div>
        <div class="result__score" data-role="result-score"></div>
        <div class="result__hint" data-role="result-hint"></div>
        <button class="button button--primary" data-action="restart">再战一局</button>
      </div>
    `;
    parent.appendChild(this.result);

    this.qualityGroup = this.menu.querySelector('[data-role="quality-options"]') as HTMLDivElement;
    this.qualityNote = this.menu.querySelector('[data-role="quality-note"]') as HTMLSpanElement;
    this.pauseQuality = this.pause.querySelector('[data-role="pause-quality"]') as HTMLParagraphElement;
    this.pauseSettings = this.pause.querySelector('[data-role="pause-settings"]') as HTMLParagraphElement;
    this.settingsPanel = new SettingsPanel(parent);
    this.settingsPanel.onChange((patch) => this.settingsHandler?.(patch));
    this.buildQualityOptions();
    this.resultTitle = this.result.querySelector('[data-role="result-title"]') as HTMLDivElement;
    this.resultScore = this.result.querySelector('[data-role="result-score"]') as HTMLDivElement;
    this.resultHint = this.result.querySelector('[data-role="result-hint"]') as HTMLDivElement;

    this.menu.querySelector('[data-action="start"]')?.addEventListener('click', () => {
      this.startHandler?.();
    });
    this.pause.querySelector('[data-action="resume"]')?.addEventListener('click', () => {
      this.resumeHandler?.();
    });
    this.pause.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
      this.restartHandler?.();
    });
    this.result.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
      this.restartHandler?.();
    });
    // 菜单与暂停各一个入口，共用一个面板；焦点由面板自己还给被点击的按钮。
    for (const trigger of [this.menu, this.pause]) {
      trigger.querySelector('[data-action="open-settings"]')?.addEventListener('click', (event) => {
        this.openSettings(event.currentTarget as HTMLElement);
      });
    }
  }

  onStart(handler: () => void): void {
    this.startHandler = handler;
  }

  onResume(handler: () => void): void {
    this.resumeHandler = handler;
  }

  onRestart(handler: () => void): void {
    this.restartHandler = handler;
  }

  onQualityChange(handler: (level: QualityLevel) => void): void {
    this.qualityHandler = handler;
  }

  onSettingsChange(handler: (patch: SettingsPatch) => void): void {
    this.settingsHandler = handler;
  }

  /** 面板只上报改动；生效与持久化由 main.ts 负责。 */
  openSettings(trigger: HTMLElement | null = null): void {
    this.settingsPanel.show(trigger);
  }

  closeSettings(): void {
    this.settingsPanel.hide();
  }

  get settingsOpen(): boolean {
    return this.settingsPanel.isOpen;
  }

  /** 面板控件与暂停面板摘要共用同一份设置快照，按值差异更新。 */
  setSettings(settings: GameSettings): void {
    this.settingsPanel.sync(settings);
    const summary = this.describeSettings(settings);
    if (summary !== this.settingsSummary) {
      this.settingsSummary = summary;
      this.pauseSettings.textContent = summary;
    }
  }

  private describeSettings(settings: GameSettings): string {
    const volume = (value: number) => String(Math.round(value));
    return [
      `音量 主 ${volume(settings.master)} / 音效 ${volume(settings.sfx)} / 环境 ${volume(settings.ambience)}`,
      `灵敏度 ${settings.sensitivity.toFixed(2)}×`,
      `FOV ${Math.round(settings.fov)}°`,
      `相机震动 ${settings.cameraShake ? '开' : '关'}`,
    ].join(' · ');
  }

  /**
   * 菜单里的三档画质按钮：标签取自 QUALITY_PRESETS，说明文字说明实际画质差异。
   * 按钮只创建一次，之后按值差异更新 aria-pressed 与选中样式。
   */
  private buildQualityOptions(): void {
    for (const level of QUALITY_ORDER) {
      const preset = QUALITY_PRESETS[level];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quality-option';
      button.dataset.quality = level;
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = `
        <span class="quality-option__label">${preset.label}</span>
        <span class="quality-option__hint">${QUALITY_HINTS[level]}</span>
      `;
      button.addEventListener('click', () => {
        this.qualityHandler?.(level);
      });
      this.qualityGroup.appendChild(button);
      this.qualityButtons.set(level, button);
    }

    // 键盘方向键在档位之间移动并立即生效，满足纯键盘操作。
    this.qualityGroup.addEventListener('keydown', (event) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      const current = this.qualityLevel ?? QUALITY_ORDER[0];
      const index = QUALITY_ORDER.indexOf(current);
      let nextIndex = index;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (index + QUALITY_ORDER.length - 1) % QUALITY_ORDER.length;
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (index + 1) % QUALITY_ORDER.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = QUALITY_ORDER.length - 1;
      }
      event.preventDefault();
      const target = QUALITY_ORDER[nextIndex];
      this.qualityButtons.get(target)?.focus();
      this.qualityHandler?.(target);
    });
  }

  /** 按值更新画质选中态；note 用于说明当前档位来自 URL、本地保存还是默认值。 */
  setQuality(level: QualityLevel, note?: string): void {
    if (note !== undefined && note !== this.qualityNoteText) {
      this.qualityNoteText = note;
      this.qualityNote.textContent = note;
    }
    if (level === this.qualityLevel) return;
    this.qualityLevel = level;
    for (const [key, button] of this.qualityButtons) {
      const selected = key === level;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      button.dataset.current = selected ? 'true' : 'false';
    }
    const label = QUALITY_PRESETS[level].label;
    const text = `当前画质：${label}`;
    if (this.pauseQuality.textContent !== text) this.pauseQuality.textContent = text;
  }

  getQuality(): QualityLevel | null {
    return this.qualityLevel;
  }

  showMenu(): void {
    this.menu.classList.add('is-visible');
  }

  hideMenu(): void {
    this.menu.classList.remove('is-visible');
  }

  showPause(): void {
    this.pause.classList.add('is-visible');
  }

  hidePause(): void {
    this.pause.classList.remove('is-visible');
  }

  showResult(winner: Team, scoreCT: number, scoreT: number): void {
    const playerWon = winner === 'ct';
    this.resultTitle.textContent = playerWon ? '反恐精英胜利' : '恐怖分子胜利';
    this.resultTitle.classList.toggle('is-win', playerWon);
    this.resultTitle.classList.toggle('is-loss', !playerWon);
    this.resultScore.textContent = `CT ${scoreCT} : ${scoreT} T`;
    this.resultHint.textContent = playerWon
      ? '你的队伍守住了沙漠据点。'
      : '回合再次开始前，调整站位与准星。';
    this.result.classList.add('is-visible');
  }

  hideResult(): void {
    this.result.classList.remove('is-visible');
  }
}
