# Worm Runner 🪱

An endless runner in the spirit of the Chrome dino game — except you're a worm,
the cacti are baguettes, and the bird is a meteor.

**Jump the baguettes. Duck the meteors.**

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Jump | `Space` / `↑` / `W` | **JUMP** pad |
| Duck | `↓` / `S` | **DUCK** pad |
| Start / restart | `Space` / `Enter` / `R` | tap anywhere |

Holding jump goes higher; releasing early cuts the arc short. Ducking in mid-air
drops you fast.

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
stays fair, and meteors only start showing up past 260 points. Meteors dive in
from the top and level off at duck height — the dive always covers the same
horizontal distance, so the warning you get is the same at any speed.

## Running it locally

It's a static site, so any file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly works too.

## Deployment

`.github/workflows/pages.yml` publishes the repo root to GitHub Pages on every
push to `main`.

One-time setup: **Settings → Pages → Build and deployment → Source → GitHub
Actions**. After that it's automatic.

## Files

```
index.html   canvas, HUD, touch pads
style.css    responsive layout, light/dark page chrome
game.js      loop, entities, input, scoring
```
