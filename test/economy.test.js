import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, Phase } from '../src/core/game.js';
import { ECONOMY, sellValue } from '../src/core/economy.js';
import { ITEM_BY_ID, MAX_STOCK, WEAPON_BY_ID } from '../src/core/weapons.js';
import { planRound } from '../src/core/terrainGen.js';
import { Rng } from '../src/core/rng.js';
import { flatGame, players } from './helpers.js';

function shopGame(cash = 20000) {
  const game = Game.create({ settings: { startCash: 20000 }, players: players(2) });
  for (const tank of game.state.tanks) tank.money = cash;
  assert.equal(game.apply({ type: 'openShop' }).ok, true);
  assert.equal(game.phase, Phase.SHOP);
  return game;
}

test('buying costs the bundle price and adds the bundle', () => {
  const game = shopGame(20000);
  const tank = game.state.tanks[0];
  const missile = WEAPON_BY_ID.missile;
  assert.equal(game.apply({ type: 'buy', playerId: 0, item: 'missile' }).ok, true);
  assert.equal(tank.money, 20000 - missile.price);
  assert.equal(tank.stock.missile, missile.bundle);
  assert.equal(game.apply({ type: 'buy', playerId: 0, item: 'fuel' }).ok, true);
  assert.equal(tank.stock.fuel, ITEM_BY_ID.fuel.bundle);
});

test('the shop checks money, stock limits and what is for sale', () => {
  const game = shopGame(3000);
  const tank = game.state.tanks[0];
  assert.equal(game.apply({ type: 'buy', playerId: 0, item: 'nuke' }).error, 'not enough money');
  assert.equal(game.apply({ type: 'buy', playerId: 0, item: 'baby' }).error, 'not for sale');
  assert.equal(game.apply({ type: 'buy', playerId: 0, item: 'laser' }).error, 'not for sale');
  assert.equal(game.apply({ type: 'buy', playerId: 9, item: 'missile' }).error, 'unknown player');
  tank.money = 1e6;
  tank.stock.tracer = MAX_STOCK - 5;
  assert.equal(game.apply({ type: 'buy', playerId: 0, item: 'tracer' }).error, 'you cannot carry more');
  assert.equal(tank.money, 1e6, 'failed purchases cost nothing');
});

test('selling loses money compared to buying', () => {
  const game = shopGame(20000);
  const tank = game.state.tanks[0];
  game.apply({ type: 'buy', playerId: 0, item: 'babynuke' });
  const afterBuy = tank.money;
  assert.equal(game.apply({ type: 'sell', playerId: 0, item: 'babynuke' }).ok, true);
  const product = WEAPON_BY_ID.babynuke;
  assert.equal(tank.money, afterBuy + sellValue(product, product.bundle));
  assert.equal(tank.money, 20000 - product.price + Math.floor(product.price * ECONOMY.sellRate));
  assert.ok(tank.money < 20000);
  assert.equal(tank.stock.babynuke, 0);
  assert.equal(game.apply({ type: 'sell', playerId: 0, item: 'babynuke' }).error, 'nothing to sell');
  assert.equal(game.apply({ type: 'sell', playerId: 0, item: 'baby' }).error, 'cannot be sold');
});

test('the shop is closed during battle', () => {
  const game = flatGame();
  game.state.tanks[0].money = 50000;
  assert.equal(game.apply({ type: 'buy', playerId: 0, item: 'missile' }).error, 'the shop is closed');
});

test('inventory and money carry over between rounds', () => {
  const game = shopGame(30000);
  game.apply({ type: 'buy', playerId: 0, item: 'missile' });
  game.apply({ type: 'buy', playerId: 0, item: 'parachute' });
  const money = game.state.tanks[0].money;
  const rng = new Rng(3);
  game.apply({ type: 'newRound', ...planRound({ settings: game.state.settings, tankCount: 2, round: 1, rng }) });
  const tank = game.state.tanks[0];
  assert.equal(tank.stock.missile, 5);
  assert.equal(tank.stock.parachute, 2);
  assert.equal(tank.money, money);
});

test('shields in stock go up automatically at the start of a round', () => {
  const game = shopGame(30000);
  game.apply({ type: 'buy', playerId: 0, item: 'shield' });
  game.apply({ type: 'buy', playerId: 0, item: 'heavyshield' });
  game.apply({ type: 'newRound', ...planRound({ settings: game.state.settings, tankCount: 2, round: 1, rng: new Rng(1) }) });
  const tank = game.state.tanks[0];
  assert.equal(tank.shield, ITEM_BY_ID.heavyshield.strength, 'the strongest shield first');
  assert.equal(tank.stock.heavyshield, 0);
  assert.equal(tank.stock.shield, 1, 'a spare for later');
});

test('batteries restore health and shields can be raised on your turn', () => {
  const game = flatGame();
  const tank = game.state.tanks[0];
  const use = (item) => game.apply({ type: 'use', turnId: game.state.turnId, playerId: 0, item });
  assert.equal(use('battery').error, 'none left');
  tank.stock.battery = 2;
  assert.equal(use('battery').error, 'already at full health');
  tank.health = 60;
  assert.equal(use('battery').ok, true);
  assert.equal(tank.health, 85);
  tank.health = 95;
  use('battery');
  assert.equal(tank.health, 100, 'capped at 100');
  assert.equal(tank.stock.battery, 0);
  tank.stock.shield = 1;
  assert.equal(use('shield').ok, true);
  assert.equal(tank.shield, ITEM_BY_ID.shield.strength);
  assert.equal(use('nuke').error, 'cannot use that');
  assert.equal(game.state.active, 0, 'using items does not end the turn');
  assert.equal(game.phase, Phase.AIM);
});

test('earnings: damage and kills pay, the winner and survivors get bonuses', () => {
  const game = flatGame({ xs: [200, 640, 1080] });
  const [a, b, c] = game.state.tanks;
  game.damageTank(b, 100, 0);
  game.damageTank(c, 30, 0);
  assert.equal(a.money, 130 * ECONOMY.damageReward + ECONOMY.killReward);
  c.health = 1;
  game.damageTank(c, 10, 0);
  game.state.phase = Phase.BUSY;
  game.state.quietNeeded = 1;
  game.settle();
  assert.equal(game.phase, Phase.ROUND_OVER);
  const results = game.state.results;
  assert.equal(results.winner, 0);
  const row = (id) => results.earnings.find((e) => e.tank === id);
  assert.equal(row(0).kills, 2);
  assert.equal(row(1).bonus, ECONOMY.roundIncome, 'first to die outlived nobody');
  assert.equal(row(2).bonus, ECONOMY.roundIncome + ECONOMY.survivalBonus);
  assert.equal(row(0).bonus, ECONOMY.roundIncome + 2 * ECONOMY.survivalBonus + ECONOMY.winBonus);
});

test('a multi-round game ends with standings', () => {
  const game = Game.create({ settings: { rounds: 2, startCash: 0 }, players: players(2) });
  const rng = new Rng(8);
  for (let round = 1; round <= 2; round++) {
    game.apply({ type: 'newRound', ...planRound({ settings: game.state.settings, tankCount: 2, round, rng }) });
    game.damageTank(game.state.tanks[round % 2], 200, (round + 1) % 2);
    game.state.phase = Phase.BUSY;
    game.state.quietNeeded = 1;
    game.settle();
    assert.equal(game.phase, Phase.ROUND_OVER);
    if (round < 2) assert.equal(game.apply({ type: 'openShop' }).ok, true);
  }
  assert.equal(game.isLastRound(), true);
  assert.equal(game.apply({ type: 'openShop' }).error, 'no rounds left');
  assert.equal(game.apply({ type: 'endGame' }).ok, true);
  assert.equal(game.phase, Phase.GAME_OVER);
  const standings = game.standings();
  assert.equal(standings.length, 2);
  assert.ok(standings.every((t) => t.stats.wins === 1));
});
