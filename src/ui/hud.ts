import type { HudState } from '../game/types';

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`缺少界面节点：${selector}`);
  }
  return element as T;
}

function formatTime(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly hitMarker: HTMLDivElement;
  private readonly health: HTMLDivElement;
  private readonly armor: HTMLDivElement;
  private readonly scoreCt: HTMLSpanElement;
  private readonly scoreT: HTMLSpanElement;
  private readonly timer: HTMLSpanElement;
  private readonly roundLabel: HTMLDivElement;
  private readonly killFeed: HTMLDivElement;
  private readonly weapon: HTMLDivElement;
  private readonly mag: HTMLSpanElement;
  private readonly reserve: HTMLSpanElement;
  private readonly reload: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly spectator: HTMLDivElement;
  private readonly damage: HTMLDivElement;
  private readonly damageDir: HTMLDivElement;
  private readonly scoreboard: HTMLDivElement;

  private feedSignature = '';
  private scoreboardSignature = '';
  private readonly textCache = new Map<string, string>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud__top">
        <div class="hud__score">
          <span class="hud__team hud__team--ct" data-role="score-ct">CT 0</span>
          <span class="hud__timer" data-role="timer">1:15</span>
          <span class="hud__team hud__team--t" data-role="score-t">0 T</span>
        </div>
        <div class="hud__round" data-role="round">第 1 回合</div>
      </div>
      <div class="hud__banner" data-role="banner"></div>
      <div class="hud__killfeed" data-role="killfeed"></div>
      <div class="crosshair" data-role="crosshair">
        <span class="crosshair__line crosshair__line--top"></span>
        <span class="crosshair__line crosshair__line--bottom"></span>
        <span class="crosshair__line crosshair__line--left"></span>
        <span class="crosshair__line crosshair__line--right"></span>
        <span class="crosshair__dot"></span>
      </div>
      <div class="hitmarker" data-role="hitmarker">✕</div>
      <div class="hud__bottom">
        <div class="vitals">
          <div class="vitals__item vitals__item--health"><span class="vitals__label">HP</span><span class="vitals__value" data-role="health">100</span></div>
          <div class="vitals__item vitals__item--armor"><span class="vitals__label">AR</span><span class="vitals__value" data-role="armor">100</span></div>
        </div>
        <div class="ammo">
          <div class="ammo__weapon" data-role="weapon">AK-12 突击步枪</div>
          <div class="ammo__count">
            <span class="ammo__mag" data-role="mag">30</span>
            <span class="ammo__slash">/</span>
            <span class="ammo__reserve" data-role="reserve">90</span>
          </div>
          <div class="ammo__reload" data-role="reload">换弹中…</div>
        </div>
      </div>
      <div class="hud__spectate" data-role="spectate"></div>
      <div class="damage-vignette" data-role="damage"></div>
      <div class="damage-dir" data-role="damage-dir"></div>
      <div class="scoreboard" data-role="scoreboard"></div>
    `;
    parent.appendChild(this.root);

    this.crosshair = requireElement(this.root, '[data-role="crosshair"]');
    this.hitMarker = requireElement(this.root, '[data-role="hitmarker"]');
    this.health = requireElement(this.root, '[data-role="health"]');
    this.armor = requireElement(this.root, '[data-role="armor"]');
    this.scoreCt = requireElement(this.root, '[data-role="score-ct"]');
    this.scoreT = requireElement(this.root, '[data-role="score-t"]');
    this.timer = requireElement(this.root, '[data-role="timer"]');
    this.roundLabel = requireElement(this.root, '[data-role="round"]');
    this.killFeed = requireElement(this.root, '[data-role="killfeed"]');
    this.weapon = requireElement(this.root, '[data-role="weapon"]');
    this.mag = requireElement(this.root, '[data-role="mag"]');
    this.reserve = requireElement(this.root, '[data-role="reserve"]');
    this.reload = requireElement(this.root, '[data-role="reload"]');
    this.banner = requireElement(this.root, '[data-role="banner"]');
    this.spectator = requireElement(this.root, '[data-role="spectate"]');
    this.damage = requireElement(this.root, '[data-role="damage"]');
    this.damageDir = requireElement(this.root, '[data-role="damage-dir"]');
    this.scoreboard = requireElement(this.root, '[data-role="scoreboard"]');
  }

  update(state: HudState, showScoreboard: boolean): void {
    this.root.classList.toggle('hud--dead', !state.alive && state.phase === 'live');
    this.root.classList.toggle('hud--menu', state.phase === 'menu');

    this.setText(this.health, 'health', String(Math.max(0, state.health)));
    this.setText(this.armor, 'armor', String(Math.max(0, state.armor)));
    this.setText(this.mag, 'mag', String(state.mag));
    this.setText(this.reserve, 'reserve', String(state.reserve));
    this.setText(this.weapon, 'weapon', state.weaponName);
    this.setText(this.timer, 'timer', formatTime(state.timeLeft));
    this.setText(this.scoreCt, 'scoreCt', `CT ${state.scoreCT}`);
    this.setText(this.scoreT, 'scoreT', `${state.scoreT} T`);
    this.setText(this.roundLabel, 'round', state.phase === 'live' ? `第 ${state.round} 回合` : state.banner);

    this.reload.classList.toggle('is-visible', state.reloading);
    this.banner.textContent = state.banner;
    this.banner.classList.toggle('is-visible', state.phase !== 'menu' && state.banner.length > 0);

    this.crosshair.style.setProperty('--spread', `${(state.spread * 950).toFixed(1)}px`);
    this.crosshair.classList.toggle('is-hidden', !state.alive || state.phase !== 'live');

    this.hitMarker.style.opacity = state.hitMarker.toFixed(2);
    this.hitMarker.style.transform = `translate(-50%, -50%) scale(${1 + state.hitMarker * 0.35})`;

    this.damage.style.opacity = (state.damageFlash * 0.55).toFixed(2);
    const showDir = state.damageFlash > 0.06;
    this.damageDir.style.opacity = showDir ? '1' : '0';
    this.damageDir.style.transform = `rotate(${state.damageAngle}rad)`;

    this.spectator.textContent = state.spectating ? `观战：${state.spectating}` : '';
    this.spectator.classList.toggle('is-visible', Boolean(state.spectating));

    const feedSignature = state.killFeed.map((kill) => kill.id).join(',');
    if (feedSignature !== this.feedSignature) {
      this.feedSignature = feedSignature;
      this.killFeed.innerHTML = state.killFeed.map((kill) => `<div>${kill.text}</div>`).join('');
    }

    this.scoreboard.classList.toggle('is-visible', showScoreboard);
    if (showScoreboard) {
      const signature = state.scoreboard
        .map((row) => `${row.id}:${row.kills}:${row.deaths}:${row.alive ? 1 : 0}`)
        .join('|');
      if (signature !== this.scoreboardSignature) {
        this.scoreboardSignature = signature;
        const rows = state.scoreboard
          .map(
            (row) => `
              <tr class="${row.team} ${row.alive ? '' : 'down'} ${row.isPlayer ? 'you' : ''}">
                <td>${row.name}</td>
                <td>${row.team === 'ct' ? 'CT' : 'T'}</td>
                <td>${row.kills}</td>
                <td>${row.deaths}</td>
                <td>${row.alive ? '存活' : '阵亡'}</td>
              </tr>`,
          )
          .join('');
        this.scoreboard.innerHTML = `
          <h2>计分板 <span>释放 Tab 关闭</span></h2>
          <table>
            <thead><tr><th>玩家</th><th>阵营</th><th>击杀</th><th>死亡</th><th>状态</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`;
      }
    }
  }

  private setText(element: HTMLElement, key: string, value: string): void {
    if (this.textCache.get(key) === value) return;
    this.textCache.set(key, value);
    element.textContent = value;
  }
}
