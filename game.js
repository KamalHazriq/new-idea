/*
 * Worm Runner — an endless runner in one canvas, no dependencies.
 *
 * The worm's head sits at a fixed x and the world scrolls past it. Each body
 * segment replays the head's height from a little earlier (a trail buffer
 * indexed by distance travelled), and a travelling sine wave is layered on top
 * — so the body both follows the jump arc and ripples as it runs.
 *
 * Coordinates: the world is always WORLD_H units tall whatever the screen is,
 * and the width follows from the canvas aspect ratio. Fixing the height keeps
 * the worm the same visible size on a phone and a laptop; horizontal speed is
 * then scaled by the world's width so an obstacle takes the same *time* to
 * reach the player either way.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants (world units)
   * ------------------------------------------------------------------ */

  const WORLD_H = 300;
  const GROUND_OFFSET = 52;
  const GROUND_Y = WORLD_H - GROUND_OFFSET;
  const REF_W = 800;             // width the speed numbers below assume

  const GRAVITY = 2000;
  const JUMP_V = -680;           // apex ≈ 116 units, hang time ≈ 0.68 s
  const JUMP_CUT = 0.45;         // vy kept when jump is released early
  const FAST_FALL = 1.9;         // extra gravity while ducking mid-air

  const START_SPEED = 300;
  const MAX_SPEED = 820;
  const ACCEL = 6;               // units/s gained per second

  const SEGMENTS = 16;           // spine samples; the body is drawn as one
  const SEG_SPACING = 7.2;       // continuous tube through them, not as beads
  const WAVE_STEP = 0.5;         // ≈1.2 wavelengths along the body
  // Wriggle amplitude ramps from almost nothing at the head to full at the tail.
  // Beyond looking right — the head leads, the body follows — this keeps the
  // collision probes at a predictable height: a bobbing head would sometimes
  // duck under a meteor on its own, which would wreck the duck mechanic.
  const WAVE_AMP = 14;
  const HEAD_R = 11;
  const STAND_H = 22;            // head centre above the ground, standing
  const DUCK_H = 10;             // …and flattened

  // Only the front of the worm can collide. The tail replays the head's height
  // from earlier, so it hangs low through a jump; making it lethal would mean
  // the worm gets killed by a baguette it has visibly already cleared.
  const HIT_PROBES = 3;
  const HIT_SHRINK = 0.8;        // hitboxes sit inside the drawn body

  const BAGUETTE_MIN_H = 34;
  const BAGUETTE_MAX_H = 62;
  const BAGUETTE_MAX_SPAN = 110;  // reference units; purely a look/variety cap
  const JUMP_MARGIN = 0.8;        // slack left for human timing, vs. perfect play

  // Meteors arrive as a vertical shower, not a single rock, and that is load
  // bearing. The jump has to clear a 62-unit baguette, which puts the worm's
  // apex far above any single low-flying rock — so one rock could always simply
  // be jumped, and ducking would be decoration. A column tall enough to reach
  // past the top of the jump arc leaves exactly one way through: underneath.
  const METEOR_H = 36;           // lowest rock's centre above the ground
  const METEOR_GAP = 25;         // vertical spacing up the column
  const METEOR_ROCKS = 5;        // tops out above the jump arc — see above
  const METEOR_R = 14;
  const METEOR_FALL_RUN = 300;   // horizontal distance the dive takes, at any speed
  const METEOR_UNLOCK = 260;     // score at which meteors join in
  const METEOR_CHANCE = 0.34;

  // The third demand: restraint. A loaf low enough that a tap clears it, under a
  // rock low enough that a full-height jump clips it — so the only way through is
  // a deliberately short hop. The variable-height jump had no obstacle that used
  // it, which meant releasing early was a mechanic with nothing to be for.
  // Derived, like the other two. The hop's apex must land inside
  // [loaf + headR - STAND_H, rockUnderside - headR - STAND_H] = [15, 87].
  //
  // The rock sits higher than the minimum that would "work", on purpose. A
  // bare-minimum hop peaks at 23 units and is airborne for only 0.31 s, and on
  // a narrow phone world — where horizontal speed is halved but the worm's own
  // footprint is not — that barely spans the loaf plus the worm. Leaving room
  // for a taller hop is what makes the obstacle fair on a phone; the ceiling is
  // still far below the full-hold apex of 116, so holding is punished.
  const ARCH_LOAF_H = 28;
  const ARCH_ROCK_H = 130;       // rock centre above the ground
  const ARCH_UNLOCK = 600;       // later than meteors; it is the subtlest one
  const ARCH_CHANCE = 0.24;

  const SCORE_RATE = 0.06;
  const HI_KEY = 'wormrunner.hi';
  const MUTE_KEY = 'wormrunner.muted';
  const SKIN_KEY = 'wormrunner.skin';
  const DUCKED_KEY = 'wormrunner.ducked';   // has the player ever cleared a shower
  const HOPPED_KEY = 'wormrunner.hopped';   // …or ever cleared an arch

  const JUMP_BUFFER = 0.13;      // a jump pressed this soon before landing still counts

  // Worm colours. `rainbow` is painted as a hue sweep down the body instead of
  // flat fills, so it needs no colours of its own.
  const SKINS = [
    { name: 'Green',   body: '#5fbf5f', dark: '#2f7a3c', light: '#95e48f' },
    { name: 'Rainbow', rainbow: true,   swatch: 'conic-gradient(#e5484d,#f5a524,#f3e04a,#46a758,#3b9eff,#8e4ec6,#e5484d)' },
    { name: 'Coral',   body: '#f4795b', dark: '#a83b26', light: '#ffb59e' },
    { name: 'Ocean',   body: '#4aa8d8', dark: '#1f5f85', light: '#9adcf5' },
    { name: 'Grape',   body: '#9b6bd6', dark: '#5b2f8f', light: '#cbaaf0' },
    { name: 'Gold',    body: '#e8b53c', dark: '#9a6c12', light: '#f7dc93' },
  ];

  const HITSTOP = 0.16;          // seconds the impact frame is held
  const SHAKE_MAX = 7;

  // The environment cycles day → dusk → night → dawn and back, one phase per
  // PHASE_LEN points, blended over the tail of each phase. Only the scenery
  // shifts; the worm, baguettes and meteors keep fixed colours so the things
  // you have to read stay equally legible at every hour.
  const PHASE_LEN = 700;
  const PHASES = [
    { sky0: [220, 239, 251], sky1: [253, 244, 226], ground: [125, 108, 86],
      groundDark: [94, 80, 64], pebble: [156, 138, 113], cloud: [255, 255, 255], cloudA: 0.9, stars: 0 },
    { sky0: [246, 168, 128], sky1: [255, 226, 184], ground: [112, 88, 74],
      groundDark: [80, 62, 52], pebble: [152, 124, 104], cloud: [255, 226, 204], cloudA: 0.85, stars: 0.2 },
    { sky0: [24, 32, 64], sky1: [72, 66, 104], ground: [50, 47, 62],
      groundDark: [33, 30, 42], pebble: [96, 92, 116], cloud: [118, 126, 166], cloudA: 0.45, stars: 1 },
    { sky0: [150, 170, 220], sky1: [255, 214, 190], ground: [100, 90, 84],
      groundDark: [70, 62, 58], pebble: [140, 128, 116], cloud: [255, 240, 230], cloudA: 0.8, stars: 0.3 },
  ];

  const COL = {
    // Live body colours come from SKINS; these are the corpse.
    bodyDead: '#9aa08f', bodyDeadDark: '#6b7062',
    crust: '#e2b273', crustDark: '#a9743a', crumb: '#f8dfb2',
    rock: '#6d665f', rockDark: '#423d38', rockLight: '#9a9189',
    flameOuter: 'rgba(244, 113, 59, 0)', flameMid: '#f4713b', flameCore: '#ffd166',
  };

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const stage = document.getElementById('stage');
  const scoreEl = document.getElementById('score');
  const hiEl = document.getElementById('hiScore');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlaySub = document.getElementById('overlaySub');
  const overlayHint = document.getElementById('overlayHint');
  const btnJump = document.getElementById('btnJump');
  const btnDuck = document.getElementById('btnDuck');
  const btnMute = document.getElementById('btnMute');
  const btnSkin = document.getElementById('btnSkin');
  const btnPause = document.getElementById('btnPause');
  const swatch = document.getElementById('swatch');

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  let worldW = REF_W;
  let widthFactor = 1;           // worldW / REF_W — scales horizontal speed
  let headX = 176;
  let skyGrad = null;

  let state = 'ready';           // 'ready' | 'running' | 'over'
  let speed = START_SPEED;       // reference speed; multiply by widthFactor to move
  let traveled = 0;              // world distance, drives the trail buffer
  let score = 0;
  let hiScore = readHi();
  let shownScore = -1;
  let nextMilestone = 100;
  let spawnGap = 0;              // reference distance until the next obstacle
  let overAt = 0;

  // Death feedback. The run stops on the frame of impact, but the overlay is
  // held back for `hitstop` seconds so the moment stays visible — with only the
  // worm's front three samples lethal, "what hit me?" is otherwise a fair
  // question, and the flash answers it.
  let spine = null;              // this frame's worm geometry, computed once
  let hitstop = 0;
  let shake = 0;
  let flash = 0;
  let culprit = null;

  const worm = { y: GROUND_Y - STAND_H, vy: 0, onGround: true, ducking: false, duckT: 0, wave: 0 };
  const trail = [];              // [{ d, y }] ascending by d — head height history
  const obstacles = [];
  const particles = [];
  const clouds = [];
  const pebbles = [];
  const stars = [];

  let paused = false;
  let jumpBuffer = 0;            // seconds a pressed-early jump stays live
  // Which inputs are currently holding jump. A single boolean was wrong: three
  // sources can press jump (keyboard, the JUMP pad, a tap on the canvas), and
  // releasing any one of them would clear the flag while another was still
  // held — cutting a jump that should have gone full height. Needed at landing,
  // where a buffered tap must still come out as a short hop.
  const jumpSources = new Set();
  const jumpHeld = () => jumpSources.size > 0;
  let hintUntil = 0;             // when the first-run prompt stops showing
  let hintObstacle = null;
  let hintText = '';
  let newBest = false;

  // Motion can be genuinely unpleasant for some people, and this page is all
  // motion. Honouring the preference drops shake, particles and parallax while
  // leaving the game completely playable.
  const reducedMotionQuery = window.matchMedia
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  let reducedMotion = reducedMotionQuery ? reducedMotionQuery.matches : false;
  if (reducedMotionQuery) {
    const onChange = (e) => { reducedMotion = e.matches; };
    if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', onChange);
    else if (reducedMotionQuery.addListener) reducedMotionQuery.addListener(onChange);
  }

  let skinIndex = (() => {
    try {
      const n = parseInt(localStorage.getItem(SKIN_KEY), 10);
      return Number.isInteger(n) && n >= 0 && n < SKINS.length ? n : 0;
    } catch { return 0; }
  })();
  const learned = (key) => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  };
  const markLearned = (key) => {
    try { localStorage.setItem(key, '1'); } catch { /* private mode */ }
  };
  let hasDucked = learned(DUCKED_KEY);
  let hasHopped = learned(HOPPED_KEY);

  const MAX_LOOKBACK = SEGMENTS * SEG_SPACING * 1.6;

  function readHi() {
    try { return parseInt(localStorage.getItem(HI_KEY), 10) || 0; } catch { return 0; }
  }

  function writeHi(v) {
    try { localStorage.setItem(HI_KEY, String(v)); } catch { /* private mode */ }
  }

  function pad5(n) { return String(Math.floor(n)).padStart(5, '0'); }

  /* ------------------------------------------------------------------ *
   * Palette — the current point in the day/night cycle
   * ------------------------------------------------------------------ */

  const pal = { sky0: '', sky1: '', ground: '', groundDark: '', pebble: '', cloud: '', stars: 0 };
  let palKey = '';               // guards rebuilding the sky gradient every frame

  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  function updatePalette() {
    const pos = score / PHASE_LEN;
    const i = Math.floor(pos) % PHASES.length;
    const j = (i + 1) % PHASES.length;
    const f = pos - Math.floor(pos);
    // Hold the phase, then cross-fade over its last 20% so the change is felt
    // as a passage of time rather than a jump cut.
    const t = f < 0.8 ? 0 : (f - 0.8) / 0.2;

    const a = PHASES[i];
    const b = PHASES[j];
    pal.sky0 = rgb(mix(a.sky0, b.sky0, t));
    pal.sky1 = rgb(mix(a.sky1, b.sky1, t));
    pal.ground = rgb(mix(a.ground, b.ground, t));
    pal.groundDark = rgb(mix(a.groundDark, b.groundDark, t));
    pal.pebble = rgb(mix(a.pebble, b.pebble, t));
    const c = mix(a.cloud, b.cloud, t);
    pal.cloud = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${(a.cloudA + (b.cloudA - a.cloudA) * t).toFixed(3)})`;
    pal.stars = a.stars + (b.stars - a.stars) * t;

    const key = pal.sky0 + pal.sky1;
    if (key !== palKey) {
      palKey = key;
      skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
      skyGrad.addColorStop(0, pal.sky0);
      skyGrad.addColorStop(1, pal.sky1);
    }
  }

  /* ------------------------------------------------------------------ *
   * Sound — tiny synthesised blips, no asset files
   * ------------------------------------------------------------------ */

  let audio = null;
  let muted = (() => {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
  })();

  // The context is built on the first blip, which can only follow a keypress or
  // tap, since that is what starts a run. So nothing ever sounds unbidden on
  // page load, and browsers' autoplay rules are satisfied for free.
  function audioCtx() {
    if (!audio) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try { audio = new Ctor(); } catch { return null; }
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  function blip({ freq, to, dur, type = 'square', gain = 0.05, delay = 0 }) {
    if (muted) return;
    const ac = audioCtx();
    if (!ac) return;

    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const vol = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    vol.gain.setValueAtTime(0.0001, t0);
    vol.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    vol.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(vol).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const sfx = {
    jump: () => blip({ freq: 420, to: 780, dur: 0.11, gain: 0.045 }),
    duck: () => blip({ freq: 300, to: 140, dur: 0.09, type: 'triangle', gain: 0.04 }),
    land: () => blip({ freq: 170, to: 110, dur: 0.06, type: 'triangle', gain: 0.03 }),
    point: () => {
      blip({ freq: 880, dur: 0.07, gain: 0.035 });
      blip({ freq: 1320, dur: 0.09, gain: 0.035, delay: 0.075 });
    },
    die: () => {
      blip({ freq: 420, to: 80, dur: 0.4, type: 'sawtooth', gain: 0.055 });
      blip({ freq: 190, to: 55, dur: 0.5, gain: 0.035, delay: 0.05 });
    },
  };

  function setMuted(on) {
    muted = on;
    btnMute.textContent = on ? '🔇' : '🔊';
    btnMute.setAttribute('aria-pressed', String(on));
    btnMute.setAttribute('aria-label', on ? 'Unmute sound' : 'Mute sound');
    try { localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  }

  /* ------------------------------------------------------------------ *
   * Viewport
   * ------------------------------------------------------------------ */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const scale = canvas.height / WORLD_H;
    const prevW = worldW;
    worldW = canvas.width / scale;
    widthFactor = worldW / REF_W;
    // Leave room for the whole body behind the head without crowding the road.
    headX = Math.min(210, Math.max(SEGMENTS * SEG_SPACING + 12, worldW * 0.24));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    palKey = '';                 // gradient is tied to the transform; rebuild it
    updatePalette();

    if (Math.abs(worldW - prevW) > 1) buildScenery();
  }

  /* ------------------------------------------------------------------ *
   * Setup / reset
   * ------------------------------------------------------------------ */

  function standY() { return GROUND_Y - STAND_H; }
  function duckY() { return GROUND_Y - DUCK_H; }
  function restY() { return standY() + (duckY() - standY()) * worm.duckT; }
  function vx() { return speed * widthFactor; }

  function reset(autoStart) {
    state = autoStart ? 'running' : 'ready';
    speed = START_SPEED;
    traveled = 0;
    score = 0;
    shownScore = -1;
    nextMilestone = 100;
    spawnGap = 420;
    hitstop = 0;
    shake = 0;
    flash = 0;
    culprit = null;
    paused = false;
    jumpBuffer = 0;
    jumpSources.clear();
    hintObstacle = null;
    hintUntil = 0;
    hintText = '';
    newBest = false;

    worm.y = standY();
    worm.vy = 0;
    worm.onGround = true;
    worm.ducking = false;
    worm.duckT = 0;
    worm.wave = 0;

    obstacles.length = 0;
    particles.length = 0;

    // Seed the trail so the body starts stretched out, not piled on the head.
    trail.length = 0;
    for (let d = -MAX_LOOKBACK; d <= 0; d += 6) trail.push({ d, y: worm.y });
    spine = wormSpine();

    buildScenery();
    updateHud();
    setOverlay();
  }

  function buildScenery() {
    clouds.length = 0;
    for (let i = 0; i < 5; i++) {
      clouds.push({
        x: Math.random() * (worldW + 200),
        y: 18 + Math.random() * (GROUND_Y * 0.45),
        s: 0.6 + Math.random() * 0.8,
      });
    }
    pebbles.length = 0;
    for (let i = 0; i < 26; i++) {
      pebbles.push({
        x: Math.random() * worldW,
        y: 5 + Math.random() * 26,
        len: 3 + Math.random() * 12,
      });
    }
    stars.length = 0;
    for (let i = 0; i < 40; i++) {
      stars.push({
        x: Math.random() * worldW,
        y: 6 + Math.random() * (GROUND_Y * 0.72),
        r: 0.6 + Math.random() * 1.2,
        tw: Math.random() * Math.PI * 2,
      });
    }
  }

  function start() {
    state = 'running';
    overAt = 0;
    setOverlay();
  }

  function gameOver(hit) {
    state = 'over';
    overAt = performance.now();
    worm.ducking = false;
    culprit = hit;
    hitstop = HITSTOP;
    shake = reducedMotion ? 0 : SHAKE_MAX;
    flash = 1;
    burst(headX, worm.y, 16, SKINS[skinIndex].dark || '#2f7a3c');
    sfx.die();
    newBest = Math.floor(score) > hiScore && Math.floor(score) > 0;
    if (newBest) {
      hiScore = Math.floor(score);
      writeHi(hiScore);
    }
    updateHud();
    // Overlay deliberately withheld until the hitstop expires, so the frame of
    // impact is readable before the card covers it.
  }

  function setOverlay() {
    if (state === 'running' && !paused) {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    if (state === 'running') {            // i.e. paused
      overlayTitle.textContent = 'PAUSED';
      overlaySub.textContent = `Score ${pad5(score)}`;
      overlayHint.textContent = 'Press P or tap to resume';
    } else if (state === 'ready') {
      overlayTitle.textContent = 'Worm Runner';
      overlaySub.textContent = 'Jump the baguettes. Duck the meteors.';
      overlayHint.textContent = 'Press Space or tap to start';
    } else {
      overlayTitle.textContent = newBest ? 'NEW BEST!' : 'GAME OVER';
      overlaySub.textContent = newBest
        ? `${pad5(score)}  ·  your best yet`
        : `Score ${pad5(score)}  ·  Best ${pad5(hiScore)}`;
      overlayHint.textContent = 'Press Space or tap to run again';
    }
  }

  function updateHud() {
    const s = Math.floor(score);
    if (s !== shownScore) {
      shownScore = s;
      scoreEl.textContent = pad5(s);
    }
    hiEl.textContent = `HI ${pad5(hiScore)}`;
  }

  /* ------------------------------------------------------------------ *
   * Trail buffer — head height, indexed by distance travelled
   * ------------------------------------------------------------------ */

  function pushTrail() {
    trail.push({ d: traveled, y: worm.y });
    const cutoff = traveled - MAX_LOOKBACK;
    let drop = 0;
    while (drop + 1 < trail.length && trail[drop + 1].d <= cutoff) drop++;
    if (drop) trail.splice(0, drop);
  }

  function sampleTrail(targetD) {
    for (let i = trail.length - 1; i >= 0; i--) {
      if (trail[i].d <= targetD) {
        const a = trail[i];
        const b = trail[i + 1];
        if (!b) return a.y;
        const span = b.d - a.d;
        const t = span > 1e-6 ? (targetD - a.d) / span : 0;
        return a.y + (b.y - a.y) * t;
      }
    }
    return trail.length ? trail[0].y : worm.y;
  }

  /* ------------------------------------------------------------------ *
   * Worm geometry — shared by the renderer and the collision test
   * ------------------------------------------------------------------ */

  function wormSpine() {
    const spacing = SEG_SPACING * (1 + 0.05 * worm.duckT);
    const baseR = HEAD_R * (1 - 0.38 * worm.duckT);
    const amp = WAVE_AMP * (1 - 0.57 * worm.duckT) * (worm.onGround ? 1 : 0.5);
    const pts = [];

    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / (SEGMENTS - 1);
      // The tail whips wide while the head barely stirs — that's the wriggle.
      const a = amp * (0.06 + 0.94 * Math.pow(t, 1.25));
      pts.push({
        x: headX - i * spacing,
        y: sampleTrail(traveled - i * spacing) + Math.sin(worm.wave - i * WAVE_STEP) * a,
        r: baseR * (1.05 - 0.85 * t * t),   // full-bodied, tapering to a point
        nx: 0,
        ny: 0,
      });
    }

    // Unit normal at each sample, from the local head-ward tangent. The tube
    // renderer offsets along these to build the two edges of the body.
    for (let i = 0; i < SEGMENTS; i++) {
      const ahead = pts[Math.max(0, i - 1)];
      const behind = pts[Math.min(SEGMENTS - 1, i + 1)];
      const tx = ahead.x - behind.x;
      const ty = ahead.y - behind.y;
      const len = Math.hypot(tx, ty) || 1;
      pts[i].nx = -ty / len;
      pts[i].ny = tx / len;
    }
    return pts;
  }

  /* ------------------------------------------------------------------ *
   * Obstacles
   * ------------------------------------------------------------------ */

  // Meteors get steadily more common as the run goes on, so the mix keeps
  // shifting after speed has hit its ceiling.
  function meteorChance() {
    return Math.min(0.52, METEOR_CHANCE + score * 0.00004);
  }

  function spawnObstacle() {
    if (score >= ARCH_UNLOCK && Math.random() < ARCH_CHANCE) spawnArch();
    else if (score >= METEOR_UNLOCK && Math.random() < meteorChance()) spawnMeteor();
    else spawnBaguettes();

    // Gap measured in time-to-arrive, so high speeds stay fair.
    // Minimum gap now exceeds the hang time, so landing from a baguette always
    // leaves room to get flat before a meteor shower arrives.
    spawnGap = speed * (0.95 + Math.random() * 0.8);
  }

  // The widest cluster the worm can actually clear right now, derived from the
  // jump arc rather than guessed: solve the arc for the two times it crosses
  // the top of the tallest loaf, subtract the lag before the rearmost collision
  // probe gets up there too, and convert what's left into world distance.
  function clearableSpan(tallest, ws) {
    const headR = HEAD_R * 1.05 * HIT_SHRINK;
    const rise = tallest + headR - STAND_H;
    const disc = JUMP_V * JUMP_V - 2 * GRAVITY * rise;
    if (disc <= 0) return 0;                       // can't be jumped at all

    const airborne = Math.sqrt(disc) * 2 / GRAVITY;  // t1 - t0
    const reach = (HIT_PROBES - 1) * SEG_SPACING;    // rear probe's offset
    const clear = airborne - reach / Math.max(1, ws);
    return Math.max(0, clear * ws - (reach + 2 * headR));
  }

  function spawnBaguettes() {
    const count = Math.random() < 0.58 ? 1 : (Math.random() < 0.7 ? 2 : 3);
    const ws = vx();
    const parts = [];
    let dx = 0;
    let span = 0;
    let tallest = 0;

    for (let i = 0; i < count; i++) {
      const w = (17 + Math.random() * 9) * widthFactor;
      const h = BAGUETTE_MIN_H + Math.random() * (BAGUETTE_MAX_H - BAGUETTE_MIN_H);
      const nextSpan = dx + w;
      const nextTallest = Math.max(tallest, h);

      // Always place the first loaf; past that, stop as soon as the cluster
      // would outgrow what the jump can carry. Tall loaves shrink the budget,
      // so a group is naturally either tall and narrow or wide and low —
      // never a wall that's impossible whatever the player does.
      if (i && nextSpan > Math.min(
        clearableSpan(nextTallest, ws) * JUMP_MARGIN,
        BAGUETTE_MAX_SPAN * widthFactor,
      )) break;

      parts.push({ dx, w, h, lean: (Math.random() - 0.5) * 0.16 });
      span = nextSpan;
      tallest = nextTallest;
      dx = span + (4 + Math.random() * 5) * widthFactor;
    }
    obstacles.push({ type: 'baguette', x: worldW + 20, w: span, parts });
  }

  function spawnMeteor() {
    const vxMag = vx() * 1.06;
    const run = METEOR_FALL_RUN * widthFactor;
    const rocks = [];

    for (let i = 0; i < METEOR_ROCKS; i++) {
      const targetY = GROUND_Y - (METEOR_H + i * METEOR_GAP);
      const startY = -30 - i * 22;

      const verts = [];
      for (let v = 0; v < 9; v++) verts.push(1 - Math.random() * 0.3);

      const craters = [];
      for (let c = 0; c < 3; c++) {
        craters.push({
          a: Math.random() * Math.PI * 2,
          d: Math.random() * 0.5,
          r: 0.13 + Math.random() * 0.14,
        });
      }

      rocks.push({
        y: startY, targetY,
        // Each rock's dive covers the same horizontal run whatever its height,
        // so they streak in staggered and all level off together — and the
        // warning is the same at 300 units/s as at 800.
        vy: (targetY - startY) * vxMag / run,
        r: METEOR_R * (0.86 + Math.random() * 0.22),
        verts, craters, spin: Math.random() * Math.PI * 2,
      });
    }

    const shower = { type: 'meteor', x: worldW + 30, vxMag, rocks };
    obstacles.push(shower);

    // Nothing in the game teaches that a shower has to be gone under rather
    // than over. Prompt on the first one, until the player has cleared one.
    if (!hasDucked && !hintObstacle) {
      hintObstacle = shower;
      hintText = '↓  DUCK!';
      hintUntil = performance.now() + 2600;
    }
  }

  function spawnArch() {
    const verts = [];
    for (let v = 0; v < 9; v++) verts.push(1 - Math.random() * 0.3);
    const craters = [];
    for (let c = 0; c < 3; c++) {
      craters.push({
        a: Math.random() * Math.PI * 2,
        d: Math.random() * 0.5,
        r: 0.13 + Math.random() * 0.14,
      });
    }

    const w = (18 + Math.random() * 6) * widthFactor;
    obstacles.push({
      type: 'arch',
      x: worldW + 30,
      w,
      vxMag: vx() * 1.06,
      loaf: { w, h: ARCH_LOAF_H, lean: (Math.random() - 0.5) * 0.12 },
      // No dive: it holds its height the whole way in, so the gap is legible as
      // a gap from the moment it appears rather than closing as it arrives.
      // Bigger than a shower rock so it reads as a ceiling rather than as one
      // more thing to dodge. That lowers its underside, which the numbers above
      // already account for.
      rock: { y: GROUND_Y - ARCH_ROCK_H, vy: 0, r: METEOR_R * 1.3, verts, craters,
              spin: Math.random() * Math.PI * 2 },
    });

    // "Jump, but not too high" is the least guessable rule in the game.
    if (!hasHopped && !hintObstacle) {
      hintObstacle = obstacles[obstacles.length - 1];
      hintText = 'TAP  —  LOW HOP!';
      hintUntil = performance.now() + 2600;
    }
  }

  /* ------------------------------------------------------------------ *
   * Particles
   * ------------------------------------------------------------------ */

  function burst(x, y, n, color) {
    if (reducedMotion) return;
    for (let i = 0; i < n && particles.length < 140; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 190;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        r: 1.5 + Math.random() * 3,
        life: 0.4 + Math.random() * 0.5,
        max: 0.9,
        color,
        grav: 900,
        drift: true,
      });
    }
  }

  function dust(x, y, n) {
    if (reducedMotion) return;
    for (let i = 0; i < n && particles.length < 140; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 14,
        y,
        vx: 20 + Math.random() * 70,
        vy: -20 - Math.random() * 70,
        r: 1.5 + Math.random() * 2.5,
        life: 0.25 + Math.random() * 0.3,
        max: 0.55,
        color: pal.pebble,
        grav: 700,
        drift: true,
      });
    }
  }

  function spark(x, y) {
    if (reducedMotion || particles.length > 130) return;
    particles.push({
      x, y,
      vx: 30 + Math.random() * 60,
      vy: -30 + Math.random() * 60,
      r: 1 + Math.random() * 2,
      life: 0.2 + Math.random() * 0.25,
      max: 0.45,
      color: Math.random() < 0.5 ? COL.flameCore : COL.flameMid,
      grav: 120,
      drift: false,
    });
  }

  /* ------------------------------------------------------------------ *
   * Collision
   * ------------------------------------------------------------------ */

  function circleRect(cx, cy, cr, rx, ry, rw, rh) {
    const nx = Math.max(rx, Math.min(cx, rx + rw));
    const ny = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy < cr * cr;
  }

  function circleCircle(ax, ay, ar, bx, by, br) {
    const dx = ax - bx;
    const dy = ay - by;
    const rr = ar + br;
    return dx * dx + dy * dy < rr * rr;
  }

  // Returns the obstacle that struck the worm, or null. Handing back the
  // culprit rather than a boolean is what lets the death feedback flash the
  // thing that actually got you.
  function hitFrom(pts) {
    const probes = [];
    for (let i = 0; i < HIT_PROBES && i < pts.length; i++) {
      probes.push({ x: pts[i].x, y: pts[i].y, r: pts[i].r * HIT_SHRINK });
    }

    for (const o of obstacles) {
      if (o.type === 'baguette') {
        if (o.x > headX + 40 || o.x + o.w < headX - 60) continue;
        for (const p of o.parts) {
          const rx = o.x + p.dx;
          const ry = GROUND_Y - p.h;
          for (const c of probes) {
            if (circleRect(c.x, c.y, c.r, rx, ry, p.w, p.h)) return o;
          }
        }
      } else if (o.type === 'arch') {
        if (o.x > headX + 60 || o.x + o.w < headX - 60) continue;
        const ry = GROUND_Y - o.loaf.h;
        for (const c of probes) {
          if (circleRect(c.x, c.y, c.r, o.x, ry, o.loaf.w, o.loaf.h)) return o;
          if (circleCircle(c.x, c.y, c.r, o.x + o.w / 2, o.rock.y, o.rock.r * 0.84)) return o;
        }
      } else {
        if (Math.abs(o.x - headX) > 90) continue;
        for (const rock of o.rocks) {
          for (const c of probes) {
            if (circleCircle(c.x, c.y, c.r, o.x, rock.y, rock.r * 0.84)) return o;
          }
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Update
   * ------------------------------------------------------------------ */

  function update(dt) {
    // How fast the world slides past this frame.
    const ws = state === 'running' ? vx()
             : state === 'ready' ? START_SPEED * widthFactor * 0.5
             : 0;

    if (state === 'running') {
      speed = Math.min(MAX_SPEED, speed + ACCEL * dt);
      score += speed * dt * SCORE_RATE;
      if (score >= nextMilestone) {
        nextMilestone += 100;
        scoreEl.classList.remove('flash');
        void scoreEl.offsetWidth;        // restart the CSS animation
        scoreEl.classList.add('flash');
        sfx.point();
      }
      updateHud();
    }

    updatePalette();
    traveled += ws * dt;

    /* --- worm --- *
     * Frozen outright once the run is over. The death pose IS the feedback, so
     * it has to hold: left running, duckT lerps back toward standing and a worm
     * killed while flat visibly inflates to full height under the hitstop —
     * exactly the frame the player is trying to read. Freezing here also stops
     * pushTrail() appending at a standstill, which grew the buffer without
     * bound because the trim cutoff stops moving too. */
    if (state !== 'over') {
      // Wriggle faster as the worm speeds up, so the gait stays believable.
      worm.wave += dt * (5 + ws * 0.022);

      const wantDuck = worm.ducking && worm.onGround && state === 'running';
      worm.duckT += ((wantDuck ? 1 : 0) - worm.duckT) * Math.min(1, dt * 16);

      if (!worm.onGround) {
        worm.vy += GRAVITY * dt;
        if (worm.ducking) worm.vy += GRAVITY * (FAST_FALL - 1) * dt;
        worm.y += worm.vy * dt;
        if (worm.y >= restY()) {
          worm.y = restY();
          worm.vy = 0;
          worm.onGround = true;
          dust(headX - 6, GROUND_Y, 7);
          sfx.land();
          // A jump pressed just before touchdown used to be swallowed; now it
          // fires the instant the worm lands — unless the player is holding
          // duck by then. Someone flat on the ground at touchdown wants to
          // stay there, and launching them anyway throws them into the shower
          // they ducked for. That sequence is not exotic: ducking in mid-air
          // is the fast-fall, so "buffer a jump, spot a shower, slam duck to
          // get down early" is exactly how a good player would react.
          if (jumpBuffer > 0) {
            jumpBuffer = 0;
            if (!worm.ducking) {
              doJump();
              // A buffered *tap* must still be a short hop. Its release arrived
              // while the worm was falling, where the cut is a no-op, so apply
              // it here — otherwise buffering quietly upgrades every tap to a
              // full-height jump and takes the height control away exactly when
              // the player was relying on it.
              if (!jumpHeld()) worm.vy *= JUMP_CUT;
            }
          }
        }
      } else {
        worm.y += (restY() - worm.y) * Math.min(1, dt * 18);
      }

      // Expire the buffer only after this frame's landing has had its chance to
      // spend it. Ageing it first can zero a still-valid press on the exact
      // frame it was waiting for, which is the one thing this must not do.
      if (jumpBuffer > 0) jumpBuffer = Math.max(0, jumpBuffer - dt);

      pushTrail();
      // Computed once here and reused by both the collision test and the
      // renderer — it used to be built twice per frame from the same inputs.
      spine = wormSpine();
    }

    /* --- death feedback --- */
    if (hitstop > 0) {
      hitstop -= dt;
      if (hitstop <= 0) setOverlay();
    }
    if (shake > 0) shake = Math.max(0, shake - dt * 26);
    if (flash > 0) flash = Math.max(0, flash - dt * 2.2);

    /* --- obstacles --- */
    if (state === 'running') {
      spawnGap -= speed * dt;
      if (spawnGap <= 0) spawnObstacle();

      for (let i = obstacles.length - 1; i >= 0; i--) {
        const o = obstacles[i];
        if (o.type === 'baguette') {
          o.x -= ws * dt;
          if (o.x + o.w < -40) obstacles.splice(i, 1);
        } else if (o.type === 'arch') {
          o.vxMag = ws * 1.06;
          o.x -= ws * dt;
          o.rock.spin += dt * 3.2;
          if (Math.random() < 0.5) spark(o.x + o.w / 2 + o.rock.r * 0.8, o.rock.y - o.rock.r * 0.3);
          if (o.x + o.w < headX - 50 && !hasHopped) {
            hasHopped = true;
            hintObstacle = null;
            markLearned(HOPPED_KEY);
          }
          if (o.x + o.w < -60) obstacles.splice(i, 1);
        } else {
          o.vxMag = ws * 1.06;
          o.x -= o.vxMag * dt;
          for (const rock of o.rocks) {
            rock.spin += dt * 3.2;
            if (rock.y < rock.targetY) {
              rock.y = Math.min(rock.targetY, rock.y + rock.vy * dt);
              if (rock.y >= rock.targetY) rock.vy = 0;
            }
          }
          if (Math.random() < 0.75) {
            const rock = o.rocks[(Math.random() * o.rocks.length) | 0];
            spark(o.x + rock.r * 0.8, rock.y - rock.r * 0.3);
          }
          // Still running once a shower is behind you means you went under it —
          // there is no other way past. Stop prompting after the first one.
          if (o.x < headX - 50 && !hasDucked) {
            hasDucked = true;
            hintObstacle = null;
            markLearned(DUCKED_KEY);
          }
          if (o.x < -60) obstacles.splice(i, 1);
        }
      }

      const hit = hitFrom(spine);
      if (hit) gameOver(hit);
    }

    /* --- scenery --- */
    const parallax = reducedMotion ? 0 : 1;
    for (const s of stars) {
      s.x -= ws * 0.06 * parallax * dt;
      s.tw += dt * 2.2;
      if (s.x < -4) { s.x = worldW + Math.random() * 40; s.y = 6 + Math.random() * (GROUND_Y * 0.72); }
    }
    for (const c of clouds) {
      c.x -= ws * 0.22 * parallax * dt;
      if (c.x < -90) {
        c.x = worldW + 40 + Math.random() * 160;
        c.y = 18 + Math.random() * (GROUND_Y * 0.45);
        c.s = 0.6 + Math.random() * 0.8;
      }
    }
    for (const p of pebbles) {
      p.x -= ws * dt;
      if (p.x < -20) {
        p.x = worldW + Math.random() * 90;
        p.y = 5 + Math.random() * 26;
        p.len = 3 + Math.random() * 12;
      }
    }

    /* --- particles --- */
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      p.x += (p.vx - (p.drift ? ws : 0)) * dt;
      p.y += p.vy * dt;
    }
  }

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */

  function roundRectPath(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  function drawBackground() {
    ctx.fillStyle = skyGrad || pal.sky1;
    ctx.fillRect(0, 0, worldW, WORLD_H);

    if (pal.stars > 0.02) {
      ctx.fillStyle = '#ffffff';
      for (const s of stars) {
        ctx.globalAlpha = pal.stars * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(s.tw)));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = pal.cloud;
    for (const c of clouds) {
      const r = 9 * c.s;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.arc(c.x + r * 1.1, c.y + r * 0.25, r * 0.78, 0, Math.PI * 2);
      ctx.arc(c.x - r * 1.05, c.y + r * 0.3, r * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGround() {
    // Overdrawn past every edge so a shake offset never reveals bare canvas.
    ctx.fillStyle = pal.ground;
    ctx.fillRect(-12, GROUND_Y, worldW + 24, WORLD_H - GROUND_Y + 14);

    ctx.fillStyle = pal.groundDark;
    ctx.fillRect(-12, GROUND_Y, worldW + 24, 2.5);

    ctx.strokeStyle = pal.pebble;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const p of pebbles) {
      ctx.moveTo(p.x, GROUND_Y + p.y);
      ctx.lineTo(p.x + p.len, GROUND_Y + p.y);
    }
    ctx.stroke();
  }

  function drawBaguette(x, h, w, lean) {
    const y = GROUND_Y - h;
    ctx.save();
    ctx.translate(x + w / 2, GROUND_Y);
    ctx.rotate(lean);
    ctx.translate(-(x + w / 2), -GROUND_Y);

    const g = ctx.createLinearGradient(x, y, x + w, y);
    g.addColorStop(0, COL.crustDark);
    g.addColorStop(0.35, COL.crust);
    g.addColorStop(0.75, COL.crumb);
    g.addColorStop(1, COL.crustDark);

    roundRectPath(x, y, w, h, w / 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = COL.crustDark;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Scored slashes across the crust.
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = COL.crustDark;
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    const slashes = Math.max(2, Math.round(h / 15));
    for (let i = 0; i < slashes; i++) {
      const sy = y + (h * (i + 0.5)) / slashes;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.16, sy + w * 0.28);
      ctx.lineTo(x + w * 0.84, sy - w * 0.28);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
  }

  function drawMeteorRock(x, o, vxMag) {
    const len = Math.hypot(vxMag, o.vy) || 1;
    const dx = vxMag / len;                // opposite the direction of travel
    const dy = -o.vy / len;
    const flick = 0.85 + Math.sin(worm.wave * 3.1 + o.spin) * 0.15;
    const L = o.r * 3.4 * flick;

    const tipX = x + dx * L;
    const tipY = o.y + dy * L;
    const px = -dy * o.r * 0.85;
    const py = dx * o.r * 0.85;

    const fg = ctx.createLinearGradient(x, o.y, tipX, tipY);
    fg.addColorStop(0, COL.flameMid);
    fg.addColorStop(1, COL.flameOuter);
    ctx.beginPath();
    ctx.moveTo(x + px, o.y + py);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(x - px, o.y - py);
    ctx.closePath();
    ctx.fillStyle = fg;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x + px * 0.5, o.y + py * 0.5);
    ctx.lineTo(x + dx * L * 0.55, o.y + dy * L * 0.55);
    ctx.lineTo(x - px * 0.5, o.y - py * 0.5);
    ctx.closePath();
    ctx.fillStyle = COL.flameCore;
    ctx.fill();

    // Rock.
    ctx.save();
    ctx.translate(x, o.y);
    ctx.rotate(o.spin);
    ctx.beginPath();
    for (let i = 0; i < o.verts.length; i++) {
      const a = (i / o.verts.length) * Math.PI * 2;
      const rr = o.r * o.verts[i];
      const vX = Math.cos(a) * rr;
      const vY = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(vX, vY); else ctx.lineTo(vX, vY);
    }
    ctx.closePath();
    ctx.fillStyle = COL.rock;
    ctx.fill();
    ctx.strokeStyle = COL.rockDark;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.fillStyle = COL.rockDark;
    for (const c of o.craters) {
      ctx.beginPath();
      ctx.arc(Math.cos(c.a) * o.r * c.d, Math.sin(c.a) * o.r * c.d, o.r * c.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Leading edge catches the light.
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(x - o.r * 0.35, o.y + o.r * 0.3, o.r * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = COL.rockLight;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Runs a smooth curve through a polyline, assuming the path is already at
  // points[0]. Quadratic segments hung off the midpoints keep the body reading
  // as one flowing surface rather than a chain of straight facets.
  function smoothThrough(points) {
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  // One closed path around the whole body: down one edge, across the tail tip,
  // back up the other edge, then a round cap over the nose.
  function tubePath(pts) {
    const n = pts.length;
    const near = [];
    const far = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      near.push({ x: p.x + p.nx * p.r, y: p.y + p.ny * p.r });
      far.push({ x: p.x - p.nx * p.r, y: p.y - p.ny * p.r });
    }

    ctx.beginPath();
    ctx.moveTo(near[0].x, near[0].y);
    smoothThrough(near);
    ctx.lineTo(far[n - 1].x, far[n - 1].y);
    smoothThrough(far.slice().reverse());

    const h = pts[0];
    const ang = Math.atan2(h.ny, h.nx);
    ctx.arc(h.x, h.y, h.r, ang + Math.PI, ang, false);
    ctx.closePath();
  }

  // A hue sweep running head-to-tail along the spine, drifting over time. Built
  // per frame because both endpoints move with the body.
  function rainbowGradient(pts, light, alpha) {
    const head = pts[0];
    const tail = pts[pts.length - 1];
    const g = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
    const shift = (worm.wave * 24) % 360;
    for (let i = 0; i <= 6; i++) {
      const hue = (shift + i * 60) % 360;
      g.addColorStop(i / 6, `hsla(${hue}, 82%, ${light}%, ${alpha})`);
    }
    return g;
  }

  function drawWorm(pts) {
    const dead = state === 'over';
    const skin = SKINS[skinIndex];
    const rainbow = !!skin.rainbow && !dead;

    const fill = dead ? COL.bodyDead : (rainbow ? rainbowGradient(pts, 58, 1) : skin.body);
    const edge = dead ? COL.bodyDeadDark : (rainbow ? rainbowGradient(pts, 30, 1) : skin.dark);
    const sheen = dead ? 'rgba(255,255,255,0.18)' : (rainbow ? 'rgba(255,255,255,0.75)' : skin.light);

    tubePath(pts);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Segment rings, clipped to the body so they can't spill past the outline.
    ctx.save();
    tubePath(pts);
    ctx.clip();
    ctx.strokeStyle = edge;
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = 1.6;
    for (let i = 2; i < pts.length - 2; i += 2) {
      const p = pts[i];
      ctx.beginPath();
      ctx.moveTo(p.x + p.nx * p.r, p.y + p.ny * p.r);
      ctx.lineTo(p.x - p.nx * p.r, p.y - p.ny * p.r);
      ctx.stroke();
    }
    ctx.restore();

    // Sheen: a slimmer tube riding the upper flank, so the highlight follows
    // every bend of the wave instead of sitting in fixed blobs.
    tubePath(pts.map((p) => ({
      x: p.x - p.nx * p.r * 0.36,
      y: p.y - p.ny * p.r * 0.36,
      r: p.r * 0.26,
      nx: p.nx,
      ny: p.ny,
    })));
    ctx.globalAlpha = dead ? 0.16 : 0.45;
    ctx.fillStyle = sheen;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Head details, oriented to the head's tangent so they bank with the wave.
    const h = pts[0];
    const fx = h.ny;
    const fy = -h.nx;
    const ex = h.x + fx * h.r * 0.3 - h.nx * h.r * 0.36;
    const ey = h.y + fy * h.r * 0.3 - h.ny * h.r * 0.36;
    const er = Math.max(1.8, h.r * 0.27);

    if (dead) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ex - er, ey - er); ctx.lineTo(ex + er, ey + er);
      ctx.moveTo(ex + er, ey - er); ctx.lineTo(ex - er, ey + er);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#22301f';
      ctx.beginPath();
      ctx.arc(ex + er * 0.3, ey, er * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Mouth.
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(h.x + h.r * 0.28, h.y + h.r * 0.28, h.r * 0.34, -0.5, 1.1);
    ctx.stroke();
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Paints the obstacle that ended the run in hot white, fading out — so the
  // answer to "what hit me?" is on screen before the game-over card arrives.
  function drawCulprit(o) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, flash) * 0.85;
    ctx.fillStyle = '#fff6e8';
    ctx.strokeStyle = '#ff5a3c';
    ctx.lineWidth = 3;

    if (o.type === 'baguette') {
      for (const p of o.parts) {
        roundRectPath(o.x + p.dx, GROUND_Y - p.h, p.w, p.h, p.w / 2);
        ctx.fill();
        ctx.stroke();
      }
    } else if (o.type === 'arch') {
      roundRectPath(o.x, GROUND_Y - o.loaf.h, o.loaf.w, o.loaf.h, o.loaf.w / 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(o.x + o.w / 2, o.rock.y, o.rock.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      for (const rock of o.rocks) {
        ctx.beginPath();
        ctx.arc(o.x, rock.y, rock.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // First-run prompt over the first shower, since nothing else tells you a
  // shower has to be gone under rather than over.
  function drawHint(o, label) {
    const y = o.type === 'arch' ? GROUND_Y - 172 : GROUND_Y - 96;
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.45 * Math.sin(performance.now() / 140);
    ctx.fillStyle = '#22301f';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.font = '700 19px ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeText(label, o.x, y);
    ctx.fillText(label, o.x, y);
    ctx.restore();
  }

  function draw() {
    // Sky first and unshaken: it covers the whole canvas, so the shake below
    // can never expose an unpainted edge.
    drawBackground();

    ctx.save();
    if (shake > 0 && !reducedMotion) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }

    drawGround();

    for (const o of obstacles) {
      if (o.type === 'baguette') {
        for (const p of o.parts) drawBaguette(o.x + p.dx, p.h, p.w, p.lean);
      } else if (o.type === 'arch') {
        drawBaguette(o.x, o.loaf.h, o.loaf.w, o.loaf.lean);
        drawMeteorRock(o.x + o.w / 2, o.rock, o.vxMag);
      } else {
        for (const rock of o.rocks) drawMeteorRock(o.x, rock, o.vxMag);
      }
    }

    if (culprit && flash > 0) drawCulprit(culprit);

    drawWorm(spine);
    drawParticles();

    if (state === 'running' && hintObstacle && performance.now() < hintUntil
        && obstacles.includes(hintObstacle)) {
      drawHint(hintObstacle, hintText);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * Input
   * ------------------------------------------------------------------ */

  function setPaused(on) {
    if (state !== 'running' || paused === on) return;
    paused = on;
    if (on) jumpSources.clear();   // the release will be missed while paused
    last = 0;                      // resume without a dt spike
    setOverlay();
  }

  function doJump() {
    worm.vy = JUMP_V;
    worm.onGround = false;
    dust(headX - 8, GROUND_Y, 5);
    sfx.jump();
  }

  function pressJump(source = 'key') {
    if (state === 'ready') { start(); return; }
    if (state === 'over') {
      if (performance.now() - overAt > 500) reset(true);
      return;
    }
    if (paused) { setPaused(false); return; }
    jumpSources.add(source);
    if (worm.onGround) doJump();
    else jumpBuffer = JUMP_BUFFER;   // held, and spent on landing
  }

  function releaseJump(source = 'key') {
    jumpSources.delete(source);
    // Only an actual full release should cut the arc.
    if (jumpHeld()) return;
    if (state === 'running' && !worm.onGround && worm.vy < 0) worm.vy *= JUMP_CUT;
  }

  function setDuck(on) {
    const want = state === 'running' ? on : false;
    if (want && !worm.ducking && worm.onGround) sfx.duck();
    // Ducking after an early jump press means the player changed their mind;
    // the later input wins rather than surfacing on the next landing.
    if (want) jumpBuffer = 0;
    worm.ducking = want;
  }

  addEventListener('keydown', (e) => {
    const c = e.code;
    const isJump = c === 'Space' || c === 'ArrowUp' || c === 'KeyW';
    const isDuck = c === 'ArrowDown' || c === 'KeyS';
    if (isJump || isDuck) e.preventDefault();
    if (e.repeat) return;
    if (isJump) pressJump('key');
    else if (isDuck) setDuck(true);
    else if (c === 'KeyP' || c === 'Escape') setPaused(!paused);
    else if ((c === 'Enter' || c === 'KeyR') && state !== 'running') pressJump('key');
  });

  addEventListener('keyup', (e) => {
    const c = e.code;
    if (c === 'Space' || c === 'ArrowUp' || c === 'KeyW') releaseJump('key');
    else if (c === 'ArrowDown' || c === 'KeyS') setDuck(false);
  });

  function bindPad(el, down, up) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      down();
    });
    const release = () => { el.classList.remove('active'); up(); };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bindPad(btnJump, () => pressJump('pad'), () => releaseJump('pad'));
  bindPad(btnDuck, () => setDuck(true), () => setDuck(false));

  btnMute.addEventListener('click', () => {
    setMuted(!muted);
    if (!muted) sfx.point();       // confirm it's back on
  });
  setMuted(muted);

  function setSkin(i) {
    skinIndex = ((i % SKINS.length) + SKINS.length) % SKINS.length;
    const skin = SKINS[skinIndex];
    swatch.style.background = skin.swatch || skin.body;
    btnSkin.setAttribute('aria-label', `Worm colour: ${skin.name}. Tap to change.`);
    btnSkin.title = skin.name;
    try { localStorage.setItem(SKIN_KEY, String(skinIndex)); } catch { /* private mode */ }
  }

  btnPause.addEventListener('click', () => setPaused(!paused));
  btnSkin.addEventListener('click', () => setSkin(skinIndex + 1));
  setSkin(skinIndex);

  stage.addEventListener('pointerdown', (e) => { e.preventDefault(); pressJump('stage'); });
  stage.addEventListener('pointerup', () => releaseJump('stage'));
  stage.addEventListener('pointercancel', () => releaseJump('stage'));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // Hybrid laptops report a fine pointer but may still be touched; reveal the
  // pads the first time a real touch happens.
  addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') document.body.classList.add('touch');
  }, { capture: true, once: true });

  /* ------------------------------------------------------------------ *
   * Main loop
   * ------------------------------------------------------------------ */

  let last = 0;

  function frame(now) {
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  addEventListener('resize', resize);
  addEventListener('orientationchange', resize);
  if (window.visualViewport) visualViewport.addEventListener('resize', resize);
  // Losing focus swallows the keyup, which would leave 'key' held forever.
  addEventListener('blur', () => { jumpSources.clear(); setDuck(false); });

  document.addEventListener('visibilitychange', () => {
    last = 0;
    // Coming back to a running game mid-obstacle is an unfair death, so a
    // hidden tab pauses rather than resuming straight into play.
    if (document.hidden) setPaused(true);
  });

  resize();
  reset(false);
  requestAnimationFrame(frame);
})();
