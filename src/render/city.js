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
    while (x < limit) {
      const w = preset.minW + rnd() * (preset.maxW - preset.minW);
      const h = preset.minH + rnd() * (preset.maxH - preset.minH);
      const top = groundY - h;
      buildings.push({ x, w, top, h });

      ctx.fillStyle = bodyColor;
      ctx.fillRect(x, top, w, totalH - top);

      // A single lit edge, one pixel of it, does most of the work of making a
      // flat rectangle read as a building rather than a hole.
      ctx.fillStyle = edgeColor;
      ctx.fillRect(x, top, Math.max(1, w * 0.012), totalH - top);
      ctx.fillRect(x, top, w, Math.max(1, 2 - li * 0.3));

      // Roof furniture. Cheap, and it is what stops a skyline reading as a
      // bar chart.
      if (rnd() < 0.32 && li >= 1) {
        const aw = 2 + rnd() * 3;
        const ah = 14 + rnd() * 46;
        const ax = x + w * (0.2 + rnd() * 0.6);
        ctx.fillStyle = bodyColor;
        ctx.fillRect(ax, top - ah, aw, ah);
      }
      if (rnd() < 0.18 && li >= 2) {
        const bw = w * (0.18 + rnd() * 0.22);
        const bh = 10 + rnd() * 22;
        ctx.fillStyle = bodyColor;
        ctx.fillRect(x + w * 0.1 + rnd() * (w * 0.6), top - bh, bw, bh);
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
