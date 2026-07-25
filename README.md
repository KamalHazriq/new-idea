# Worm Runner 🪱

An endless runner in the spirit of the Chrome dino game — except you're a worm,
the cacti are baguettes, and the bird is a meteor shower.

**Jump the baguettes. Duck the meteors.**

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Jump | `Space` / `↑` / `W` | **JUMP** pad |
| Duck | `↓` / `S` | **DUCK** pad |
| Start / restart | `Space` / `Enter` / `R` | tap anywhere |

Holding jump goes higher; releasing early cuts the arc short. Ducking in mid-air
drops you fast. A jump pressed just before you land still counts — it's held
briefly and spent the moment you touch down, so a slightly early press isn't
silently thrown away.

Two toggles sit in the corner. The **swatch** cycles the worm's colour, rainbow
included. The **🔊** mutes sound. Both remember your choice. Audio is only ever
constructed after you press something, so the page is silent until you actually
start a run.

The whole thing honours `prefers-reduced-motion`: screen shake, particles and
parallax drop out, and the game stays entirely playable.

## How it works

The worm's head stays at a fixed x while the world scrolls past. Each body
segment replays the head's height from slightly earlier — a trail buffer indexed
by distance travelled — so the body genuinely follows the jump arc instead of
moving as a rigid block. A travelling sine wave is layered on top, with the
amplitude growing toward the tail, which is what produces the wriggle.

Everything is drawn with canvas paths. There are no image assets, no build step
and no dependencies.

Difficulty scales the way the original does: speed ramps up over time, obstacle
gaps are measured in *time to arrive* rather than fixed distance so fast play
stays fair, and meteors only start showing up past 260 points. Speed hits a
ceiling around 90 seconds, so two things keep going after it: meteors grow
steadily more frequent, and the sky cycles day → dusk → night → dawn every 700
points, cross-fading over the tail of each phase. Only the scenery shifts —
worm, baguettes and meteors keep fixed colours so the things you have to read
stay equally legible at midnight.

Two rules keep both obstacles honest, and both fall out of the jump arc rather
than being hand-tuned:

- **Baguette clusters can always be cleared.** `clearableSpan()` solves the arc
  for the two moments it crosses the top of the tallest loaf, subtracts the lag
  before the rearmost collision probe gets up there, and turns the remainder
  into world distance. Spawning stops adding loaves at that limit, so a group
  is either tall and narrow or wide and low — never an impossible wall.
- **Meteors can never be jumped.** Because the jump must clear a 62-unit
  baguette, its apex is far above any single low-flying rock — so one rock could
  always just be jumped over, and ducking would be decoration. Meteors therefore
  arrive as a vertical shower tall enough to reach past the top of the arc,
  leaving exactly one way through: flat on the ground. Each rock's dive covers
  the same horizontal run whatever its height, so they streak in staggered, all
  level off together, and the warning is identical at any speed.

Dying holds the frame for a moment, freezes the worm in the pose that got it
killed, and outlines the culprit — with only the front of the worm lethal,
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
npm install && npx playwright install chromium
npm test
```

The suites drive the real game in a real browser through real key events. They
exist because the two rules above are *derived* from the jump arc, so touching
`JUMP_V`, `GRAVITY`, `HIT_PROBES`, `METEOR_ROCKS` or any baguette dimension
silently changes what the obstacles are allowed to be — and an unfair cluster or
a jumpable shower looks completely normal until it shows up. See
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
