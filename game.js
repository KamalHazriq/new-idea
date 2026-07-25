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

  const GRAVITY = 2050;
  const JUMP_V = -600;           // apex ≈ 88 units, hang time ≈ 0.58 s
  const JUMP_CUT = 0.45;         // vy kept when jump is released early
  const FAST_FALL = 1.9;         // extra gravity while ducking mid-air

  const START_SPEED = 300;
  const MAX_SPEED = 820;
  const ACCEL = 6;               // units/s gained per second

  const SEGMENTS = 10;
  const SEG_SPACING = 10;        // body length ≈ 100 units — short enough to
                                 // leave road visible in a narrow phone world,
                                 // tight enough that the segments stay fused
  const HEAD_R = 11;
  const STAND_H = 22;            // head centre above the ground, standing
  const DUCK_H = 10;             // …and flattened

  const BAGUETTE_MIN_H = 34;
  const BAGUETTE_MAX_H = 62;

  const METEOR_H = 42;           // centre above ground once it levels off
  const METEOR_R = 14;
  const METEOR_FALL_RUN = 300;   // horizontal distance the dive takes, at any speed
  const METEOR_UNLOCK = 260;     // score at which meteors join in
  const METEOR_CHANCE = 0.34;

  const SCORE_RATE = 0.06;
  const HI_KEY = 'wormrunner.hi';

  const COL = {
    sky0: '#dceffb', sky1: '#fdf4e2',
    cloud: 'rgba(255, 255, 255, 0.9)',
    ground: '#7d6c56', groundDark: '#5e5040', pebble: '#9c8a71',
    body: '#5fbf5f', bodyDark: '#2f7a3c', bodyLight: '#95e48f',
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

  const worm = { y: GROUND_Y - STAND_H, vy: 0, onGround: true, ducking: false, duckT: 0, wave: 0 };
  const trail = [];              // [{ d, y }] ascending by d — head height history
  const obstacles = [];
  const particles = [];
  const clouds = [];
  const pebbles = [];

  const MAX_LOOKBACK = SEGMENTS * SEG_SPACING * 1.6;

  function readHi() {
    try { return parseInt(localStorage.getItem(HI_KEY), 10) || 0; } catch { return 0; }
  }

  function writeHi(v) {
    try { localStorage.setItem(HI_KEY, String(v)); } catch { /* private mode */ }
  }

  function pad5(n) { return String(Math.floor(n)).padStart(5, '0'); }

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

    skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    skyGrad.addColorStop(0, COL.sky0);
    skyGrad.addColorStop(1, COL.sky1);

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
  }

  function start() {
    state = 'running';
    overAt = 0;
    setOverlay();
  }

  function gameOver() {
    state = 'over';
    overAt = performance.now();
    worm.ducking = false;
    burst(headX, worm.y, 14, COL.bodyDark);
    if (Math.floor(score) > hiScore) {
      hiScore = Math.floor(score);
      writeHi(hiScore);
    }
    updateHud();
    setOverlay();
  }

  function setOverlay() {
    if (state === 'running') {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    if (state === 'ready') {
      overlayTitle.textContent = 'Worm Runner';
      overlaySub.textContent = 'Jump the baguettes. Duck the meteors.';
      overlayHint.textContent = 'Press Space or tap to start';
    } else {
      overlayTitle.textContent = 'GAME OVER';
      overlaySub.textContent = `Score ${pad5(score)}  ·  Best ${pad5(hiScore)}`;
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

  function wormPoints() {
    // Ducking shrinks the body; spacing barely stretches, because segments that
    // drift further apart than their radii stop reading as one animal.
    const spacing = SEG_SPACING * (1 + 0.05 * worm.duckT);
    const baseR = HEAD_R * (1 - 0.38 * worm.duckT);
    const amp = (7 - 4 * worm.duckT) * (worm.onGround ? 1 : 0.45);
    const pts = [];

    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / (SEGMENTS - 1);
      // The tail whips wider than the head — that's what sells the wriggle.
      const a = amp * (0.55 + 0.75 * t);
      pts.push({
        x: headX - i * spacing,
        y: sampleTrail(traveled - i * spacing) + Math.sin(worm.wave - i * 0.72) * a,
        r: baseR * (i === 0 ? 1.05 : 1 - 0.42 * t),
      });
    }
    return pts;
  }

  /* ------------------------------------------------------------------ *
   * Obstacles
   * ------------------------------------------------------------------ */

  function spawnObstacle() {
    if (score >= METEOR_UNLOCK && Math.random() < METEOR_CHANCE) spawnMeteor();
    else spawnBaguettes();

    // Gap measured in time-to-arrive, so high speeds stay fair.
    spawnGap = speed * (0.78 + Math.random() * 0.85);
  }

  function spawnBaguettes() {
    const count = Math.random() < 0.58 ? 1 : (Math.random() < 0.7 ? 2 : 3);
    const parts = [];
    let dx = 0;
    for (let i = 0; i < count; i++) {
      const w = 16 + Math.random() * 8;
      const h = BAGUETTE_MIN_H + Math.random() * (BAGUETTE_MAX_H - BAGUETTE_MIN_H);
      parts.push({ dx, w, h, lean: (Math.random() - 0.5) * 0.16 });
      dx += w + 3 + Math.random() * 5;
    }
    obstacles.push({ type: 'baguette', x: worldW + 20, w: dx, parts });
  }

  function spawnMeteor() {
    const startY = -30;
    const targetY = GROUND_Y - METEOR_H;
    const vxMag = vx() * 1.06;
    // Scale the dive so it always covers the same horizontal run — the player
    // gets the same warning at 300 units/s as at 800.
    const vy = (targetY - startY) * vxMag / (METEOR_FALL_RUN * widthFactor);

    const verts = [];
    for (let i = 0; i < 9; i++) verts.push(1 - Math.random() * 0.3);

    const craters = [];
    for (let i = 0; i < 3; i++) {
      craters.push({
        a: Math.random() * Math.PI * 2,
        d: Math.random() * 0.5,
        r: 0.13 + Math.random() * 0.14,
      });
    }

    obstacles.push({
      type: 'meteor',
      x: worldW + 30, y: startY, targetY, vy, vxMag,
      r: METEOR_R, verts, craters, spin: Math.random() * Math.PI * 2,
    });
  }

  /* ------------------------------------------------------------------ *
   * Particles
   * ------------------------------------------------------------------ */

  function burst(x, y, n, color) {
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
    for (let i = 0; i < n && particles.length < 140; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 14,
        y,
        vx: 20 + Math.random() * 70,
        vy: -20 - Math.random() * 70,
        r: 1.5 + Math.random() * 2.5,
        life: 0.25 + Math.random() * 0.3,
        max: 0.55,
        color: COL.pebble,
        grav: 700,
        drift: true,
      });
    }
  }

  function spark(x, y) {
    if (particles.length > 130) return;
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

  function hitsAnything(pts) {
    // Only the leading segments can hit — the tail trails harmlessly behind.
    const probes = [];
    for (let i = 0; i < 4 && i < pts.length; i++) {
      probes.push({ x: pts[i].x, y: pts[i].y, r: pts[i].r * 0.82 });
    }

    for (const o of obstacles) {
      if (o.type === 'baguette') {
        if (o.x > headX + 40 || o.x + o.w < headX - 60) continue;
        for (const p of o.parts) {
          const rx = o.x + p.dx;
          const ry = GROUND_Y - p.h;
          for (const c of probes) {
            if (circleRect(c.x, c.y, c.r, rx, ry, p.w, p.h)) return true;
          }
        }
      } else {
        if (Math.abs(o.x - headX) > 90) continue;
        for (const c of probes) {
          if (circleCircle(c.x, c.y, c.r, o.x, o.y, o.r * 0.84)) return true;
        }
      }
    }
    return false;
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
      }
      updateHud();
    }

    traveled += ws * dt;
    // Wriggle faster as the worm speeds up, so the gait stays believable.
    worm.wave += dt * (5 + ws * 0.022);

    /* --- worm --- */
    const wantDuck = worm.ducking && worm.onGround && state === 'running';
    worm.duckT += ((wantDuck ? 1 : 0) - worm.duckT) * Math.min(1, dt * 16);

    if (state !== 'over') {
      if (!worm.onGround) {
        worm.vy += GRAVITY * dt;
        if (worm.ducking) worm.vy += GRAVITY * (FAST_FALL - 1) * dt;
        worm.y += worm.vy * dt;
        if (worm.y >= restY()) {
          worm.y = restY();
          worm.vy = 0;
          worm.onGround = true;
          dust(headX - 6, GROUND_Y, 7);
        }
      } else {
        worm.y += (restY() - worm.y) * Math.min(1, dt * 18);
      }
    }
    pushTrail();

    /* --- obstacles --- */
    if (state === 'running') {
      spawnGap -= speed * dt;
      if (spawnGap <= 0) spawnObstacle();

      for (let i = obstacles.length - 1; i >= 0; i--) {
        const o = obstacles[i];
        if (o.type === 'baguette') {
          o.x -= ws * dt;
          if (o.x + o.w < -40) obstacles.splice(i, 1);
        } else {
          o.vxMag = ws * 1.06;
          o.x -= o.vxMag * dt;
          o.spin += dt * 3.2;
          if (o.y < o.targetY) {
            o.y = Math.min(o.targetY, o.y + o.vy * dt);
            if (o.y >= o.targetY) o.vy = 0;
          }
          if (Math.random() < 0.6) spark(o.x + o.r * 0.8, o.y - o.r * 0.3);
          if (o.x < -60) obstacles.splice(i, 1);
        }
      }

      if (hitsAnything(wormPoints())) gameOver();
    }

    /* --- scenery --- */
    for (const c of clouds) {
      c.x -= ws * 0.22 * dt;
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
    ctx.fillStyle = skyGrad || COL.sky1;
    ctx.fillRect(0, 0, worldW, WORLD_H);

    ctx.fillStyle = COL.cloud;
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
    ctx.fillStyle = COL.ground;
    ctx.fillRect(0, GROUND_Y, worldW, WORLD_H - GROUND_Y);

    ctx.fillStyle = COL.groundDark;
    ctx.fillRect(0, GROUND_Y, worldW, 2.5);

    ctx.strokeStyle = COL.pebble;
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

  function drawMeteor(o) {
    const len = Math.hypot(o.vxMag, o.vy) || 1;
    const dx = o.vxMag / len;              // opposite the direction of travel
    const dy = -o.vy / len;
    const flick = 0.85 + Math.sin(worm.wave * 3.1 + o.spin) * 0.15;
    const L = o.r * 3.4 * flick;

    const tipX = o.x + dx * L;
    const tipY = o.y + dy * L;
    const px = -dy * o.r * 0.85;
    const py = dx * o.r * 0.85;

    const fg = ctx.createLinearGradient(o.x, o.y, tipX, tipY);
    fg.addColorStop(0, COL.flameMid);
    fg.addColorStop(1, COL.flameOuter);
    ctx.beginPath();
    ctx.moveTo(o.x + px, o.y + py);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(o.x - px, o.y - py);
    ctx.closePath();
    ctx.fillStyle = fg;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(o.x + px * 0.5, o.y + py * 0.5);
    ctx.lineTo(o.x + dx * L * 0.55, o.y + dy * L * 0.55);
    ctx.lineTo(o.x - px * 0.5, o.y - py * 0.5);
    ctx.closePath();
    ctx.fillStyle = COL.flameCore;
    ctx.fill();

    // Rock.
    ctx.save();
    ctx.translate(o.x, o.y);
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
    ctx.arc(o.x - o.r * 0.35, o.y + o.r * 0.3, o.r * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = COL.rockLight;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawWorm(pts) {
    const dead = state === 'over';
    const fill = dead ? COL.bodyDead : COL.body;
    const edge = dead ? COL.bodyDeadDark : COL.bodyDark;

    // Outline pass first, body pass on top — the union of the circles ends up
    // with one clean silhouette instead of a stack of overlapping strokes.
    ctx.fillStyle = edge;
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = fill;
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sheen along the top of the body.
    ctx.fillStyle = dead ? 'rgba(255,255,255,0.18)' : COL.bodyLight;
    ctx.globalAlpha = 0.55;
    for (let i = pts.length - 1; i >= 1; i--) {
      const p = pts[i];
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - p.r * 0.35, p.r * 0.55, p.r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Head details.
    const h = pts[0];
    const ex = h.x + h.r * 0.34;
    const ey = h.y - h.r * 0.3;
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

  function draw() {
    drawBackground();
    drawGround();

    for (const o of obstacles) {
      if (o.type === 'baguette') {
        for (const p of o.parts) drawBaguette(o.x + p.dx, p.h, p.w, p.lean);
      } else {
        drawMeteor(o);
      }
    }

    drawWorm(wormPoints());
    drawParticles();
  }

  /* ------------------------------------------------------------------ *
   * Input
   * ------------------------------------------------------------------ */

  function pressJump() {
    if (state === 'ready') { start(); return; }
    if (state === 'over') {
      if (performance.now() - overAt > 500) reset(true);
      return;
    }
    if (worm.onGround) {
      worm.vy = JUMP_V;
      worm.onGround = false;
      dust(headX - 8, GROUND_Y, 5);
    }
  }

  function releaseJump() {
    if (state === 'running' && !worm.onGround && worm.vy < 0) worm.vy *= JUMP_CUT;
  }

  function setDuck(on) {
    worm.ducking = state === 'running' ? on : false;
  }

  addEventListener('keydown', (e) => {
    const c = e.code;
    const isJump = c === 'Space' || c === 'ArrowUp' || c === 'KeyW';
    const isDuck = c === 'ArrowDown' || c === 'KeyS';
    if (isJump || isDuck) e.preventDefault();
    if (e.repeat) return;
    if (isJump) pressJump();
    else if (isDuck) setDuck(true);
    else if ((c === 'Enter' || c === 'KeyR') && state !== 'running') pressJump();
  });

  addEventListener('keyup', (e) => {
    const c = e.code;
    if (c === 'Space' || c === 'ArrowUp' || c === 'KeyW') releaseJump();
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

  bindPad(btnJump, pressJump, releaseJump);
  bindPad(btnDuck, () => setDuck(true), () => setDuck(false));

  stage.addEventListener('pointerdown', (e) => { e.preventDefault(); pressJump(); });
  stage.addEventListener('pointerup', releaseJump);
  stage.addEventListener('pointercancel', releaseJump);
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
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  addEventListener('resize', resize);
  addEventListener('orientationchange', resize);
  if (window.visualViewport) visualViewport.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { last = 0; });

  resize();
  reset(false);
  requestAnimationFrame(frame);
})();
