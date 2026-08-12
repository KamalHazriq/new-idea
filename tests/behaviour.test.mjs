/*
 * The things a player touches: controls appearing on the right devices, the
 * score running, dying, restarting, and the death pose holding still.
 *
 * The freeze assertions exist because the hitstop's whole job is to make the
 * impact frame readable. An earlier version left the worm animating underneath
 * it, so a worm killed while flat inflated to full standing height during the
 * exact frames the player was trying to read — invisible to any test that only
 * checked "did it say GAME OVER".
 */
import { buildVariant, serve, launch, openPage, sleep, createReporter, VIEWPORTS } from './lib/harness.mjs';

const report = createReporter('behaviour');
const browser = await launch();
const servers = [];

async function host(replacements = []) {
  const { server, url } = await serve(buildVariant('behaviour', replacements));
  servers.push(server);
  return url;
}

const plainUrl = await host();
// Baguettes only, so the worm can be killed while ducked: a flattened worm
// still collides with a loaf, which is the pose the freeze test needs.
const bagUrl = await host([['return Math.min(0.52, METEOR_CHANCE + score * 0.00004);', 'return 0;']]);
// An empty world, so jump mechanics can be measured without an obstacle ever
// interrupting or killing the worm mid-trial.
const emptyUrl = await host([['if (spawnGap <= 0) spawnObstacle();', 'if (spawnGap <= 0) spawnGap = 1e9;']]);
// Same empty world, but with the buffer shrunk to under a single frame. At its
// real 130 ms there is always time left over on the landing frame, so both a
// correct and an incorrect implementation fire and the ordering is invisible;
// shrunk, the ordering is the only thing that decides.
const microUrl = await host([
  ['if (spawnGap <= 0) spawnObstacle();', 'if (spawnGap <= 0) spawnGap = 1e9;'],
  ['const JUMP_BUFFER = 0.13;', 'const JUMP_BUFFER = 0.001;'],
]);

const allErrors = [];

/* ---------- layout: the right controls on the right device ---------- */
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.phone);
  report.check('touch pads shown on a phone',
    await page.locator('#btnJump').isVisible() && await page.locator('#btnDuck').isVisible());
  report.check('keyboard hint hidden on a phone', !(await page.locator('.legend').isVisible()));
  report.check('colour and mute controls present',
    await page.locator('#btnSkin').isVisible() && await page.locator('#btnMute').isVisible());
  allErrors.push(...errors);
  await context.close();
}
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  report.check('touch pads hidden on desktop', !(await page.locator('#btnJump').isVisible()));
  report.check('keyboard hint shown on desktop', await page.locator('.legend').isVisible());
  allErrors.push(...errors);
  await context.close();
}

/* ---------- a full run: start, score, die, restart ---------- */
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  report.check('ready overlay shown', (await page.locator('#overlayTitle').textContent()).includes('Worm Runner'));

  await page.keyboard.press('Space');
  await sleep(300);
  report.check('overlay clears on start',
    await page.locator('#overlay').evaluate((e) => e.classList.contains('hidden')));

  await sleep(2500);
  const score = parseInt(await page.locator('#score').textContent(), 10);
  report.check('score advances', score > 0, `score=${score}`);

  // Stand still: a baguette arrives soon enough.
  await sleep(9000);
  const title = await page.locator('#overlayTitle').textContent();
  report.check('collision ends the run', /GAME OVER|NEW BEST/.test(title), `overlay="${title}"`);

  const hi = parseInt((await page.locator('#hiScore').textContent()).replace(/\D/g, ''), 10);
  report.check('high score recorded', hi > 0, `hi=${hi}`);

  await sleep(600);
  await page.keyboard.press('Space');
  await sleep(400);
  report.check('restart works',
    await page.locator('#overlay').evaluate((e) => e.classList.contains('hidden')));
  allErrors.push(...errors);
  await context.close();
}

/* ---------- colour selection persists ---------- */
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  const first = await page.locator('#swatch').evaluate((e) => e.style.background);
  await page.locator('#btnSkin').click();
  const second = await page.locator('#swatch').evaluate((e) => e.style.background);
  report.check('colour button changes the worm', first !== second);

  await page.reload({ waitUntil: 'networkidle' });
  await sleep(300);
  const afterReload = await page.locator('#swatch').evaluate((e) => e.style.background);
  report.check('colour choice survives a reload', afterReload === second);
  allErrors.push(...errors);
  await context.close();
}

/* ---------- the death pose must hold ---------- */
{
  const { context, page, errors } = await openPage(browser, bagUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(300);
  await page.keyboard.down('ArrowDown');       // stay flat and let a loaf hit us

  let atDeath = null;
  for (let i = 0; i < 400; i++) {
    const s = await page.evaluate(() => ({ ...window.__dbg }));
    if (s.state === 'over') { atDeath = s; break; }
    await sleep(25);
  }
  await page.keyboard.up('ArrowDown');

  report.check('died while ducked', !!atDeath && atDeath.duckT > 0.7,
    atDeath ? `duckT=${atDeath.duckT.toFixed(3)}` : 'never died');

  if (atDeath) {
    await sleep(600);                          // past both the hitstop and the flash
    const after = await page.evaluate(() => ({ ...window.__dbg }));
    report.check('duck pose held through the hitstop', Math.abs(after.duckT - atDeath.duckT) < 1e-9,
      `${atDeath.duckT.toFixed(4)} -> ${after.duckT.toFixed(4)}`);
    report.check('wriggle frozen on death', after.wave === atDeath.wave,
      `${atDeath.wave.toFixed(3)} -> ${after.wave.toFixed(3)}`);
    report.check('body geometry frozen on death',
      after.spineHeadY === atDeath.spineHeadY && after.spineHeadR === atDeath.spineHeadR);

    // The trail buffer is trimmed against a cutoff derived from distance
    // travelled. At a standstill that cutoff stops moving, so anything still
    // appending grows without bound.
    await sleep(3000);
    const idle = await page.evaluate(() => ({ ...window.__dbg }));
    report.check('trail buffer does not grow while dead', idle.trailLen === atDeath.trailLen,
      `${atDeath.trailLen} -> ${idle.trailLen}`);

    await page.keyboard.press('Space');
    await sleep(500);
    const live = await page.evaluate(() => ({ ...window.__dbg }));
    report.check('restart resumes animation', live.state === 'running' && live.wave !== after.wave);
  }
  allErrors.push(...errors);
  await context.close();
}

/* ---------- a jump pressed just before landing must still fire ---------- *
 * Timed from inside the page: the window under test is ~130 ms and driving it
 * from Node would be far too coarse.
 *
 * Press height is swept deliberately. A press made just before touchdown leaves
 * most of the buffer intact and survives almost any implementation — so testing
 * only that proves nothing. The interesting presses are the early ones, where
 * the buffer has a few milliseconds left on the landing frame: less than one
 * frame's dt, so an implementation that ages the buffer before spending it
 * drops exactly those. Heights up to ~66 units correspond to ~120 ms of fall,
 * which lands in that band; beyond that the press is genuinely too early and is
 * *supposed* to expire.
 *
 * The signal is indirect but unambiguous: a buffer that fires does so on the
 * same frame as the landing, so the worm goes straight back up and is never
 * seen on the ground. A dropped buffer leaves it sitting there. */
{
  const { context, page, errors } = await openPage(browser, emptyUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(400);

  const trials = await page.evaluate(() => new Promise((resolve) => {
    const HEIGHTS = [16, 34, 50, 60, 66, 66, 62, 58];   // units above standing rest
    const results = [];
    const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', bubbles: true }));
    let phase = 'idle';
    let pressAt = 0;
    let pressHeight = 0;
    const started = performance.now();

    function tick(now) {
      if (now - started > 20000) return resolve(results);   // never hang the suite
      const d = window.__dbg;
      const w = d.worm;
      const standY = d.GROUND_Y - 22;

      if (d.state !== 'running') { requestAnimationFrame(tick); return; }

      if (phase === 'idle') {
        // keydown only. Releasing straight away would trigger the early-release
        // jump cut, capping the apex near 23 units — well under the heights this
        // sweep needs to reach, which would quietly neuter the whole test.
        if (w.onGround) { key('keydown'); phase = 'rising'; }
      } else if (phase === 'rising') {
        if (!w.onGround && w.vy > 0 && standY - w.y < HEIGHTS[results.length]) {
          pressHeight = standY - w.y;
          key('keydown');
          key('keyup');
          pressAt = now;
          phase = 'watch';
        }
      } else if (phase === 'watch') {
        if (now - pressAt > 260) {
          results.push({ height: +pressHeight.toFixed(1), airborne: !w.onGround });
          phase = results.length < HEIGHTS.length ? 'settle' : 'done';
        }
      } else if (phase === 'settle') {
        // Wait for a genuine standing rest. Straight after a duck the worm sits
        // ~12 units low and would re-land instantly, stalling the next trial.
        if (w.onGround && !w.ducking && Math.abs(standY - w.y) < 1) phase = 'idle';
      }

      if (phase === 'done') return resolve(results);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }));

  const fired = trials.filter((t) => t.airborne).length;
  report.check('early jump press survives until landing',
    trials.length >= 6 && fired === trials.length,
    `${fired}/${trials.length} fired, from heights ${trials.map((t) => t.height).join(', ')}`);
  allErrors.push(...errors);
  await context.close();
}

/* ---------- the buffer must be spent before it is aged ---------- *
 * The assertion above proves buffering works; it does not pin down *when* the
 * buffer is expired relative to being spent, because at 130 ms there is always
 * slack left on the landing frame and both orderings fire.
 *
 * With the buffer shrunk to under one frame, only the correct ordering can ever
 * fire: a press made on the last airborne frame is still live when the landing
 * check runs, but is already zero if the buffer was aged first. Pressing on
 * every airborne frame guarantees a press lands in that final frame, so a
 * correct build bounces continuously and is essentially never seen on the
 * ground, while an incorrect one lands once and stays there. */
{
  const { context, page, errors } = await openPage(browser, microUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(400);

  const r = await page.evaluate(() => new Promise((resolve) => {
    let seenAir = false;
    let frames = 0;
    let grounded = 0;
    const started = performance.now();

    function tick(now) {
      const d = window.__dbg;
      const w = d.worm;
      if (d.state === 'running') {
        if (!w.onGround) {
          seenAir = true;
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        } else if (!seenAir) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        }
        if (seenAir) { frames++; if (w.onGround) grounded++; }
      }
      if (now - started > 2500) return resolve({ frames, grounded });
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }));

  report.check('a buffer still live on the landing frame is spent, not aged out',
    r.frames > 30 && r.grounded <= r.frames * 0.1,
    `grounded on ${r.grounded}/${r.frames} frames`);
  allErrors.push(...errors);
  await context.close();
}

/* ---------- ...but a duck must override it ---------- *
 * Ducking in mid-air is the fast-fall, so "buffer a jump, spot a shower, hold
 * duck to get down early" is exactly how a player reacts to a shower. If the
 * buffered jump still fires on landing it launches them into the thing they
 * ducked for, which is worse than having dropped the input in the first place. */
{
  const { context, page, errors } = await openPage(browser, emptyUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(400);

  const trials = await page.evaluate(() => new Promise((resolve) => {
    const results = [];
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    let phase = 'idle';
    let pressAt = 0;
    const started = performance.now();

    function tick(now) {
      if (now - started > 20000) return resolve(results);
      const d = window.__dbg;
      const w = d.worm;
      const standY = d.GROUND_Y - 22;

      if (d.state !== 'running') { requestAnimationFrame(tick); return; }

      if (phase === 'idle') {
        if (w.onGround) { key('keydown', 'Space'); phase = 'rising'; }
      } else if (phase === 'rising') {
        if (!w.onGround && w.vy > 0 && standY - w.y < 60) {
          key('keydown', 'Space');            // buffer a jump…
          key('keyup', 'Space');
          key('keydown', 'ArrowDown');        // …then commit to ducking instead
          pressAt = now;
          phase = 'watch';
        }
      } else if (phase === 'watch') {
        if (now - pressAt > 300) {
          results.push({ grounded: w.onGround, ducking: w.ducking });
          key('keyup', 'ArrowDown');
          phase = results.length < 4 ? 'settle' : 'done';
        }
      } else if (phase === 'settle') {
        if (w.onGround && !w.ducking && Math.abs(standY - w.y) < 1) phase = 'idle';
      }

      if (phase === 'done') return resolve(results);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }));

  const stayedDown = trials.filter((t) => t.grounded).length;
  report.check('holding duck cancels a buffered jump',
    trials.length >= 4 && stayedDown === trials.length,
    `${stayedDown}/${trials.length} stayed down`);
  allErrors.push(...errors);
  await context.close();
}

/* ---------- a buffered tap is still a tap ---------- *
 * Height control is a real mechanic: hold for a full jump, release early for a
 * short hop. A buffered press must respect it. It nearly didn't — the release
 * arrives while the worm is falling, where the cut is a no-op, so the jump that
 * fires on landing would come out full height however briefly the key was
 * touched. That takes height control away in exactly the moment buffering was
 * added to help, and can throw the player higher than they asked for.
 *
 * Measured, not inferred: apex height after the buffered jump launches. */
{
  const { context, page, errors } = await openPage(browser, emptyUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(400);

  const apexOf = (mode) => page.evaluate((m) => new Promise((resolve) => {
    const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', bubbles: true }));
    let phase = 'idle';
    let pressAt = 0;
    let launched = false;
    let apex = 0;
    const started = performance.now();

    function tick(now) {
      if (now - started > 8000) return resolve(null);
      const d = window.__dbg;
      const w = d.worm;
      const standY = d.GROUND_Y - 22;
      if (d.state !== 'running') { requestAnimationFrame(tick); return; }

      if (phase === 'idle') {
        if (w.onGround && !w.ducking && Math.abs(standY - w.y) < 1) { key('keydown'); phase = 'rising'; }
      } else if (phase === 'rising') {
        if (!w.onGround && w.vy > 0 && standY - w.y < 40) {
          key('keyup');                       // let go of the opening jump
          key('keydown');                     // buffer a new one
          if (m === 'tap') key('keyup');      // …and immediately release it
          pressAt = now;
          phase = 'measure';
        }
      } else if (phase === 'measure') {
        if (w.vy < 0) launched = true;        // the buffered jump has fired
        if (launched) apex = Math.max(apex, standY - w.y);
        if (now - pressAt > 900) { if (m !== 'tap') key('keyup'); return resolve(apex); }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }), mode);

  const tapApex = await apexOf('tap');
  const holdApex = await apexOf('hold');

  report.check('a buffered tap stays a short hop, a buffered hold goes full height',
    tapApex !== null && holdApex !== null && tapApex < 50 && holdApex > 90,
    `tap apex ${tapApex === null ? 'n/a' : tapApex.toFixed(1)}, hold apex ${holdApex === null ? 'n/a' : holdApex.toFixed(1)}`);
  allErrors.push(...errors);
  await context.close();
}

/* ---------- pause actually stops the world ---------- */
{
  const { context, page, errors } = await openPage(browser, emptyUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(1200);

  await page.keyboard.press('KeyP');
  await sleep(150);
  const title = await page.locator('#overlayTitle').textContent();
  report.check('P shows the paused overlay', title === 'PAUSED', `overlay="${title}"`);

  const before = await page.evaluate(() => ({
    score: Math.floor(window.__dbg.score),
    wave: window.__dbg.wave,
  }));
  await sleep(1000);
  const after = await page.evaluate(() => ({
    score: Math.floor(window.__dbg.score),
    wave: window.__dbg.wave,
  }));
  report.check('the world is frozen while paused',
    after.score === before.score && after.wave === before.wave,
    `score ${before.score}->${after.score}, wave ${before.wave.toFixed(2)}->${after.wave.toFixed(2)}`);

  await page.keyboard.press('KeyP');
  await sleep(600);
  const live = await page.evaluate(() => ({
    score: Math.floor(window.__dbg.score),
    hidden: document.getElementById('overlay').classList.contains('hidden'),
  }));
  report.check('unpausing resumes', live.hidden && live.score > after.score,
    `score ${after.score}->${live.score}`);
  allErrors.push(...errors);
  await context.close();
}

/* ---------- one input releasing must not cut another's jump ---------- *
 * Three things can press jump: the keyboard, the JUMP pad and a tap on the
 * canvas. Held state used to be a single boolean, so releasing any one of them
 * cleared it — and a jump the player was still holding on the keyboard came out
 * cut because a stray canvas tap had ended. Here Space is held throughout while
 * a canvas tap begins and ends mid-fall; the buffered jump must still be full
 * height. */
{
  const { context, page, errors } = await openPage(browser, emptyUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(400);

  const apex = await page.evaluate(() => new Promise((resolve) => {
    const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', bubbles: true }));
    const stage = document.getElementById('stage');
    const tap = (type) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch' }));
    let phase = 'idle';
    let launched = false;
    let peak = 0;
    let pressAt = 0;
    const started = performance.now();

    function tick(now) {
      if (now - started > 8000) return resolve(null);
      const d = window.__dbg;
      const w = d.worm;
      const standY = d.GROUND_Y - 22;
      if (d.state !== 'running') { requestAnimationFrame(tick); return; }

      if (phase === 'idle') {
        if (w.onGround && Math.abs(standY - w.y) < 1) { key('keydown'); phase = 'rising'; }
      } else if (phase === 'rising') {
        if (!w.onGround && w.vy > 0 && standY - w.y < 40) {
          // Space stays down the whole time. A canvas tap arrives and leaves.
          tap('pointerdown');
          tap('pointerup');
          pressAt = now;
          phase = 'measure';
        }
      } else if (phase === 'measure') {
        if (w.vy < 0) launched = true;
        if (launched) peak = Math.max(peak, standY - w.y);
        if (now - pressAt > 900) { key('keyup'); return resolve(peak); }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }));

  report.check('a canvas tap ending does not cut a held keyboard jump',
    apex !== null && apex > 90, `apex ${apex === null ? 'n/a' : apex.toFixed(1)} (cut would be ~21)`);
  allErrors.push(...errors);
  await context.close();
}

report.check('no console or page errors', allErrors.length === 0, allErrors.slice(0, 2).join(' | '));

await browser.close();
for (const s of servers) s.close();
process.exit(report.finish() ? 1 : 0);
