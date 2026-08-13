# Worm Runner 🪱

An endless runner in the spirit of the Chrome dino game — except you're a worm,
the cacti are baguettes, and the bird is a meteor shower. Or you're a snake, an
eel, a dragon or a frog; there are seven of them.

**Jump the baguettes. Duck the meteors. Hop the arches — don't clear them.**

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Jump | `Space` / `↑` / `W` | **JUMP** pad |
| Duck | `↓` / `S` | **DUCK** pad |
| Start / restart | `Space` / `Enter` / `R` | tap anywhere |
| Pause | `P` / `Esc` | ⏸ button |

Holding jump goes higher; releasing early cuts the arc short. Ducking in mid-air
drops you fast. A jump pressed just before you land still counts — it's held
briefly and spent the moment you touch down, so a slightly early press isn't
silently thrown away.

Two toggles sit in the corner. The **swatch** cycles the creature. The **🔊**
mutes sound. Both remember your choice. Audio is only ever constructed after you
press something, so the page is silent until you actually start a run.

## Creatures

Seven of them, cycled with the swatch: worm, rainbow worm, snake, caterpillar,
eel, dragon and frog. They aren't recolours — each carries its own head radius,
standing height, ducking height, segment count, spacing, wave amplitude and
taper, so a snake genuinely slithers more than a caterpillar humps along, and
the frog is a different body plan entirely: three fat spine samples and its own
renderer, squashing on the ground and stretching mid-leap.

What they can't be is a different *game*. Every fairness rule below is derived
from the jump arc together with the creature's collision dimensions, so a body
of the wrong size would quietly make ducking optional or an arch impossible
while looking perfectly normal. `creatureFits()` states the bounds a body has to
satisfy, and the test suite runs it over the whole roster.

Those bounds are only worth something if they describe the body the game
actually collides with, so the envelope and the collision code share their
constants rather than each restating them — one `headHitR()` for the head's true
hit radius, one `ROCK_HIT` for how far a rock's hitbox is inset. The clearances
are derived too: each creature's margin is its own head bob plus a unit of
slack, so a wrigglier body is automatically held to a wider one.

The whole thing honours `prefers-reduced-motion`: screen shake, particles and
parallax drop out, and the game stays entirely playable.

## How it works

The head stays at a fixed x while the world scrolls past. Each body segment
replays the head's height from slightly earlier — a trail buffer indexed by
distance travelled — so the body genuinely follows the jump arc instead of
moving as a rigid block. A travelling sine wave is layered on top, with the
amplitude growing toward the tail, which is what produces the wriggle.

That spine is the single source of truth: the same samples that get swept into a
tube for drawing are the ones collision is tested against, so what you see hit
you is what actually hit you.

Everything is drawn with canvas paths. There are no image assets, no build step
and no dependencies.

Difficulty scales the way the original does: speed ramps up over time, obstacle
gaps are measured in *time to arrive* rather than fixed distance so fast play
stays fair, and new obstacles unlock as you go: meteor showers past 260
points, arches past 600. Speed hits a ceiling around 90 seconds, so two things
keep going after it: meteors grow steadily more frequent, and the sky cycles
day → dusk → night → dawn every 700 points, cross-fading over the tail of each phase. Only the scenery shifts —
the worm and the obstacles keep fixed colours so the things you have to read
stay equally legible at midnight.

Three rules keep the obstacles honest, and all three fall out of the jump arc
rather than being hand-tuned — each obstacle asks for something the others
don't, and none of them can be answered the wrong way:

- **Baguette clusters can always be cleared.** `clearableSpan()` solves the arc
  for the two moments it crosses the top of the tallest loaf, subtracts the lag
  before the rearmost collision probe gets up there, and turns the remainder
  into world distance. Spawning stops adding loaves at that limit, so a group
  is either tall and narrow or wide and low — never an impossible wall.
- **Arches can't be cleared, only hopped.** A low loaf under a hanging rock:
  ignore it and you hit the loaf, duck and you still hit the loaf, hold the jump
  and you clip the rock. The only way through is a deliberately short hop. This
  exists because the game already had a variable-height jump — hold higher,
  release to cut — with nothing that ever required using it.
- **Meteors can never be jumped.** Because the jump must clear a 62-unit
  baguette, its apex is far above any single low-flying rock — so one rock could
  always just be jumped over, and ducking would be decoration. Meteors therefore
  arrive as a vertical shower tall enough to reach past the top of the arc,
  leaving exactly one way through: flat on the ground. Each rock's dive covers
  the same horizontal run whatever its height, so they streak in staggered, all
  level off together, and the warning is identical at any speed.

The rock in an arch hangs higher than the bare minimum on purpose: the smallest
possible hop is airborne for only 0.31 s, and on a narrow phone world — where
horizontal speed is halved but the worm's own footprint isn't — that barely
spans the loaf. Room for a taller hop is what makes it fair on a phone.

Dying holds the frame for a moment, freezes the creature in the pose that got it
killed, and outlines the culprit — with only the front of the body lethal,
"what hit me?" deserves an answer.

## Running it locally

It's a static site, so any file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly works too.

## Tests

```sh
npm ci && npx playwright install chromium
npm test          # ~12 minutes
```

CI runs this on every push and pull request
([`.github/workflows/test.yml`](.github/workflows/test.yml)).

The suites drive the real game in a real browser through real key events. They
exist because the three rules above are *derived* from the jump arc and the
creature's dimensions, so touching `JUMP_V`, `GRAVITY`, `HIT_PROBES`,
`METEOR_ROCKS`, any baguette dimension or any entry in `CREATURES` silently
changes what the obstacles are allowed to be — and an unfair cluster or a
jumpable shower looks completely normal until it shows up. See
[tests/README.md](tests/README.md).

Playwright is a dev dependency only; the shipped page has no dependencies.

## Deployment

`.github/workflows/pages.yml` publishes the repo root to GitHub Pages on every
push to `main`.

One-time setup: **Settings → Pages → Build and deployment → Source → GitHub
Actions**. After that it's automatic.

## Files

```
index.html   canvas, HUD, touch pads
style.css    responsive layout, light/dark page chrome
game.js      loop, entities, input, scoring — the whole game
tests/       browser-driven suites; see tests/README.md
```
