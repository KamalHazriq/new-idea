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
        if (w.onGround) { key('keydown'); key('keyup'); phase = 'rising'; }
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
        if (w.onGround) phase = 'idle';
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

report.check('no console or page errors', allErrors.length === 0, allErrors.slice(0, 2).join(' | '));

await browser.close();
for (const s of servers) s.close();
process.exit(report.finish() ? 1 : 0);
