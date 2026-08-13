/*
 * Shared test plumbing.
 *
 * Every suite drives the real game in a real browser through real dispatched
 * events — nothing calls into the game's internals to move the worm. Variants
 * are built by rewriting constants in a *copy* of game.js, so a suite can force
 * a rare case (three max-size baguettes every time, meteors from score zero)
 * that would otherwise take a very long run to observe.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Building a variant of the game
 * ------------------------------------------------------------------ */

// Exposes internals read-only so assertions can inspect state the UI doesn't
// show. Injected only into test copies — never into the shipped game.js.
const DEBUG_HOOK = `  window.__dbg = {
    get state(){return state}, get obstacles(){return obstacles}, get worm(){return worm},
    get headX(){return headX}, get widthFactor(){return widthFactor}, get worldW(){return worldW},
    get speed(){return speed}, get score(){return score}, get culprit(){return culprit},
    get duckT(){return worm.duckT}, get wave(){return worm.wave}, get trailLen(){return trail.length},
    get spineHeadY(){return spine ? spine[0].y : null}, get spineHeadR(){return spine ? spine[0].r : null},
    get creature(){return cr()}, get creatureIndex(){return creatureIndex},
    CREATURES, creatureFits, GROUND_Y,
  };
`;

/**
 * Copy the game into a temp dir, applying `[find, replace]` pairs to game.js.
 * Every replacement is verified to have landed, so a suite fails loudly rather
 * than silently testing the unmodified game if a constant gets renamed.
 */
export function buildVariant(name, replacements = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wormrunner-${name}-`));
  for (const f of ['index.html', 'style.css']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }

  let src = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');

  const anchor = '  resize();\n  reset(false);';
  if (!src.includes(anchor)) throw new Error('harness: debug-hook anchor not found in game.js');
  src = src.replace(anchor, DEBUG_HOOK + anchor);

  for (const [find, replace] of replacements) {
    if (!src.includes(find)) {
      throw new Error(`harness: cannot patch ${name} — not found in game.js:\n  ${find}`);
    }
    src = src.split(find).join(replace);
  }

  fs.writeFileSync(path.join(dir, 'game.js'), src);
  return dir;
}

export function serve(dir) {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(req.url.split('?')[0]);
    if (file === '/') file = '/index.html';
    const full = path.join(dir, file);
    if (!full.startsWith(dir) || !fs.existsSync(full)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'text/plain' });
    res.end(fs.readFileSync(full));
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}/` }));
  });
}

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}

/**
 * Open a page and collect any console errors or uncaught exceptions. A suite
 * that passes its assertions but logged an error still fails.
 */
export async function openPage(browser, url, device) {
  const context = await browser.newContext({ deviceScaleFactor: 1, ...device });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await sleep(300);
  return { context, page, errors };
}

/*
 * Full device descriptors, not bare viewports. The touch flags matter: the
 * on-screen pads are revealed by `(hover: none) and (pointer: coarse)`, which
 * a desktop-shaped context never matches however small you make the window.
 */
export const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  phoneSmall: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1100, height: 700 } },
};

/* ------------------------------------------------------------------ *
 * The bot
 * ------------------------------------------------------------------ */

/**
 * Plays the game about as well as it can be played, so a death means the game
 * was unfair rather than that the bot was sloppy.
 *
 * The policy knobs are the interesting part: they let a suite play an obstacle
 * *wrongly* on purpose and assert that doing so is punished, which is how the
 * "ducking is mandatory" and "restraint is mandatory" rules get real teeth.
 *
 *   meteorPolicy: 'duck' (correct) | 'jump'
 *   archPolicy:   'tap'  (correct) | 'hold' | 'ignore' | 'duck'
 */
export function botScript({ meteorPolicy = 'duck', archPolicy = 'tap' } = {}) {
  return `
window.__bot = { deaths: [], maxScore: 0, jumps: 0, ducks: 0 };
const key = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
const meteorPolicy = '${meteorPolicy}';
let jumpUntil = 0, ducking = false, lastState = '';

function tick(now) {
  const d = window.__dbg;
  if (d) {
    if (d.score > window.__bot.maxScore) window.__bot.maxScore = d.score;

    if (d.state !== lastState) {
      if (d.state === 'over') {
        window.__bot.deaths.push({
          score: Math.floor(d.score),
          speed: Math.round(d.speed),
          culpritType: d.culprit ? d.culprit.type : null,
          onGround: d.worm.onGround,
          ducking: d.worm.ducking,
        });
      }
      lastState = d.state;
    }

    if (d.state === 'ready') {
      key('keydown', 'Space');
    } else if (d.state === 'over') {
      if (ducking) { key('keyup', 'ArrowDown'); ducking = false; }
      key('keydown', 'Space');
    } else {
      const ws = d.speed * d.widthFactor;
      let best = null;
      for (const o of d.obstacles) {
        const lead = o.x - d.headX;
        if (lead > -40 && (!best || lead < best.lead)) best = { o, lead };
      }
      if (best) {
        const tta = best.lead / ws;
        const kind = best.o.type;
        const archPolicy = '${archPolicy}';

        if (kind === 'arch') {
          // An arch has to be hopped, not cleared: hold and you clip the rock.
          if (archPolicy === 'duck') {
            const want = tta < 0.5 && tta > -0.3;
            if (want && !ducking) { key('keydown', 'ArrowDown'); ducking = true; window.__bot.ducks++; }
            if (!want && ducking) { key('keyup', 'ArrowDown'); ducking = false; }
          } else if (archPolicy !== 'ignore') {
            if (ducking) { key('keyup', 'ArrowDown'); ducking = false; }
            if (d.worm.onGround && tta <= 0.20 && tta > -0.05) {
              key('keydown', 'Space');
              window.__bot.jumps++;
              // 'tap' is a real tap, not a single-frame blip: ~60 ms buys a
              // taller hop with more airtime, which is what makes the loaf
              // spannable on a narrow world, while staying under the rock.
              jumpUntil = now + (archPolicy === 'hold' ? 420 : 60);
            }
          }
        } else if (kind === 'baguette' || meteorPolicy === 'jump') {
          if (ducking) { key('keyup', 'ArrowDown'); ducking = false; }
          if (d.worm.onGround && tta <= 0.24 && tta > -0.05) {
            key('keydown', 'Space');
            window.__bot.jumps++;
            jumpUntil = now + 420;      // hold for full height
          }
        } else {
          const want = tta < 0.6 && tta > -0.35;
          if (want && !ducking) { key('keydown', 'ArrowDown'); ducking = true; window.__bot.ducks++; }
          if (!want && ducking) { key('keyup', 'ArrowDown'); ducking = false; }
        }
      }
      if (jumpUntil && now > jumpUntil) { key('keyup', 'Space'); jumpUntil = 0; }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
`;
}

/**
 * Select a creature the way a player does — by clicking the picker — rather
 * than by poking `creatureIndex`. The click path is what rebuilds the resting
 * height, the trail and the spine, so a test that skipped it would be running
 * against a state the game can never actually be in.
 */
export async function pickCreature(page, index) {
  const n = await page.evaluate(() => window.__dbg.CREATURES.length);
  const start = await page.evaluate(() => window.__dbg.creatureIndex);
  const clicks = ((index - start) % n + n) % n;
  for (let i = 0; i < clicks; i++) await page.locator('#btnSkin').click();
  const now = await page.evaluate(() => window.__dbg.creatureIndex);
  if (now !== index) throw new Error(`harness: wanted creature ${index}, got ${now}`);
  return page.evaluate(() => window.__dbg.creature.name);
}

export async function runBot(browser, url, device, seconds, options = {}) {
  const { context, page, errors } = await openPage(browser, url, device);
  if (options.creature !== undefined) await pickCreature(page, options.creature);
  await page.evaluate(botScript(options));
  await sleep(seconds * 1000);
  const bot = await page.evaluate(() => window.__bot);
  const world = await page.evaluate(() => ({
    worldW: Math.round(window.__dbg.worldW),
    widthFactor: +window.__dbg.widthFactor.toFixed(3),
  }));
  await context.close();
  return { ...bot, ...world, errors };
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

export function createReporter(suiteName) {
  const rows = [];
  return {
    check(name, passed, detail = '') {
      rows.push({ name, passed, detail });
    },
    finish() {
      const failed = rows.filter((r) => !r.passed);
      console.log(`\n${suiteName}`);
      for (const r of rows) {
        console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
      }
      return failed.length;
    },
  };
}
