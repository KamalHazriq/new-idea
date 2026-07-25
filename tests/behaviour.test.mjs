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

report.check('no console or page errors', allErrors.length === 0, allErrors.slice(0, 2).join(' | '));

await browser.close();
for (const s of servers) s.close();
process.exit(report.finish() ? 1 : 0);
