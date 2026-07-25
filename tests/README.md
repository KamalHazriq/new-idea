# Tests

```sh
npm install          # Playwright — a dev dependency only, the game ships without it
npx playwright install chromium
npm test             # ~9 minutes
npm run test:long    # ~12 minutes; runs past the point where speed hits its cap
```

Every suite drives the **real game in a real browser through real dispatched
events**. Nothing calls into the game's internals to move the worm, so a passing
run means the game is actually playable, not that its functions return the
right values.

## Why these exist

Three properties of this game are derived from the jump arc rather than tuned by
hand, and all of them fail silently:

- **Baguette clusters must always be clearable.** Cluster width is capped by
  what the jump can carry, computed in `clearableSpan()`.
- **Meteor showers must never be jumpable.** They're built tall enough to reach
  past the top of the arc, which is the only reason ducking is a real mechanic
  rather than decoration.
- **Arches must punish all three wrong answers.** Ignore, duck, or hold the jump
  — each has to be fatal, or the obstacle isn't asking anything.

Change `JUMP_V`, `GRAVITY`, `SEG_SPACING`, `HIT_PROBES`, `METEOR_ROCKS`, an
`ARCH_*` height or any baguette dimension and you change all of them — in ways
you will not notice by playing
for a minute, because an unfair cluster or a jumpable shower appears rarely and
looks entirely normal when it does. **Run `npm test` after touching any of
those.**

## Suites

| File | Guards |
| --- | --- |
| `fairness.test.mjs` | The rules above. A bot plays near-perfectly, so a death means the game was unfair rather than that the bot was sloppy. |
| `behaviour.test.mjs` | Controls appearing per device, score, death, restart, colour persistence, and that the death pose actually freezes. |

The sharpest assertion is **"meteor showers are NOT jumpable"**, which plays
meteors *wrongly* on purpose and requires that to be fatal. It's the difference
between ducking being required and ducking being optional — and it's exactly
what regresses if the jump gets stronger or the shower gets shorter.

## How variants work

`buildVariant()` copies the game to a temp directory and rewrites constants in
the copy — so a suite can force a case that would otherwise take many minutes to
observe (every cluster three max-size loaves; meteors from score zero). Each
replacement is verified to have landed, so a renamed constant fails the suite
loudly instead of quietly testing the unmodified game.

It also injects a read-only `window.__dbg` for inspecting state the UI doesn't
show. That hook exists **only in test copies** — never in the shipped `game.js`.

## Notes

- Suites run sequentially. They're timing-sensitive, and sharing a machine with
  each other makes them flaky.
- Set `CHROMIUM_PATH` to use a Chromium that Playwright didn't install.
- CI runs the whole suite on every push and pull request.
- These are real-time browser tests, so they are not perfectly deterministic. A
  lone failure in a bot run is worth re-running once before believing it; a
  repeatable one is real. The assertions are deliberately coarse (zero deaths
  across dozens of obstacles, not exact frame counts) to keep that rare.
