/*
 * The creature roster.
 *
 * Picking a creature is not a reskin. Each one carries its own collision
 * dimensions — head radius, standing height, ducking height — and every
 * fairness rule in the game is derived from those numbers together with the
 * jump arc. A creature whose dimensions fall outside the envelope doesn't merely
 * look different: it quietly plays a different game, one where ducking is
 * optional or an arch is impossible, and nothing about it looks wrong on screen.
 *
 * So there are two kinds of assertion here. The envelope check is arithmetic
 * over every entry in the roster and catches a bad creature the moment it is
 * added. The bot runs then prove the arithmetic was actually about the right
 * thing, by playing the extremes of the roster for real.
 */
import {
  buildVariant, serve, launch, openPage, runBot, pickCreature,
  sleep, createReporter, VIEWPORTS,
} from './lib/harness.mjs';

const ALL_TYPES = [
  ['const METEOR_UNLOCK = 260;', 'const METEOR_UNLOCK = 0;'],
  ['const ARCH_UNLOCK = 600;', 'const ARCH_UNLOCK = 0;'],
];

const ALL_METEORS = [
  ['const METEOR_UNLOCK = 260;', 'const METEOR_UNLOCK = 0;'],
  ['return Math.min(0.52, METEOR_CHANCE + score * 0.00004);', 'return 1;'],
];

const report = createReporter('creatures');
const browser = await launch();
const servers = [];

async function host(replacements = []) {
  const { server, url } = await serve(buildVariant('creatures', replacements));
  servers.push(server);
  return url;
}

const plainUrl = await host();
const mixedUrl = await host(ALL_TYPES);
const meteorUrl = await host(ALL_METEORS);
// An empty world. Measuring the live body takes a while per creature, and a
// bot-free run through a normal world dies to a baguette long before the roster
// is done — after which the death freeze holds the pose, so every later reading
// is stale rather than wrong-looking.
const emptyUrl = await host([['if (spawnGap <= 0) spawnObstacle();', 'if (spawnGap <= 0) spawnGap = 1e9;']]);

const allErrors = [];

/* ---------- every creature is inside the fairness envelope ---------- *
 * `creatureFits()` is the game's own statement of what its rules require of a
 * body. Running it here rather than duplicating the arithmetic means the test
 * cannot drift away from the rules it is guarding: change the jump and this
 * check changes with it. */
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  const roster = await page.evaluate(() => window.__dbg.CREATURES.map((c) => ({
    name: c.name,
    plan: c.plan,
    fits: window.__dbg.creatureFits(c),
  })));

  report.check('the roster is not empty', roster.length >= 2, `${roster.length} creatures`);

  for (const { name, fits } of roster) {
    const broken = Object.entries(fits).filter(([, ok]) => !ok).map(([rule]) => rule);
    report.check(`${name} is inside the fairness envelope`, broken.length === 0, broken.join(', '));
  }

  // A roster of one body plan would pass everything above while quietly having
  // lost the feature: the hopper is the whole point of "different body plans".
  const plans = [...new Set(roster.map((c) => c.plan))];
  report.check('more than one body plan is in the roster', plans.length >= 2, plans.join(', '));

  allErrors.push(...errors);
  await context.close();
}

/* ---------- the envelope measures the body the game actually collides with ---------- *
 * `creatureFits()` is only worth anything if its idea of the hitbox is the real
 * one. It computes the head radius from the roster; the game builds it in
 * `creatureSpine()` (where the head bulges past headR) and shrinks it in
 * `hitFrom()`. Those are three separate places, and an envelope that quietly
 * drops one of the factors understates every creature and loosens every rule
 * derived from it — while still reporting that the whole roster fits.
 *
 * So compare them directly, standing and ducked, against the live spine. */
{
  const { context, page, errors } = await openPage(browser, emptyUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(500);

  const count = await page.evaluate(() => window.__dbg.CREATURES.length);
  const rows = [];

  // `state` comes back with every sample. A dead or paused game freezes the
  // spine, and a frozen spine reads as a plausible-but-stale radius — exactly
  // the kind of quiet pass this test exists to prevent.
  const sample = (ducked) => page.evaluate((d0) => {
    const d = window.__dbg;
    return {
      name: d.creature.name,
      state: d.state,
      duckT: d.duckT,
      live: d.spineHeadR * d.HIT_SHRINK,
      envelope: d.headHitR(d.creature, d0),
    };
  }, ducked);

  for (let i = 0; i < count; i++) {
    await pickCreature(page, i);
    await sleep(150);
    const standing = await sample(false);

    await page.keyboard.down('ArrowDown');
    await sleep(400);                       // let duckT reach 1
    const ducked = await sample(true);
    await page.keyboard.up('ArrowDown');
    await sleep(400);

    rows.push({ standing, ducked });
  }

  for (const { standing, ducked } of rows) {
    report.check(`${standing.name}: the envelope's standing hitbox is the real one`,
      standing.state === 'running' && standing.duckT < 0.01
        && Math.abs(standing.live - standing.envelope) < 0.01,
      `state=${standing.state} duckT=${standing.duckT.toFixed(2)} live=${standing.live.toFixed(3)} envelope=${standing.envelope.toFixed(3)}`);
    report.check(`${standing.name}: the envelope's ducked hitbox is the real one`,
      ducked.state === 'running' && ducked.duckT > 0.99
        && Math.abs(ducked.live - ducked.envelope) < 0.01,
      `state=${ducked.state} duckT=${ducked.duckT.toFixed(2)} live=${ducked.live.toFixed(3)} envelope=${ducked.envelope.toFixed(3)}`);
  }

  allErrors.push(...errors);
  await context.close();
}

/* ---------- each creature actually draws as itself ---------- *
 * The envelope check is blind to rendering, and a decoration that silently
 * fails to paint — drawn behind the body, or off-screen — looks exactly like a
 * creature that was never selected. Sample the pixels where the head is and
 * require the creature's own body colour to be there. */
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(600);

  const count = await page.evaluate(() => window.__dbg.CREATURES.length);
  const results = [];

  for (let i = 0; i < count; i++) {
    await pickCreature(page, i);
    await sleep(180);                      // a couple of frames to redraw
    results.push(await page.evaluate(() => {
      const d = window.__dbg;
      const c = d.creature;
      const canvas = document.getElementById('game');
      const scale = canvas.width / d.worldW;
      // A box around the head, entirely above the ground line so the road
      // cannot contribute pixels.
      const x0 = Math.round((d.headX - 26) * scale);
      const y0 = Math.round((d.worm.y - 18) * scale);
      const w = Math.round(44 * scale);
      const h = Math.round(34 * scale);
      const px = canvas.getContext('2d').getImageData(x0, y0, w, h).data;

      // The rainbow worm has no single body colour; its own gradient is the
      // point, so ask only that the box is not flat background.
      if (!c.body) {
        const seen = new Set();
        for (let p = 0; p < px.length; p += 4) seen.add(`${px[p] >> 4},${px[p + 1] >> 4},${px[p + 2] >> 4}`);
        return { name: c.name, metric: seen.size, kind: 'variety' };
      }

      const want = [1, 3, 5].map((k) => parseInt(c.body.slice(k, k + 2), 16));
      let near = 0;
      for (let p = 0; p < px.length; p += 4) {
        const dr = px[p] - want[0], dg = px[p + 1] - want[1], db = px[p + 2] - want[2];
        if (dr * dr + dg * dg + db * db < 60 * 60) near++;
      }
      return { name: c.name, metric: near, kind: 'bodyPixels' };
    }));
  }

  for (const r of results) {
    const ok = r.kind === 'variety' ? r.metric >= 6 : r.metric >= 200;
    report.check(`${r.name} is drawn on the canvas`, ok, `${r.kind}=${r.metric}`);
  }

  allErrors.push(...errors);
  await context.close();
}

/* ---------- switching creature rebuilds the body, not just the colour ---------- *
 * Creatures stand at different heights, and the body's shape comes from a trail
 * of past head positions. Swap creature without rebuilding that trail and the
 * head jumps to the new height while the body behind it keeps replaying the old
 * one — a visibly broken, floating or sunken creature that lasts until enough
 * distance has been travelled to flush the buffer. */
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  await page.keyboard.press('Space');
  await sleep(700);

  const roster = await page.evaluate(() => window.__dbg.CREATURES.map((c) => c.standH));
  const shortest = roster.indexOf(Math.min(...roster));
  const tallest = roster.indexOf(Math.max(...roster));

  const sample = async (index) => {
    await pickCreature(page, index);
    await sleep(120);
    return page.evaluate(() => {
      const d = window.__dbg;
      return {
        name: d.creature.name,
        standH: d.creature.standH,
        headR: d.creature.headR,
        wantY: d.GROUND_Y - d.creature.standH,
        y: d.worm.y,
        spineY: d.spineHeadY,
        spineR: d.spineHeadR,
      };
    });
  };

  const a = await sample(tallest);
  const b = await sample(shortest);

  report.check('the two ends of the roster are meaningfully different heights',
    Math.abs(a.standH - b.standH) >= 3, `${a.name} ${a.standH} vs ${b.name} ${b.standH}`);

  for (const s of [a, b]) {
    report.check(`${s.name} stands at its own height after a switch`,
      Math.abs(s.y - s.wantY) < 1, `y=${s.y.toFixed(1)} want=${s.wantY}`);
    // The head sample is read back out of the trail buffer, so a stale buffer
    // shows up here as the previous creature's height.
    report.check(`${s.name}'s body follows the head after a switch`,
      Math.abs(s.spineY - s.wantY) < 2, `spineY=${s.spineY.toFixed(1)} want=${s.wantY}`);
    report.check(`${s.name}'s body takes its own thickness after a switch`,
      Math.abs(s.spineR - s.headR * 1.05) < 0.2, `r=${s.spineR.toFixed(2)} want=${(s.headR * 1.05).toFixed(2)}`);
  }

  allErrors.push(...errors);
  await context.close();
}

/* ---------- the choice persists ---------- */
{
  const { context, page, errors } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  const count = await page.evaluate(() => window.__dbg.CREATURES.length);

  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(await page.evaluate(() => window.__dbg.creature.name));
    await page.locator('#btnSkin').click();
  }
  report.check('the picker cycles every creature exactly once',
    new Set(names).size === count, names.join(' → '));
  report.check('the picker wraps back to the start',
    (await page.evaluate(() => window.__dbg.creature.name)) === names[0]);

  await pickCreature(page, count - 1);
  const chosen = await page.evaluate(() => window.__dbg.creature.name);
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(300);
  report.check('the chosen creature survives a reload',
    (await page.evaluate(() => window.__dbg.creature.name)) === chosen, chosen);

  allErrors.push(...errors);
  await context.close();
}

/* ---------- the extremes of the roster really play ---------- *
 * Arithmetic says every creature fits. These runs say the arithmetic was about
 * the right thing, by playing the two creatures that sit closest to an edge of
 * the envelope through all three obstacle types.
 *
 * The hopper is picked by name because it is the one with a different body plan
 * — a compact three-sample spine and its own renderer — so it is the entry most
 * likely to break something the tube creatures share. */
async function survives(label, index, url, device, seconds) {
  const r = await runBot(browser, url, device, seconds, { creature: index });
  const detail = `deaths=${r.deaths.length} jumps=${r.jumps} ducks=${r.ducks} best=${Math.floor(r.maxScore)}`
    + (r.deaths.length ? ` killedBy=${[...new Set(r.deaths.map((d) => d.culpritType))].join(',')}` : '');
  report.check(label, r.deaths.length === 0 && r.errors.length === 0, detail);
}

const subject = await (async () => {
  const { context, page } = await openPage(browser, plainUrl, VIEWPORTS.desktop);
  const list = await page.evaluate(() => window.__dbg.CREATURES.map((c) => ({
    name: c.name, plan: c.plan, standH: c.standH, headR: c.headR,
  })));
  await context.close();

  // How high the top of a creature's hitbox gets. The collision radius shrinks
  // inward from the drawn body, so it *subtracts*: a big head sitting low
  // reaches less far than a small head sitting high. This is the creature
  // closest to clearing a shower and to clipping the arch rock.
  const reachOf = (c) => c.standH - c.headR * 0.8;
  const argmax = (score, skip = -1) => list.reduce(
    (best, c, i) => (i !== skip && (best < 0 || score(c) > score(list[best])) ? i : best), -1);

  const hopper = Math.max(0, list.findIndex((c) => c.plan === 'hopper'));
  let reach = argmax(reachOf);
  // Keep the two subjects distinct — playing the same creature twice buys
  // nothing but a minute of wall clock.
  if (reach === hopper) reach = argmax(reachOf, hopper);
  return { list, hopper, reach };
})();

const hopperName = subject.list[subject.hopper].name;
const reachName = subject.list[subject.reach].name;

await survives(`${hopperName} clears all three obstacle types, desktop`,
  subject.hopper, mixedUrl, VIEWPORTS.desktop, 40);
// Phone is the binding device: horizontal speed scales with world width but the
// creature's own footprint does not, so it has the least room to work with.
await survives(`${hopperName} clears all three obstacle types, phone`,
  subject.hopper, mixedUrl, VIEWPORTS.phone, 40);
await survives(`${reachName} clears all three obstacle types, phone`,
  subject.reach, mixedUrl, VIEWPORTS.phone, 40);

/* Ducking has to stay mandatory for every body, not just the one the showers
 * were built against. The creature whose hitbox reaches highest is the one
 * whose jump comes closest to the top of a shower, so it is where this rule
 * fails first. */
{
  const r = await runBot(browser, meteorUrl, VIEWPORTS.desktop, 20,
    { creature: subject.reach, meteorPolicy: 'jump' });
  const kinds = [...new Set(r.deaths.map((d) => d.culpritType))];
  report.check(`meteor showers are NOT jumpable as the ${reachName}`,
    r.deaths.length > 0 && kinds.every((k) => k === 'meteor') && r.errors.length === 0,
    `deaths=${r.deaths.length} killedBy=${kinds.join(',') || 'none'}`);
}

report.check('no console or page errors', allErrors.length === 0, allErrors.slice(0, 2).join(' | '));

await browser.close();
for (const s of servers) s.close();
process.exit(report.finish() ? 1 : 0);
