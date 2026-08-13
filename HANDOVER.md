# Handover

This file was the kickoff prompt for the session that started this repo, back
when it was an empty scaffold with no decided project. That's done — the repo
is now **Worm Runner**, an endless runner. See [README.md](README.md) for what
it is, how to run it, and the design rules behind the three obstacle types.

Kept only so the history makes sense; safe to delete.

## If you're picking this up in a fresh session

Worth knowing before changing anything:

- **No build step, no dependencies at runtime.** `index.html`, `style.css` and
  `game.js` are the whole game. Playwright is a dev dependency for the tests
  only — the shipped page never loads it.
- **The fairness invariants are enforced in code, not by hand-tuning.**
  Baguette clusters are capped by what the jump arc can actually carry, meteor
  showers are built tall enough that they cannot be jumped, and arches are
  geometrically impossible to clear. All of it falls out of `JUMP_V` /
  `GRAVITY`, so changing those changes the obstacles too.
- **A creature is physics, not a skin.** Each entry in `CREATURES` carries its
  own head radius and standing/ducking heights, and the rules above are stated
  in terms of those. `creatureFits()` is the envelope; add a creature outside it
  and the game still looks fine while quietly being unwinnable, or trivial.
- **`tests/` guards exactly that.** Run `npm test` after touching any movement
  or obstacle constant. The suite drives the real game in a real browser
  through real key events; it will tell you if the game has become unfair or
  unwinnable, which is not something you would notice by playing for a minute.
- **Deployment is automatic** on push to `main`, but Pages had to be switched
  on by hand once (Settings → Pages → Source → GitHub Actions). A workflow
  cannot do it: creating the Pages site needs repo-admin rights that
  `GITHUB_TOKEN` doesn't have.
