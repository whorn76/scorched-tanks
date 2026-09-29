// The shop between rounds. One tank shops at a time on this screen (hot-seat players take
// turns); online, everyone shops at once and clicks Ready. Buying and selling go through the
// same command pipeline as everything else, so online the host checks every purchase.
import { buyProblem, sellProblem, sellValue } from '../core/economy.js';
import { ITEMS, WEAPONS } from '../core/weapons.js';
import { h, money } from './dom.js';

const ICON_COLORS = {
  missile: '#ffd36a',
  mirv: '#ff8a5a',
  funky: '#ff6fd8',
  leapfrog: '#7fff9a',
  napalm: '#ff7a2a',
  roller: '#b0b8ff',
  digger: '#c9a27a',
  dirt: '#a0703a',
  riot: '#ff5a4a',
  tracer: '#7fffc4',
  // Items, by id.
  parachute: '#f4f6fb',
  shield: '#7fd8ff',
  heavyshield: '#6f86ff',
  battery: '#8dff9a',
  fuel: '#ffb34a',
};

/** A small colored dot for a weapon or item, the same one the shop uses. */
export function productIcon(product) {
  const color = ICON_COLORS[product.kind ?? product.id] ?? '#9fd8ff';
  return h('span', { class: 'shop-icon', style: { background: color } });
}

const icon = productIcon;

export class Shop {
  /**
   * session: the running session; getTankId(): which tank is shopping here;
   * onDone(tankId): finished (hot-seat "Done", online "Ready").
   */
  constructor(session, { getTankId, onDone, onSound = () => {} }) {
    this.session = session;
    this.getTankId = getTankId;
    this.onDone = onDone;
    this.onSound = onSound;
    this.rows = new Map();
    this.title = h('h2', {});
    this.subtitle = h('p', { class: 'hint' });
    this.cash = h('div', { class: 'shop-cash' });
    this.who = h('div', { class: 'shop-who' });
    this.readyList = h('div', { class: 'shop-ready' });
    this.doneButton = h('button', { class: 'btn primary', id: 'btn-shop-done', onclick: () => this.done() });
    const table = (title, products) =>
      h('div', { class: 'shop-section' },
        h('h3', { text: title }),
        h('div', { class: 'shop-rows' }, products.map((p) => this.row(p))));
    this.el = h('div', { class: 'panel wide shop', id: 'shop' },
      h('div', { class: 'shop-head' }, h('div', {}, this.title, this.subtitle), h('div', { class: 'shop-purse' }, this.who, this.cash)),
      h('div', { class: 'shop-body' }, table('Weapons', WEAPONS.filter((w) => w.price > 0)), table('Items', ITEMS)),
      h('div', { class: 'row end' }, this.readyList, h('span', { class: 'spacer' }), this.doneButton));
    this.lastKey = '';
    this.update();
  }

  row(product) {
    const owned = h('span', { class: 'shop-owned' });
    const buy = h('button', { class: 'btn small primary', text: 'Buy', onclick: () => this.trade('buy', product.id), dataset: { buy: product.id } });
    const sell = h('button', { class: 'btn small', text: 'Sell', onclick: () => this.trade('sell', product.id), dataset: { sell: product.id } });
    const unit = product.id === 'fuel' ? `${product.bundle} units` : `×${product.bundle}`;
    const el = h('div', { class: 'shop-row', title: product.blurb },
      icon(product),
      h('div', { class: 'shop-name' }, h('strong', { text: product.name }), h('small', { text: product.blurb })),
      h('span', { class: 'shop-price', text: `${money(product.price)} ${unit}` }),
      owned,
      buy,
      sell);
    this.rows.set(product.id, { el, owned, buy, sell, product });
    return el;
  }

  tank() {
    const id = this.getTankId();
    return id >= 0 ? this.session.game.state.tanks[id] : null;
  }

  trade(kind, item) {
    const tank = this.tank();
    if (!tank) return;
    const problem = kind === 'buy' ? buyProblem(tank, item) : sellProblem(tank, item);
    if (problem) return;
    this.session.submit({ type: kind, playerId: tank.id, item });
    this.onSound(kind);
  }

  done() {
    const tank = this.tank();
    if (tank) this.onDone(tank.id);
  }

  update() {
    const tank = this.tank();
    const s = this.session.game.state;
    const readyKey = [...this.session.ready].join(',');
    const key = tank ? `${tank.id}:${tank.money}:${JSON.stringify(tank.stock)}:${readyKey}` : `none:${readyKey}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.title.textContent = s.round === 0 ? 'Shop — before the first round' : `Shop — after round ${s.round} of ${s.settings.rounds}`;
    this.subtitle.textContent = this.session.online
      ? 'Everyone shops at the same time. Click Ready when you are done.'
      : 'Stock up for the next round. Selling returns 60% of the price.';
    if (!tank) return;
    this.who.replaceChildren(h('span', { class: 'chip', style: { background: tank.color } }), tank.name);
    this.cash.textContent = money(tank.money);
    for (const { owned, buy, sell, product } of this.rows.values()) {
      const n = tank.stock[product.id] ?? 0;
      owned.textContent = n ? (product.id === 'fuel' ? `${n}` : `×${n}`) : '';
      buy.disabled = !!buyProblem(tank, product.id);
      sell.disabled = !!sellProblem(tank, product.id);
      sell.title = sell.disabled ? '' : `Sell for ${money(sellValue(product, Math.min(product.bundle, n)))}`;
    }
    if (this.session.online) {
      this.doneButton.textContent = 'Ready';
      const humans = s.tanks.filter((t) => !t.ai);
      this.readyList.replaceChildren(...humans.map((t) =>
        h('span', { class: `ready-pill${this.session.ready.has(t.id) ? ' ready' : ''}` }, h('span', { class: 'chip', style: { background: t.color } }), t.name)));
    } else {
      const left = this.session.localShoppers().length;
      this.doneButton.textContent = left > 1 ? 'Done — next player' : 'Done — to battle!';
      this.readyList.replaceChildren();
    }
  }
}
