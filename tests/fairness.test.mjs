/*
 * The two rules that make the game fair, and the one that makes ducking real.
 *
 * These are the tests to run after touching JUMP_V, GRAVITY, SEG_SPACING,
 * HIT_PROBES, METEOR_ROCKS or any baguette dimension. All three properties are
 * derived from the jump arc rather than tuned by hand, so a change to the arc
 * silently changes what the obstacles are allowed to be — and an unwinnable
 * game still looks completely normal for the first thirty seconds.
 */
import { buildVariant, serve, launch, runBot, createReporter, VIEWPORTS } from './lib/harness.mjs';

// Every group is three loaves at maximum width and height — the worst cluster
// the spawner could ever produce, which normal play would take many minutes to
// stumble across.
const WORST_BAGUETTES = [
  ['const count = Math.random() < 0.58 ? 1 : (Math.random() < 0.7 ? 2 : 3);', 'const count = 3;'],
  ['const w = (17 + Math.random() * 9) * widthFactor;', 'const w = 26 * widthFactor;'],
  ['const h = BAGUETTE_MIN_H + Math.random() * (BAGUETTE_MAX_H - BAGUETTE_MIN_H);', 'const h = BAGUETTE_MAX_H;'],
  // Override the whole function, not the constant: meteor frequency rises with
  // score and is clamped, so zeroing METEOR_CHANCE alone still lets meteors
  // through once the score climbs.
  ['return Math.min(0.52, METEOR_CHANCE + score * 0.00004);', 'return 0;'],
];

// Meteors from the first obstacle, so the duck rules can be tested in seconds
// rather than waiting for the 260-point unlock.
const ALL_METEORS = [
  ['const METEOR_UNLOCK = 260;', 'const METEOR_UNLOCK = 0;'],
  ['return Math.min(0.52, METEOR_CHANCE + score * 0.00004);', 'return 1;'],
];

const BOTH_TYPES = [['const METEOR_UNLOCK = 260;', 'const METEOR_UNLOCK = 0;']];

const report = createReporter('fairness');
const browser = await launch();
const servers = [];

async function host(replacements) {
  const { server, url } = await serve(buildVariant('fairness', replacements));
  servers.push(server);
  return url;
}

const worstUrl = await host(WORST_BAGUETTES);
const meteorUrl = await host(ALL_METEORS);
const mixedUrl = await host(BOTH_TYPES);

const LONG = Number(process.env.LONG_RUN || 0);

async function expectSurvives(label, url, device, seconds, options) {
  const r = await runBot(browser, url, device, seconds, options);
  const detail = `deaths=${r.deaths.length} jumps=${r.jumps} ducks=${r.ducks} best=${Math.floor(r.maxScore)}`
    + (r.deaths.length ? ` killedBy=${[...new Set(r.deaths.map((d) => d.culpritType))].join(',')}` : '');
  report.check(label, r.deaths.length === 0 && r.errors.length === 0, detail);
}

async function expectDies(label, url, device, seconds, options) {
  const r = await runBot(browser, url, device, seconds, options);
  const kinds = [...new Set(r.deaths.map((d) => d.culpritType))];
  report.check(
    label,
    r.deaths.length > 0 && kinds.every((k) => k === 'meteor') && r.errors.length === 0,
    `deaths=${r.deaths.length} attempts=${r.jumps} killedBy=${kinds.join(',') || 'none'}`,
  );
}

/* Baguettes: the widest cluster the spawner can build must still be jumpable,
 * on a narrow phone world as well as a wide one. Phone is the binding case —
 * horizontal speed scales with world width, so a phone worm covers fewer units
 * per second while the worm's own body stays the same size. */
await expectSurvives('worst-case baguettes clearable, desktop', worstUrl, VIEWPORTS.desktop, LONG ? 100 : 45);
await expectSurvives('worst-case baguettes clearable, phone', worstUrl, VIEWPORTS.phone, LONG ? 100 : 45);

/* Meteors: ducking must work, and jumping must not. The second assertion is
 * the one with teeth — it is the difference between ducking being required and
 * ducking being decorative, and it silently regresses the moment the jump arc
 * clears the top of the shower. */
await expectSurvives('meteor showers cleared by ducking, desktop', meteorUrl, VIEWPORTS.desktop, 45);
await expectSurvives('meteor showers cleared by ducking, phone', meteorUrl, VIEWPORTS.phone, 45);
await expectDies('meteor showers are NOT jumpable, desktop', meteorUrl, VIEWPORTS.desktop, 30, { meteorPolicy: 'jump' });
await expectDies('meteor showers are NOT jumpable, phone', meteorUrl, VIEWPORTS.phone, 30, { meteorPolicy: 'jump' });

/* Both types interleaved. With LONG_RUN=1 this passes the point where speed
 * hits its cap, which is where gaps get tightest. */
await expectSurvives('mixed obstacles survivable, desktop', mixedUrl, VIEWPORTS.desktop, LONG ? 130 : 50);
await expectSurvives('mixed obstacles survivable, phone', mixedUrl, VIEWPORTS.phone, LONG ? 130 : 50);

await browser.close();
for (const s of servers) s.close();
process.exit(report.finish() ? 1 : 0);
