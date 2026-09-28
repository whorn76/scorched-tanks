// Money: what tanks earn for fighting, and the shop rules. Shared by the simulation (rewards)
// and the shop UI and AI (prices and checks).
import { MAX_HEALTH } from './constants.js';
import { FREE_WEAPON, ITEM_BY_ID, productById, stockLimit } from './weapons.js';

export const ECONOMY = Object.freeze({
  damageReward: 30, // per point of damage dealt to an opponent
  killReward: 2500,
  selfDamageCost: 25, // per point of damage dealt to yourself
  roundIncome: 1500, // everyone, every round
  winBonus: 5000, // last tank standing
  survivalBonus: 750, // per opponent you outlived this round
  sellRate: 0.6, // selling returns this share of what you paid
  maxMoney: 9999999,
});

export const clampMoney = (money) => Math.max(0, Math.min(ECONOMY.maxMoney, Math.floor(money)));

/** Refund for selling `units` of a product. */
export function sellValue(product, units) {
  if (!product || product.price <= 0 || product.bundle <= 0) return 0;
  return Math.floor((product.price * units * ECONOMY.sellRate) / product.bundle);
}

/** Why a tank can't buy one bundle of `id`, or null if it can. */
export function buyProblem(tank, id) {
  const product = productById(id);
  if (!product || id === FREE_WEAPON || product.price <= 0) return 'not for sale';
  if (tank.money < product.price) return 'not enough money';
  if ((tank.stock[id] ?? 0) + product.bundle > stockLimit(id)) return 'you cannot carry more';
  return null;
}

/** Why a tank can't sell `id`, or null if it can. */
export function sellProblem(tank, id) {
  const product = productById(id);
  if (!product || id === FREE_WEAPON || product.price <= 0) return 'cannot be sold';
  if ((tank.stock[id] ?? 0) <= 0) return 'nothing to sell';
  return null;
}

/** How many units one sale removes: a bundle, or whatever is left. */
export const sellUnits = (tank, id) => Math.min(productById(id).bundle, tank.stock[id] ?? 0);

export const batteryRestore = () => ITEM_BY_ID.battery.restore;
export const needsBattery = (tank) => tank.health < MAX_HEALTH;
