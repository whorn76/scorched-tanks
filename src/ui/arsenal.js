// The weapons & items menu. On your turn, click the weapon, health or items in the top bar, press
// I, or tap the weapon name on a touch screen to open it. Pick any weapon you own, raise a
// shield, use a battery, or drive: every tank can drive two tank lengths either way each turn
// for free, and fuel takes it further. The menu sends the same intents as the keyboard, so
// online the host still checks everything.
import { MAX_HEALTH } from '../core/constants.js';
import { driveProblem, freeDriveZone } from '../core/game.js';
import { FREE_WEAPON, ITEM_BY_ID, WEAPONS } from '../core/weapons.js';
import { h } from './dom.js';
import { productIcon } from './shop.js';

const SHIELDS = ['shield', 'heavyshield'];
const NOTES = {
  shield: `Absorbs ${ITEM_BY_ID.shield.strength} damage`,
  heavyshield: `Absorbs ${ITEM_BY_ID.heavyshield.strength} damage`,
  battery: `Restores ${ITEM_BY_ID.battery.restore} health`,
  parachute: 'Opens by itself when you fall',
};

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

export class Arsenal {
  /** handlers: select(weaponId), use(itemId), close() */
  constructor(root, handlers) {
    this.root = root;
    this.handlers = handlers;
    this.isOpen = false;
    this.driving = 0; // -1 or 1 while a drive button is held
    this.tankId = -1;
    this.weaponsKey = '';
    this.weaponButtons = new Map();
    root.hidden = true;
    // Keep keyboard focus off the menu's buttons: Space fires, and a focused button would be
    // pressed again.
    root.addEventListener('mousedown', (e) => e.preventDefault());
  }

  show(tank, aim) {
    this.isOpen = true;
    this.tankId = tank.id;
    this.weaponsKey = '';
    // Items you had when the menu opened keep their rows (as ×0) until it closes, so nothing
    // jumps around under the pointer when you use the last one.
    this.listed = new Set(['shield', 'heavyshield', 'battery', 'parachute'].filter((id) => tank.stock[id] > 0 || tank.shieldType === id));
    this.build(tank);
    this.root.hidden = false;
    this.update({ tank, aim, idle: true });
  }

  hide() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.driving = 0;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  /** Puts the menu's top-left corner near (left, top), in CSS pixels, keeping it on screen. */
  place(left, top) {
    const width = Math.min(360, window.innerWidth - 16);
    const x = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(top, window.innerHeight - 200));
    Object.assign(this.root.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, width: `${width}px` });
    this.panel.style.maxHeight = `${Math.max(180, window.innerHeight - y - 8)}px`;
  }

  build(tank) {
    const close = h('button', { class: 'arsenal-close', 'aria-label': 'Close', text: '✕', onclick: () => this.handlers.close() });
    this.weaponGrid = h('div', { class: 'arsenal-weapons' });
    this.weaponHint = h('p', { class: 'hint arsenal-hint', text: 'Buy more weapons in the shop between rounds.' });
    this.itemRows = new Map();
    const items = h('div', { class: 'arsenal-items' });
    for (const id of ['shield', 'heavyshield', 'battery', 'parachute']) {
      const row = this.itemRow(id);
      this.itemRows.set(id, row);
      items.append(row.el);
    }
    this.driveRow = this.driveControls(tank.color);
    items.append(this.driveRow.el);
    this.panel = h('div', { class: 'arsenal-panel', id: 'arsenal-menu', role: 'dialog', 'aria-label': 'Weapons and items' },
      h('div', { class: 'arsenal-head' },
        h('span', { class: 'chip', style: { background: tank.color } }),
        h('strong', { text: tank.name }),
        h('span', { class: 'spacer' }),
        close),
      h('h3', { text: 'Weapons' }),
      this.weaponGrid,
      this.weaponHint,
      h('h3', { text: 'Items' }),
      items);
    this.root.replaceChildren(this.panel);
  }

  itemRow(id) {
    const item = ITEM_BY_ID[id];
    const count = h('span', { class: 'arsenal-count' });
    const note = h('small', { text: NOTES[id] });
    const action = id === 'parachute'
      ? h('span', { class: 'arsenal-pill', text: 'Automatic' })
      : h('button', { class: 'btn small primary', dataset: { use: id }, text: id === 'battery' ? 'Use' : 'Raise', onclick: () => this.handlers.use(id) });
    const el = h('div', { class: 'arsenal-row', dataset: { item: id } },
      productIcon(item),
      h('div', { class: 'arsenal-name' }, h('strong', { text: item.name }), note),
      count,
      action);
    return { el, count, note, action, item };
  }

  driveControls(color) {
    const hold = (dir, label) => {
      const el = h('button', { class: 'btn small arsenal-drive', 'aria-label': dir < 0 ? 'Drive left' : 'Drive right', dataset: { drive: String(dir) }, text: label });
      el.addEventListener('pointerdown', (e) => {
        if (el.disabled) return;
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        this.driving = dir;
      });
      const stop = () => {
        if (this.driving === dir) this.driving = 0;
      };
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointercancel', stop);
      el.addEventListener('lostpointercapture', stop);
      return el;
    };
    const marker = h('span', { class: 'arsenal-zone-tank' });
    const note = h('small', {});
    const count = h('span', { class: 'arsenal-count' });
    const left = hold(-1, '◀');
    const right = hold(1, '▶');
    const el = h('div', { class: 'arsenal-row drive', dataset: { item: 'drive' } },
      h('span', { class: 'shop-icon', style: { background: color } }),
      h('div', { class: 'arsenal-name' },
        h('strong', { text: 'Drive' }),
        note,
        h('span', { class: 'arsenal-zone', title: 'Where you can drive for free this turn' }, marker)),
      count,
      h('div', { class: 'arsenal-drive-buttons' }, left, right));
    return { el, note, count, marker, left, right };
  }

  /**
   * Keeps the menu current. `idle` is false while something is still moving (a drive, say):
   * weapons can still be picked, but items wait.
   */
  update({ tank, aim, idle }) {
    if (!this.isOpen || !tank || !aim) return;
    const owned = WEAPONS.filter((w) => w.id === FREE_WEAPON || tank.stock[w.id] > 0);
    const key = owned.map((w) => w.id).join(',');
    if (key !== this.weaponsKey) {
      this.weaponsKey = key;
      this.weaponButtons.clear();
      this.weaponGrid.replaceChildren(...owned.map((w) => {
        const count = h('span', { class: 'arsenal-count' });
        const el = h('button', { class: 'arsenal-weapon', dataset: { weapon: w.id }, title: w.blurb, onclick: () => this.handlers.select(w.id) },
          productIcon(w),
          h('span', { class: 'arsenal-weapon-name', text: w.name }),
          count);
        this.weaponButtons.set(w.id, { el, count });
        return el;
      }));
      this.weaponHint.hidden = owned.length > 1;
    }
    for (const [id, { el, count }] of this.weaponButtons) {
      setText(count, id === FREE_WEAPON ? '∞' : `×${tank.stock[id]}`);
      const selected = id === aim.weaponId;
      if (el.classList.contains('selected') !== selected) {
        el.classList.toggle('selected', selected);
        el.setAttribute('aria-pressed', String(selected));
      }
    }

    for (const [id, row] of this.itemRows) {
      const n = tank.stock[id] ?? 0;
      const up = SHIELDS.includes(id) && tank.shieldType === id && tank.shield > 0;
      if (n > 0 || up) this.listed.add(id);
      row.el.hidden = !this.listed.has(id);
      if (row.el.hidden) continue;
      setText(row.count, `×${n}`);
      if (id === 'parachute') continue;
      setText(row.note, up ? `Up: absorbs ${tank.shield} more` : NOTES[id]);
      let why = '';
      if (n <= 0) why = 'None left';
      else if (!idle) why = 'Wait until everything stops moving';
      else if (id === 'battery' && tank.health >= MAX_HEALTH) why = 'Already at full health';
      else if (SHIELDS.includes(id) && tank.shield >= row.item.strength) why = 'Your shield is already this strong';
      row.action.disabled = !!why;
      row.action.title = why;
    }

    const [from, to] = freeDriveZone(tank);
    const where = Math.min(1, Math.max(0, (tank.x - from) / (to - from)));
    this.driveRow.marker.style.left = `${(where * 100).toFixed(1)}%`;
    const fuel = tank.stock.fuel;
    setText(this.driveRow.note, fuel > 0 ? 'Free inside the bar; fuel goes further' : 'Two tank lengths either way, free each turn');
    setText(this.driveRow.count, fuel > 0 ? `${fuel} fuel` : '');
    for (const [dir, button] of [[-1, this.driveRow.left], [1, this.driveRow.right]]) {
      const blocked = !!driveProblem(tank, dir);
      button.disabled = blocked;
      button.title = blocked ? 'That’s as far as you can drive this turn' : '';
      if (blocked && this.driving === dir) this.driving = 0;
    }
  }
}
