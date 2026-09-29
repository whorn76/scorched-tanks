# Scorched Tanks

A turn-based artillery tank game for the browser, in the spirit of the 1991 DOS classic *Scorched Earth*. Two to six tanks take turns lobbing shells across hills that blow apart, while the wind pushes every shot around. Loose dirt slides into craters, and tanks tumble in after it. Every turn you can scoot a couple of tank lengths to throw off whoever has you zeroed in, and if a battle drags on, sudden death rains shells from the sky. Between rounds you spend your winnings on nukes, MIRVs, napalm, rollers, shields and parachutes.

You can play hot-seat on one keyboard, against AI tanks with four personalities, or online with up to three friends using a short room code.

It's built with HTML5 Canvas and plain JavaScript ES modules. There's no framework, no build step and no image or sound files: everything is drawn in code and every sound is synthesized with the Web Audio API.

## Play

**Play it now at https://whorn76.github.io/scorched-tanks/**, or run it yourself:

```sh
npm install   # only needed for the relay server and the tests
npm start
```

Then open http://localhost:8080. The game uses ES modules, which browsers only load over HTTP, so opening `index.html` straight from disk won't work. Any static file server works for local and peer-to-peer online play. `npm start` also runs the optional relay server for online play (see below). Set `PORT` to use a different port.

**How to play.** On your turn, set the barrel's angle and the shot's power, pick a weapon and fire. Watch the wind gauge in the top bar. The last tank standing wins the round. Hits, kills and survival earn money for the shop between rounds. Every tank can always fire at full power, however damaged it is.

**Weapons & items menu.** On your turn, click the weapon (or your health or items) in the top bar, or press I, to open a menu of everything you own: pick any weapon, raise a shield, use a battery, or drive. On a touch screen, tap the weapon's name above the Fire button.

**Driving.** Every tank can drive up to two tank lengths either way from where it started its turn, for free, so a rival who has you zeroed in has to adjust. Small flags on the ground mark how far you can go. Fuel from the shop takes you further, and steep slopes stop you either way. Driving doesn't use up your turn. The AI does it too: after a close call it often scoots out of the way before shooting back.

**Sudden death.** Once every tank has had 12 turns in a round (you can change this or switch it off in the settings), sudden death starts: after every turn, shells fall from the sky near random survivors, more of them each time around, and baby nukes after a while. They belong to nobody, so they earn nobody money. A countdown under the top bar warns you three turns ahead. If a round still isn't over after 25 turns per tank, time is called and the healthiest tank wins.

| Action | Keyboard | Mouse / touch |
| --- | --- | --- |
| Turn the barrel | ← / → (hold to speed up, Shift for fine steps) | Drag from your tank: the direction sets the angle |
| Power | ↑ / ↓ (hold to speed up, Shift for fine steps) | Drag distance sets power, or the − / + buttons |
| Fire | Space or Enter | **FIRE** button |
| Change weapon | Tab / Shift+Tab, or [ and ] | Click the weapon in the top bar, or the ‹ › buttons |
| Weapons & items menu | I | Click the weapon, health or items in the top bar; tap the weapon name |
| Drive (two tank lengths free each turn) | A / D | Drive ◀ ▶ in the menu, or the ◀ ▶ touch buttons |
| Raise a shield / use a battery | S / B | Weapons & items menu, or the Shield / Battery buttons |
| Chat (online) | T | |
| Mute | M | Menu → Sound |
| Menu / pause | Esc | ☰ button |
| Help | H or ? | Title screen → How to Play |

Touch controls appear automatically on phones and tablets.

### Weapons

| Weapon | Price | Blast | What it does |
| --- | --- | --- | --- |
| Baby Missile | Free, unlimited | 20 px, 34 dmg | Small, free and unlimited. |
| Missile | $1,800 for 5 | 32 px, 52 dmg | A solid all-rounder. |
| Baby Nuke | $6,500 for 3 | 58 px, 78 dmg | A big blast in a small package. |
| Nuke | $11,000 for 1 | 100 px, 105 dmg | Flattens a whole hillside. |
| MIRV | $9,500 for 2 | 28 px, 42 dmg × 5 | Splits into 5 warheads at the top of its arc. |
| Death's Head | $17,000 for 1 | 44 px, 62 dmg × 9 | Splits into 9 heavy warheads. |
| Funky Bomb | $7,500 for 2 | 30 px + 8 bomblets | Bursts and sprays bomblets everywhere. |
| Leapfrog | $5,000 for 3 | 25 px, 38 dmg × 3 | Explodes, bounces, and explodes again. Three times. |
| Napalm | $5,500 for 3 | — | Burning jelly that runs downhill and burns any tank it reaches. |
| Hot Napalm | $9,500 for 2 | — | More jelly, hotter, longer. |
| Roller | $3,200 for 4 | 30 px, 50 dmg | Rolls downhill and blows up when it stops or hits a tank. |
| Heavy Roller | $6,500 for 2 | 46 px, 72 dmg | A roller with a much bigger bang. |
| Digger | $2,600 for 4 | 22 px, 36 dmg | Tunnels through dirt, then explodes underground. |
| Sandhog | $5,800 for 2 | 30 px, 44 dmg × 3 | Three burrowing warheads that undermine the ground. |
| Dirt Ball | $2,000 for 5 | 42 px of dirt | A ball of dirt. Build a wall or bury a rival. |
| Ton of Dirt | $4,800 for 2 | 82 px of dirt | A huge heap of dirt. |
| Riot Charge | $2,200 for 4 | 48 px | Blasts away the dirt around your own tank so you can dig out. |
| Tracer | $400 for 10 | — | Harmless. Leaves a lasting trail to help you aim. |

Blast damage is full at the center and falls to 30% at the edge. Destroyed tanks explode too, so a crowded hilltop can go up in a chain reaction.

### Items

| Item | Price | What it does |
| --- | --- | --- |
| Parachute | $1,500 for 2 | Opens by itself when you fall too far, so the landing doesn't hurt. |
| Shield | $3,500 for 1 | Absorbs 60 damage. Goes up automatically at the start of a round, or press S (or use the menu). |
| Heavy Shield | $8,000 for 1 | Absorbs 150 damage. Same rules as the Shield. |
| Battery | $2,500 for 2 | Restores 25 health. Press B (or use the menu). |
| Fuel | $1,500 for 150 units | Drive past the free two tank lengths a turn, one unit per pixel. Climbing costs extra, and steep slopes stop you. |

**Money.** You earn $30 per point of damage to others and $2,500 per kill. At the end of a round everyone gets $1,500, plus $750 for every tank they outlived, and the winner gets another $5,000. Hurting yourself costs $25 per point. Selling returns 60% of the price. Inventory and money carry over to the next round.

**Settings** (saved in your browser): rounds, starting cash, wind strength and whether it shifts each turn, gravity, walls (open, wrap-around, rubber, concrete or random), terrain style (rolling hills, mountains, canyons, mostly flat or random), sky (day, sunset, night, storm or random), turn timer, sudden death (after 8, 12, 16 or 20 turns each, or off), talking tanks and sound volume.

**AI opponents.** Every AI plans by firing trial shells through the real physics, then adds mistakes that fit its personality. All but the Rookie get a bit more accurate with each shot at the same target, but none becomes a perfect shot, and once the target drives somewhere else, it has to walk its shots in all over again. Against a tank that doesn't move, the share of baby missiles that do damage is roughly (a target that drives two tank lengths every turn about halves these):

- **Rookie** (about 15%): sloppy aim and random weapons. It shoots at whoever is closest, mostly.
- **Gunner** (about 40% in calm air, 10% in wind): aims well for gravity but ignores the wind. It's dangerous on calm days and lost in a gale.
- **Spotter** (about 20%, rising to 40%): fires a tracer in strong wind, then works the wind out from where its own shells land and tightens up with every shot. It goes after the weakest tank.
- **Cyborg** (about 35%, rising to 45%): reads the wind exactly and picks the strongest weapon that won't hurt itself, so its near misses often still do damage. It holds grudges: it hits back at whoever last hit it.
- **Random:** one of the above, picked at the start of the game.

AIs also shop, raise shields, use batteries, drive closer when they can't reach, dodge after a close call (the Cyborg almost always, the Rookie rarely, and never off a cliff), and use a Riot Charge when they're buried.

## Play online

1. One player chooses **Host Online** and **Create room**. The lobby shows a 5-character room code (the code never uses look-alike characters such as 0/O or 1/I) and a **Copy invite link** button.
2. Friends choose **Join Online** and type the code, or just open the invite link (`…#join=CODE`), which goes straight to the join screen.
3. The host picks the settings, can add AI tanks, and starts the game. Up to four people can play (the host plus three guests), with up to six tanks in total. There's a chat in the lobby and during the game (press T).

**Peer-to-peer (default).** Players connect directly over WebRTC data channels, using the free public [PeerJS](https://peerjs.com) server only to find each other. You don't need to run any server; hosting the page anywhere, including GitHub Pages, is enough.

**When direct connections fail.** Direct connections often can't get through between two different internet connections, for example when one player is on mobile data or a phone hotspot, behind a strict router, or at an office or school. Joining then fails with "Couldn't connect directly to the host", and the host sees a note that someone couldn't get through. There's no free public TURN server to fall back on (the ones PeerJS used to list are gone), so play through a relay server instead, as described next.

**Play across networks with `npm run online`.** The relay is a small server that passes every message along over an ordinary secure WebSocket, so it works on any network. The easiest way to run one is on the host's PC:

```sh
npm install
npm run online
```

This starts the game server with its relay and opens a free Cloudflare quick tunnel to it (no account needed; the first run downloads Cloudflare's `cloudflared` into `.cache/`). It prints a public `https://….trycloudflare.com` link and opens it in your browser. Choose **Host Online** there (the relay is picked automatically) and send your friends the invite link. The link is new every time, and games go through your PC, so keep the window open while you play; press Ctrl+C to stop. To do the same by hand, run `npm start` and `cloudflared tunnel --url http://localhost:8080`.

**An always-on relay on Render.** To play without running anything on your PC, deploy the repository to [Render](https://render.com)'s free plan: [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/whorn76/scorched-tanks). The included `render.yaml` sets it up (build `npm ci --omit=dev`, start `npm start`). Then open the service's `https://….onrender.com` address to play; online games there use its relay automatically. The free plan goes to sleep when nobody has used it for 15 minutes, so the first visit after that takes about a minute to wake it up.

**Using a relay from GitHub Pages.** The copy of the game on a static host such as GitHub Pages can use a relay that runs somewhere else too. The host chooses **Relay server** and pastes the relay's `https://` address (from `npm run online` or Render), and the invite link passes it to everyone else. Use the https address: a page loaded over https can't use a plain `ws://` relay (except on localhost).

**Your own TURN server.** Instead of a relay, you can enter a TURN server (for example from a hosted TURN provider) under **Advanced: TURN server** on the host and join screens. Both players should enter the same one.

The relay limits rooms to one host and five guests, caps messages at 64 KB, limits message rates (hosts get a bigger budget because they relay to everyone), limits connections and rooms per address, and closes a room as soon as its host leaves or after 30 minutes without traffic.

**Versions.** Everyone in a game needs the same version. If the versions differ, the player who's turned away is told whose copy is out of date, and a guest with the older copy gets a **Reload** button that brings them back to the same invite. The GitHub Pages copy also checks for a newer version before you host or join, and offers to reload first (see [Deploy to GitHub Pages](#deploy-to-github-pages)).

**Who's in charge.** The host runs the real game. Guests send their moves; the host checks them (right player, right turn, ammo in stock, sane numbers, not too many messages) and broadcasts them, and every client simulates each shot itself, so explosions look smooth everywhere. After every shot the host sends a fingerprint of the game state. A guest whose fingerprint differs downloads a compressed snapshot and carries on. If a guest drops out, an AI takes over their tank; if the host leaves, the guests are told and return to the menu.

## Deploy to GitHub Pages

The game is a static site with relative paths only, so any static host works. To use GitHub Pages:

1. Push the repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.

The included workflow (`.github/workflows/pages.yml`) runs the tests on every push to `main`, then publishes the site that `scripts/package-pages.mjs` assembles: `index.html`, `relay.json` and `version.json` at the top, and the game itself (`src/`, `vendor/`, `styles.css`) under `v/<commit>/`. GitHub Pages lets browsers reuse files for up to 10 minutes without checking for new ones, so without the versioned folder a reload shortly after an update could still run old files, or a mix of old and new ones. With it, every deploy has new addresses: a page always loads one complete version, `version.json` lets a running copy notice that a newer one is out, and the title screen shows which version you have. Right after a deploy, a reload (Ctrl+F5 to be sure) picks up the new version.

Online play works from Pages through PeerJS. Pages can't run the relay, so for players on different networks, run one with `npm run online` or on Render (see [Play online](#play-online)) and paste its address when you create a room.

## How it's organized

| File | What it does |
| --- | --- |
| `src/core/constants.js` | Tuning knobs: world size, gravity, wind, tank size, falling, timing, and the settings with their options |
| `src/core/rng.js` | Seeded integer PRNG (mulberry32) and integer hashing |
| `src/core/terrain.js` | The destructible bitmap: generation from a height map, carving, dirt, column-by-column settling, dirty tracking |
| `src/core/terrainGen.js` | Round setup on the authority: terrain styles, tank placement, flattened pads, sky, walls and wind |
| `src/core/physics.js` | Shell flight in 1-pixel sub-steps, walls, tank and shield hits, and side-effect-free trial shots |
| `src/core/weapons.js` | The arsenal and items as a data table |
| `src/core/economy.js` | Rewards, prices, and the shop rules |
| `src/core/game.js` | The simulation: commands, turns, rounds, every weapon's behavior, explosions, damage, falling tanks, napalm |
| `src/core/hash.js` | 64-bit fingerprint of the game state |
| `src/core/snapshot.js`, `bytes.js`, `compress.js` | Compressed full-state snapshots (the terrain is stored as a diff from its freshly generated state) |
| `src/session/session.js` | The command pipeline: players' intents become commands on the authority; local hot-seat games |
| `src/session/host.js` | Online host: lobby, handshake, validation, ordered broadcast, hashes, snapshots, AI takeover |
| `src/session/guest.js` | Online guest: applies the host's commands in order, verifies hashes, repairs itself |
| `src/net/protocol.js` | Protocol version, message validation for both directions, room codes, rate limiting |
| `src/net/transport.js` | The shared transport interface, plus an in-process loopback for tests |
| `src/net/peerTransport.js` | PeerJS/WebRTC transport (loads `vendor/peerjs` on demand) |
| `src/net/relayTransport.js` | WebSocket relay transport |
| `src/ai/aim.js`, `brain.js`, `personality.js` | AI: trial-physics aim search, the turn controller, and personalities as data |
| `src/render/renderer.js` | World and HUD drawing, letterboxed 1280×720 at full display resolution |
| `src/render/terrainLayer.js` | Offscreen terrain canvas that re-uploads only dirty rectangles |
| `src/render/sky.js`, `palette.js` | Sky themes, and terrain colors per ground theme and sky tint |
| `src/render/effects.js`, `bubbles.js` | Particles, shockwaves, shake and flashes; speech bubbles |
| `src/audio.js` | Synthesized sound effects |
| `src/quips.js` | What talking tanks say |
| `src/ui/*.js` | Menus, lobby, shop, the weapons & items menu (`arsenal.js`), settings, chat, touch controls (DOM, text only, never `innerHTML`) |
| `src/input.js` | Keyboard input with held-key acceleration |
| `src/storage.js` | Settings and preferences in `localStorage` |
| `src/main.js` | Wires everything together and runs the game loop and the title-screen demo battle |
| `src/version.js` | Which published version is running, and whether a newer one is out |
| `server/server.js` | `npm start`: static file server plus the relay |
| `relay.json` | Tells the game there's no relay here when it's on a static host; the relay server answers the same address with `true` |
| `server/relay.js` | The WebSocket relay (uses the `ws` package) |
| `scripts/online.mjs` | `npm run online`: the relay server plus a Cloudflare quick tunnel, for playing across networks |
| `scripts/package-pages.mjs` | Assembles the GitHub Pages site, with the game under `v/<commit>/` |
| `render.yaml` | Render blueprint for an always-on relay |
| `vendor/peerjs/` | PeerJS 1.5.5 (MIT), loaded only for peer-to-peer play |

Some design choices worth knowing:

- **Deterministic core.** `src/core` has no DOM, timers or network code, never calls `Math.random`, `Date.now` or `performance.now`, and each tick uses only `+ − × ÷`, `Math.sqrt` and rounding. Engines can disagree in the last bit of `Math.sin` or `Math.pow`, so trig runs once, on the authority, and its results (the launch velocity, the terrain heights) travel inside commands. A test scans the core for forbidden calls.
- **One command pipeline.** Keyboard, touch, AI and network input all become the same intents (`fire`, `move`, `use`, `buy`, `sell`, `ready`). The authority turns them into commands, and every client applies commands the same way, one at a time and only when its world is at rest. That's what keeps online games in sync.
- **Fixed timestep.** The simulation always advances in 1/60-second ticks, so the physics are identical at any frame rate.
- **Dirt that keeps its color.** Every terrain pixel stores a palette index. Settling moves those indices down each column, and the renderer converts only the rectangles that changed.
- **No assets.** Tanks, skies, explosions and the HUD are drawn in code, and sounds are synthesized.

## Test

```sh
npm test          # unit and integration tests (Node's built-in runner)
npm run test:e2e  # browser tests with Playwright (installs Chromium if needed)
```

`npm test` covers the PRNG, terrain carving and settling, collisions and sub-stepping, walls, blast falloff, falling and parachutes, free driving and fuel, sudden death, every weapon's key behavior, shields, the economy and shop rules, the AI (including hitting a target within a few shots with no wind, missing often enough that even the Cyborg isn't a perfect shot, dodging, losing its walked-in aim when the target moves, and staying within its time budget), snapshot and hash round-trips, rejection of bad protocol messages, version-mismatch handling, and the packaged Pages site. It also runs full AI-driven online games over the loopback transport, with a host and one or two guests, and checks that every guest's state hash matches the host's after every shot. The relay is tested with real WebSocket clients, including a complete game.

`npm run test:e2e` plays in real Chromium: the title demo and help screen, a local game against the AI with zero console errors, the weapons & items menu and free driving, sudden death, the phone layout's touch controls, and online games between two browser contexts. The online tests cover a page served by the relay, and the game on a GitHub Pages stand-in (the site packaged exactly as the Pages workflow does it, served under a subpath). From that stand-in they play once through a relay hosted elsewhere and once over PeerJS, and check that an out-of-date copy offers to reload before joining. The PeerJS test is skipped if the public PeerJS server can't be reached. Screenshots land in `test-results/e2e/`.

The page exposes a small debug hook for tests and tinkering: `window.__scorched.phase`, `.hash`, `.turnId`, `.round`, `.seq` and `.session`. Press F3 in a game to show frame rate and simulation info.

> "Scorched Earth" is a trademark of its creator, Wendell Hicken. Scorched Tanks is an unofficial tribute: all of its code, graphics, sounds and text are original.
