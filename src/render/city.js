/**
 * CITY — procedural parallax skyline.
 *
 * Each depth layer is generated ONCE into an offscreen canvas one tile wide,
 * then drawn per frame as two or three translated blits. Regenerating geometry
 * per frame would be the single most expensive thing in this project and buys
 * nothing: the skyline does not change.
 *
 * Tiles are seamless by construction — every building is fully contained
 * within the tile, and the generator leaves a gap at both edges, so the repeat
 * boundary looks like any other gap between buildings.
 */

/** Deterministic PRNG so a given seed always produces the same city. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Layer definitions, far to near. `parallax` is the fraction of camera motion
 * the layer moves by: 0 would be painted on the sky, 1 moves with the world.
 * `haze` blends the layer toward the sky colour to fake aerial perspective,
 * which does more for the sense of depth than the parallax itself does.
 */
/**
 * Depth layers, far to near.
 *
 * Gaps are deliberately tight and widths modest. A skyline reads as a CITY
 * when buildings crowd and overlap, and as scattered blocks when they are
 * evenly spaced with daylight between them. Five layers rather than four,
 * the extra one far back, so the horizon has depth instead of ending in
 * flat sky.
 */
export const LAYER_PRESETS = [
  { parallax: 0.06, haze: 0.88, minH: 140, maxH: 300, minW: 34, maxW: 84, gap: 3, baseY: 0.98, windows: 0.0 },
  { parallax: 0.12, haze: 0.78, minH: 180, maxH: 420, minW: 38, maxW: 96, gap: 4, baseY: 1.0, windows: 0.06 },
  { parallax: 0.28, haze: 0.55, minH: 260, maxH: 560, minW: 46, maxW: 118, gap: 6, baseY: 1.02, windows: 0.3 },
  { parallax: 0.52, haze: 0.3, minH: 340, maxH: 720, minW: 60, maxW: 152, gap: 9, baseY: 1.05, windows: 0.6 },
  { parallax: 0.85, haze: 0.08, minH: 420, maxH: 900, minW: 78, maxW: 196, gap: 13, baseY: 1.12, windows: 0.85 },
];

/** Mix two #rrggbb colours. */
function mix(a, b, t) {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * CROWNS — everything above the roof deck.
 *
 * A flat-topped rectangle reads as a bar chart no matter how it is coloured,
 * because the ONE thing a real skyline never does is stop every building at
 * the same kind of edge. Real roofs carry water tanks, mechanical housings,
 * masts, and — on the taller/older stock — a stepped crown the tower itself
 * narrows into. None of this can touch `buildings[]`: that array is the
 * webbing surface, and a crown drawn above `b.top` just means the character
 * lands on the terrace below the ornament, which is exactly what a real
 * water-tower roof or setback terrace would offer anyway.
 *
 * Every function below draws in the building's OWN [x, x+w] span, centred or
 * inset from it, and never wider than it — that is what keeps a spire from
 * ever being able to cross a tile edge, without needing a clamp at the call
 * site. Where a shape could plausibly overshoot (a mast's crossbar, a
 * parapet's teeth) it clamps itself; see `clampSpan`.
 */

/** Pull [left, left+width] back inside [x, x+w] without resizing it unless
 *  it is wider than the building itself (only possible for absurd rnd() rolls
 *  on tiny buildings, but cheap to guard rather than assume). */
function clampSpan(left, width, x, w) {
  const cw = Math.min(width, w);
  const cl = Math.max(x, Math.min(left, x + w - cw));
  return [cl, cw];
}

/** A thin mast, occasionally with one crossbar — a radio mast rather than a
 *  bare pole. Silhouette-only: no blinking light, because this file only
 *  ever draws once and a light that doesn't blink is just a dot. */
function crownMast(ctx, b, rnd, bodyColor) {
  const { x, w, top } = b;
  const aw = 2 + rnd() * 2.6;
  const ah = 16 + rnd() * 58;
  const ax = x + w * (0.24 + rnd() * 0.5);
  ctx.fillStyle = bodyColor;
  ctx.fillRect(ax, top - ah, aw, ah);
  if (rnd() < 0.45) {
    const [cl, cw] = clampSpan(ax - aw * 1.6, aw * (3.4 + rnd() * 1.6), x, w);
    ctx.fillRect(cl, top - ah * (0.32 + rnd() * 0.28), cw, Math.max(1, aw * 0.6));
  }
}

/** A water tank on short legs — the single most recognisable roofline shape
 *  on a real skyline and, at silhouette scale, cheap: three verticals and a
 *  four-point drum read as a tank even though nothing is actually round. */
function crownWaterTower(ctx, b, rnd, bodyColor) {
  const { x, w, top } = b;
  const drumW = Math.min(w * (0.22 + rnd() * 0.12), w * 0.4);
  const drumH = drumW * (0.6 + rnd() * 0.25);
  const legH = 10 + rnd() * 20;
  const cx = x + w * (0.3 + rnd() * 0.4); // stays within [x+0.1w, x+0.9w] given drumW <= 0.4w
  const legSpread = drumW * 0.7;
  const legW = Math.max(1, drumW * 0.06);
  ctx.fillStyle = bodyColor;
  for (const i of [-1, 0, 1]) {
    ctx.fillRect(cx + i * legSpread * 0.42 - legW / 2, top - legH, legW, legH);
  }
  const deckY = top - legH;
  ctx.beginPath();
  ctx.moveTo(cx - drumW * 0.46, deckY);
  ctx.lineTo(cx + drumW * 0.46, deckY);
  ctx.lineTo(cx + drumW * 0.5, deckY - drumH);
  ctx.lineTo(cx - drumW * 0.5, deckY - drumH);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - drumW * 0.5, deckY - drumH);
  ctx.lineTo(cx + drumW * 0.5, deckY - drumH);
  ctx.lineTo(cx, deckY - drumH * 1.45);
  ctx.closePath();
  ctx.fill();
}

/** A mechanical penthouse — the boxy elevator/HVAC housing that sits on top
 *  of almost every real flat roof. Inset from both edges so it never reaches
 *  the building's own sides, let alone the tile edge. */
function crownPenthouse(ctx, b, rnd, bodyColor, edgeColor) {
  const { x, w, top } = b;
  const bw = w * (0.18 + rnd() * 0.24);
  const bh = 10 + rnd() * 24;
  const bx = x + w * 0.08 + rnd() * (w * 0.6 - bw);
  ctx.fillStyle = bodyColor;
  ctx.fillRect(bx, top - bh, bw, bh);
  if (rnd() < 0.4) {
    ctx.fillStyle = edgeColor;
    ctx.fillRect(bx, top - bh, Math.max(1, bw * 0.05), bh);
  }
}

/** A raised parapet lip, with the odd tooth of roof machinery poking above
 *  it. Height is deliberately small — this is the crown for layers too far
 *  back to spend pixels on anything taller, so it reads as texture on the
 *  roofline rather than a silhouette feature of its own. */
function crownParapet(ctx, b, rnd, bodyColor) {
  const { x, w, top } = b;
  const ph = 3 + rnd() * 5;
  ctx.fillStyle = bodyColor;
  ctx.fillRect(x, top - ph, w, ph);
  const teeth = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < teeth; i++) {
    const tw = w * (0.05 + rnd() * 0.06);
    const th = ph + 3 + rnd() * 8;
    const [tl, tcw] = clampSpan(x + w * (0.15 + rnd() * 0.7) - tw / 2, tw, x, w);
    ctx.fillRect(tl, top - th, tcw, th);
  }
}

/**
 * Stepped tiers narrowing upward from the roof — the art-deco setback crown
 * (few, wide steps, often finished with a spire) and the ziggurat variant
 * (more, thinner steps, no spire) are the same function at different tier
 * counts and shrink rates, which is enough to make them read as different
 * buildings rather than parameter noise.
 *
 * Each tier is centred on the building's own centreline and is always
 * narrower than the one below it, so by induction every tier — and any spire
 * on top of the last one — stays inside [x, x+w]. No clamp needed here,
 * unlike the flatter crowns above.
 */
function crownSetback(ctx, b, rnd, bodyColor, { tiers, shrinkMin, shrinkMax, spireChance }) {
  const { x, w, top } = b;
  const cx = x + w * 0.5;
  let curW = w;
  let curTop = top;
  for (let i = 0; i < tiers; i++) {
    const stepW = curW * (shrinkMin + rnd() * (shrinkMax - shrinkMin));
    const stepH = 12 + rnd() * 26;
    ctx.fillStyle = bodyColor;
    ctx.fillRect(cx - stepW * 0.5, curTop - stepH, stepW, stepH);
    curW = stepW;
    curTop -= stepH;
  }
  if (rnd() < spireChance) {
    const mw = Math.max(1.5, curW * 0.1);
    const mh = 20 + rnd() * 46;
    ctx.fillStyle = bodyColor;
    ctx.fillRect(cx - mw / 2, curTop - mh, mw, mh);
  }
}

/**
 * Crown vocabulary, gated by layer proximity. Distant layers (small li, high
 * haze) stay near-flat on purpose — a stepped crown at haze 0.88 is a smear
 * of a few grey pixels, not a shape, so spending rnd() calls on one there
 * only costs determinism budget for nothing visible. `'none'` is repeated in
 * each pool to weight how often a building gets no ornament at all; real
 * roofs are mostly flat, and an all-ornamented skyline reads busier, not
 * more real.
 */
function pickCrownType(li, rnd, prevType) {
  const pools = [
    ['none', 'none', 'none', 'mast'],
    ['none', 'none', 'mast', 'parapet'],
    ['none', 'mast', 'parapet', 'penthouse', 'water-tower'],
    ['none', 'mast', 'penthouse', 'water-tower', 'setback', 'parapet'],
    ['mast', 'penthouse', 'water-tower', 'setback', 'ziggurat', 'parapet'],
  ];
  const pool = pools[Math.min(li, pools.length - 1)];
  let type = pool[Math.floor(rnd() * pool.length)];
  // One re-roll, not a loop until different — a loop could stall (or bias the
  // draw sequence's rnd() consumption) on a pool where every slot rolled the
  // same value; a single re-roll makes back-to-back repeats rare without
  // risking that.
  if (type === prevType && pool.length > 1) {
    type = pool[Math.floor(rnd() * pool.length)];
  }
  return type;
}

function drawCrown(ctx, b, li, rnd, bodyColor, edgeColor, prevType) {
  const type = pickCrownType(li, rnd, prevType);
  switch (type) {
    case 'mast':
      crownMast(ctx, b, rnd, bodyColor);
      break;
    case 'water-tower':
      crownWaterTower(ctx, b, rnd, bodyColor);
      break;
    case 'penthouse':
      crownPenthouse(ctx, b, rnd, bodyColor, edgeColor);
      break;
    case 'parapet':
      crownParapet(ctx, b, rnd, bodyColor);
      break;
    case 'setback':
      crownSetback(ctx, b, rnd, bodyColor, { tiers: 1 + Math.floor(rnd() * 3), shrinkMin: 0.55, shrinkMax: 0.75, spireChance: 0.5 });
      break;
    case 'ziggurat':
      crownSetback(ctx, b, rnd, bodyColor, { tiers: 3 + Math.floor(rnd() * 3), shrinkMin: 0.68, shrinkMax: 0.84, spireChance: 0 });
      break;
    default:
      break;
  }
  return type;
}

/** A lit corner facet standing in for a true chamfer. A geometric chamfer —
 *  cutting the top corner out of the body rect before the windows pass —
 *  was tried first and dropped: windows are placed by the same b.x/b.w/b.top
 *  rect after the fact, so a cut corner either needed the window grid to know
 *  about it too (a lot of machinery for a silhouette detail) or risked a
 *  window rendering half-floating past the now-missing wall behind it. Adding
 *  a small triangle of the lit edge colour on top, after the windows pass,
 *  gets the same "beveled corner catching the light" read for a fraction of
 *  the risk, at the cost of being additive rather than a real cut. */
function drawChamferAccent(ctx, b, rnd, edgeColor) {
  const { x, w, top } = b;
  const size = Math.min(w * 0.18, 14 + rnd() * 14);
  const onRight = rnd() < 0.5;
  ctx.fillStyle = edgeColor;
  ctx.beginPath();
  if (onRight) {
    ctx.moveTo(x + w - size, top);
    ctx.lineTo(x + w, top);
    ctx.lineTo(x + w, top + size);
  } else {
    ctx.moveTo(x, top);
    ctx.lineTo(x + size, top);
    ctx.lineTo(x, top + size);
  }
  ctx.closePath();
  ctx.fill();
}

export const CITY_DEFAULTS = {
  seed: 20240817,
  tileWidth: 2400,
  height: 1080,
  /** Vertical extent generated below the nominal world height, so the layers
   *  still cover the screen when the camera drops low. */
  overscan: 700,
  skyTop: '#0b1020',
  skyBottom: '#2a1f3d',
  buildingColor: '#080a14',
  windowColor: '#ffd9a0',
};

/**
 * @returns {{layers: Array, tileWidth: number, height: number, skyGradient: Function}}
 */
export function createCity(opts = {}) {
  const cfg = { ...CITY_DEFAULTS, ...opts };
  const { tileWidth, height, overscan } = cfg;
  const totalH = height + overscan;

  const layers = LAYER_PRESETS.map((preset, li) => {
    const canvas = makeCanvas(tileWidth, totalH);
    const ctx = canvas.getContext('2d');
    const rnd = mulberry32(cfg.seed + li * 9176);

    // Aerial perspective: distant layers wash out toward the sky colour.
    const bodyColor = mix(cfg.buildingColor, cfg.skyBottom, preset.haze);
    const edgeColor = mix(cfg.buildingColor, '#7fa8d8', preset.haze * 0.55 + 0.12);

    const groundY = height * preset.baseY;

    // Leave a margin at both tile edges so the repeat seam falls in a gap.
    let x = preset.gap * 2;
    const limit = tileWidth - preset.maxW - preset.gap * 2;

    ctx.fillStyle = bodyColor;
    const buildings = [];
    const chamferAccents = []; // drawn after windows — see drawChamferAccent
    let prevCrown = null;
    while (x < limit) {
      // Most buildings roll the normal footprint. A low, wide block among the
      // towers — the deliberate silhouette break a skyline needs so it doesn't
      // read as one height of tower repeated — gets its own roll, gated to
      // layers where "among the towers" actually means something (li 0/1 are
      // already short) and clamped to whatever room is left before `limit` so
      // widening it can never push a building past the tile-edge margin.
      const isLowBlock = li >= 2 && rnd() < 0.1;
      let w, h;
      if (isLowBlock) {
        w = Math.min(preset.maxW * (1.15 + rnd() * 0.55), tileWidth - preset.gap * 2 - x);
        h = preset.minH * (0.5 + rnd() * 0.22);
      } else {
        w = preset.minW + rnd() * (preset.maxW - preset.minW);
        h = preset.minH + rnd() * (preset.maxH - preset.minH);
      }
      const top = groundY - h;
      buildings.push({ x, w, top, h });

      ctx.fillStyle = bodyColor;
      ctx.fillRect(x, top, w, totalH - top);

      // A single lit edge, one pixel of it, does most of the work of making a
      // flat rectangle read as a building rather than a hole.
      ctx.fillStyle = edgeColor;
      ctx.fillRect(x, top, Math.max(1, w * 0.012), totalH - top);
      ctx.fillRect(x, top, w, Math.max(1, 2 - li * 0.3));

      // Roof crown. This is what stops a skyline reading as a bar chart — see
      // the CROWNS block above `createCity` for the shape vocabulary and why
      // none of it touches `buildings[]`.
      prevCrown = drawCrown(ctx, { x, w, top }, li, rnd, bodyColor, edgeColor, prevCrown);

      // Chamfer accents read better once they sit above the window layer —
      // see drawChamferAccent for why this is additive-after rather than
      // cut-into-the-body. Gated to nearer layers, where a corner facet is
      // large enough in pixels to actually register.
      if (li >= 2 && rnd() < 0.22) {
        chamferAccents.push({ x, w, top });
      }

      x += w + preset.gap + rnd() * preset.gap * 2.5;
    }

    // Windows, drawn in one pass at the end so the fillStyle changes once.
    if (preset.windows > 0) {
      const alpha = preset.windows * 0.5;
      ctx.fillStyle = cfg.windowColor;
      for (const b of buildings) {
        const cols = Math.max(1, Math.floor(b.w / (9 + li * 3)));
        const rows = Math.max(1, Math.floor(b.h / (14 + li * 4)));
        const cw = b.w / cols;
        const ch = b.h / rows;
        const ww = cw * 0.42;
        const wh = ch * 0.4;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (rnd() > preset.windows * 0.42) continue;
            ctx.globalAlpha = alpha * (0.35 + rnd() * 0.65);
            ctx.fillRect(
              b.x + c * cw + (cw - ww) * 0.5,
              b.top + r * ch + (ch - wh) * 0.5,
              ww,
              wh
            );
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // See drawChamferAccent: drawn last so the lit facet sits above the
    // window layer instead of being drawn over by it.
    for (const b of chamferAccents) {
      drawChamferAccent(ctx, b, rnd, edgeColor);
    }

    return {
      canvas,
      parallax: preset.parallax,
      /** Exposed so the renderer can flood below the tile — see drawCity. */
      bodyColor,
      width: tileWidth,
      height: totalH,
      groundY,
      buildings,
    };
  });

  // The layer the character actually interacts with: nearest, tallest,
  // and the one whose parallax is closest to 1:1 with world space.
  const anchorLayer = layers[layers.length - 1];

  /**
   * The next building whose roof can be webbed, at or beyond `worldX`.
   *
   * The skyline is a repeating strip `tileWidth` wide, so world x is folded
   * into the tile to find the building, and the tile offset is added back to
   * return a real world coordinate. That means the grapple targets the same
   * roofs the player can see, which is the whole point — an anchor floating in
   * empty sky is what made the old build read as abstract.
   *
   * @param {number} worldX
   * @param {number} minAhead  Ignore anything closer than this.
   * @param {number} maxAhead  Give up beyond this and let the caller improvise.
   * @returns {{x:number, y:number, w:number, h:number}|null} roof-centre point
   */
  function buildingsAheadOf(worldX, minAhead = 260, maxAhead = 1600) {
    const from = worldX + minAhead;
    const limit = worldX + maxAhead;

    // Return ALL candidate roofs in the window, tallest first.
    //
    // This used to return only the tallest, which made the motion visibly
    // loop: the skyline is a single repeating tile, so "tallest in window"
    // resolves to the same handful of buildings forever. Measured, the whole
    // city offered exactly FIVE distinct anchors (at tile offsets 114, 585,
    // 902, 1426, 2019) and the swing cycled them identically.
    //
    // Widening the tile is not an option — each layer is a pre-rendered canvas
    // and the set is already ~85MB — so variety has to come from the caller
    // choosing among candidates rather than from more geometry.
    //
    // Tallest-first still matters: roof height is the pendulum radius budget.
    const found = [];

    let tile = Math.floor(from / tileWidth);
    for (let guard = 0; guard < 4; guard++) {
      const offset = tile * tileWidth;
      for (const b of anchorLayer.buildings) {
        const centre = b.x + offset + b.w * 0.5;
        if (centre >= from && centre <= limit) {
          found.push({ x: centre, y: b.top, w: b.w, h: b.h });
        }
      }
      tile++;
      if (tile * tileWidth > limit) break;
    }

    found.sort((a, b) => a.y - b.y); // smaller y = taller
    return found;
  }

  /** Back-compat single-result form. */
  function tallestAheadOf(worldX, minAhead, maxAhead) {
    return buildingsAheadOf(worldX, minAhead, maxAhead)[0] ?? null;
  }

  return {
    layers,
    tileWidth,
    height,
    totalHeight: totalH,
    config: cfg,
    anchorLayer,
    buildingsAheadOf,
    buildingAheadOf: tallestAheadOf,
  };
}

/**
 * Draw the sky. A pre-rendered vertical gradient strip, blitted stretched,
 * because building a CanvasGradient every frame is a surprising amount of
 * garbage for something that never changes.
 */
export function createSky(cfg = CITY_DEFAULTS) {
  const strip = makeCanvas(1, 256);
  const sctx = strip.getContext('2d');
  const grad = sctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, cfg.skyTop);
  grad.addColorStop(0.65, mix(cfg.skyTop, cfg.skyBottom, 0.7));
  grad.addColorStop(1, cfg.skyBottom);
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 1, 256);
  return strip;
}
