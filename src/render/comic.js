/**
 * Spider-Verse comic pass.
 *
 * Four effects, all cheap Canvas 2D. The films' look is deliberately a PRINT
 * look rather than a rendered one — offset colour plates, visible halftone
 * screens, ink outlines, and Kirby krackle for energy — and every one of those
 * is a compositing trick rather than a shader.
 *
 * Nothing here allocates per frame in the hot path: the halftone is one
 * pre-rendered tile turned into a CanvasPattern once, and the krackle uses a
 * fixed particle pool.
 *
 * Performance note: ctx.shadowBlur is never used. It is pathologically slow in
 * Canvas 2D and every glow in this project is a pre-rendered sprite instead.
 */

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/* ------------------------------------------------------------------ *
 * Paper grain                                                         *
 * ------------------------------------------------------------------ */

/**
 * One tile of monochrome noise, to be tiled over the frame as a CanvasPattern.
 *
 * Screen space, like the halftone, and for the same reason: grain is a
 * property of the paper, not of the scene. Generated once — per-frame noise
 * would both allocate and crawl, and crawling grain reads as video compression
 * rather than as print.
 *
 * The tile is deliberately not a power of two and not square-symmetric, so the
 * repeat is hard to pick out.
 */
export function createGrain({ size = 180, spread = 255 } = {}) {
  const tile = makeCanvas(size, size);
  const c = tile.getContext('2d');
  const img = c.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * spread;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return tile;
}

/* ------------------------------------------------------------------ *
 * Halftone                                                            *
 * ------------------------------------------------------------------ */

/**
 * One tile of a dot screen, to be used as a repeating CanvasPattern.
 *
 * Drawn in SCREEN space, not world space: a halftone screen is a property of
 * the printed page, not of the scene, so it must not scale or scroll with the
 * camera. Letting it move with the world is the single most common way this
 * effect goes wrong — it stops reading as ink on paper and starts reading as
 * texture on geometry.
 */
export function createHalftone({ cell = 5, radius = 1.25, color = '#ffffff' } = {}) {
  const tile = makeCanvas(cell * 2, cell * 2);
  const c = tile.getContext('2d');
  c.fillStyle = color;

  // Two offset rows, which is what makes a dot screen read as a screen rather
  // than as a grid.
  const dots = [
    [cell * 0.5, cell * 0.5],
    [cell * 1.5, cell * 1.5],
  ];
  for (const [x, y] of dots) {
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
    c.fill();
  }
  return tile;
}

/* ------------------------------------------------------------------ *
 * Kirby krackle                                                       *
 * ------------------------------------------------------------------ */

/**
 * Clusters of energy dots, fired on musical hits.
 *
 * Krackle in the comics is black blobs with bright rims; against this dark
 * sky it reads better inverted — bright cores with a hot rim — so that is what
 * this draws. The shape language (irregular clustered circles, not a uniform
 * particle spray) is what makes it read as Kirby rather than as sparks.
 */
export function createKrackle({ max = 90 } = {}) {
  const p = new Array(max);
  for (let i = 0; i < max; i++) {
    p[i] = { x: 0, y: 0, vx: 0, vy: 0, r: 0, life: 0, ttl: 1, seed: 0 };
  }
  let next = 0;

  function burst(x, y, energy = 1, dirX = 1) {
    // Count scales with energy so a quiet beat is a flicker and a drop is a
    // proper detonation.
    const count = Math.round(6 + energy * 14);
    for (let i = 0; i < count; i++) {
      const q = p[next];
      next = (next + 1) % max;

      const a = Math.random() * Math.PI * 2;
      const speed = (60 + Math.random() * 260) * (0.5 + energy);
      q.x = x + (Math.random() - 0.5) * 40;
      q.y = y + (Math.random() - 0.5) * 40;
      // Biased against travel, so the burst trails behind him like exhaust.
      q.vx = Math.cos(a) * speed - dirX * 120;
      q.vy = Math.sin(a) * speed;
      q.r = 3 + Math.random() * (7 + energy * 9);
      q.ttl = 0.34 + Math.random() * 0.44;
      q.life = q.ttl;
      q.seed = Math.random();
    }
  }

  function update(dt) {
    for (let i = 0; i < max; i++) {
      const q = p[i];
      if (q.life <= 0) continue;
      q.life -= dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vx *= 1 - 2.4 * dt;
      q.vy *= 1 - 2.4 * dt;
    }
  }

  function draw(ctx, { core = '#ffffff', rim = '#5fb0ff' } = {}) {
    for (let i = 0; i < max; i++) {
      const q = p[i];
      if (q.life <= 0) continue;
      const t = q.life / q.ttl;
      // Pop out fast, linger, vanish. A linear fade reads as a dissolve;
      // this reads as an impact.
      const a = t * t;
      const r = q.r * (0.45 + (1 - t) * 0.9);

      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = a;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return { burst, update, draw };
}

/* ------------------------------------------------------------------ *
 * Chromatic aberration                                                *
 * ------------------------------------------------------------------ */

/**
 * Offset colour plates, the misregistered-printing look.
 *
 * `paint(color, dx, dy)` is called three times: a red plate pushed one way, a
 * cyan plate the other, then the real body on top. The two colour passes use
 * the 'lighter' composite so they ADD against the dark sky and only survive
 * where the body does not cover them — which is exactly the thin fringe at
 * each edge. Compositing normally would just paint two solid coloured bodies.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {(color:string, dx:number, dy:number)=>void} paint
 * @param {number} amount Fringe offset in world units.
 */
export function withChromatic(ctx, paint, amount, { red = '#ff2b45', cyan = '#12d9ff', alpha = 0.38 } = {}) {
  if (amount <= 0.01) {
    paint(null, 0, 0);
    return;
  }

  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;

  paint(red, -amount, amount * 0.35);
  paint(cyan, amount, -amount * 0.35);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = prev;

  paint(null, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Speed lines                                                         *
 * ------------------------------------------------------------------ */

/**
 * Horizontal ink streaks behind the character at speed.
 *
 * Screen space, drawn behind the figure. Density and length scale with speed
 * so they appear only when there is speed worth reading, which keeps them from
 * becoming wallpaper.
 */
export function createSpeedLines({ count = 22 } = {}) {
  const lines = new Array(count);
  for (let i = 0; i < count; i++) {
    lines[i] = { y: Math.random(), len: 0.3 + Math.random() * 0.7, off: Math.random() };
  }

  function draw(ctx, vw, vh, intensity, color = 'rgba(255,255,255,0.5)') {
    if (intensity <= 0.02) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (let i = 0; i < count; i++) {
      const l = lines[i];
      const y = l.y * vh;
      // Skip the middle band so the streaks frame the character rather than
      // drawing over him.
      const centreBias = Math.abs(l.y - 0.5);
      if (centreBias < 0.12) continue;
      const len = l.len * vw * 0.28 * intensity;
      const x = ((l.off + performance.now() * 0.00022 * (0.5 + l.len)) % 1.25) * vw - vw * 0.15;
      ctx.globalAlpha = intensity * 0.22 * (0.4 + centreBias);
      ctx.lineWidth = 1 + l.len * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - len, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  return { draw };
}
