/**
 * STYLE LAB — the same frame, four art directions.
 *
 * Deliberately does NOT go through createRenderer. This is an exploration, and
 * nothing in it should push a change into shipping code before a direction is
 * chosen. It reuses createCity (palettes are already options) and
 * drawSilhouette (the seam), and composites everything else by hand.
 */
import { createSkeleton } from '../sim/skeleton.js';
import { drawSilhouette } from '../render/silhouette.js';
import { createCity } from '../render/city.js';

const TILE_W = 800;
const TILE_H = 460;

/** One settled swing pose, shared by every tile so only the styling differs. */
function swingPose() {
  const skel = createSkeleton();
  const hip = { x: 0, y: 0 };
  const anchor = { x: 150, y: -330 };
  const vel = { x: 1250, y: -120 };
  const up = { x: 0.41, y: -0.91 };
  for (let k = 0; k < 140; k++) skel.solve({ hip, anchor, vel, up, attached: true }, 1 / 60);
  return { joints: skel.joints, anchor };
}

const POSE = swingPose();

/* ------------------------------------------------------------------ *
 * Post-processing primitives                                          *
 * ------------------------------------------------------------------ */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** A dot-screen tile. Unlike the shipped one this takes a colour and a size,
 *  because the whole question here is what happens when the screen is big
 *  enough to actually see. */
function halftoneTile(cell, radius, color) {
  const t = makeCanvas(cell * 2, cell * 2);
  const c = t.getContext('2d');
  c.fillStyle = color;
  for (const [x, y] of [[cell * 0.5, cell * 0.5], [cell * 1.5, cell * 1.5]]) {
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
    c.fill();
  }
  return t;
}

/** Paper grain. One tile, generated once, tiled over the frame. */
let grainTile = null;
function grain(amount) {
  if (!grainTile) {
    grainTile = makeCanvas(180, 180);
    const c = grainTile.getContext('2d');
    const img = c.createImageData(180, 180);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }
  return grainTile;
}

/* ------------------------------------------------------------------ *
 * The four directions                                                 *
 * ------------------------------------------------------------------ */

const STYLES = [
  {
    name: 'A — current (baseline)',
    note: 'halftone at 0.05 alpha, chroma off. The comic pass is present and effectively invisible.',
    city: { skyTop: '#0b1020', skyBottom: '#2a1f3d', buildingColor: '#080a14', windowColor: '#ffd9a0' },
    body: '#05060c', rim: '#8fc8ff', web: '#e8f2ff',
    halftone: { cell: 5, radius: 1.2, color: '#ffffff', alpha: 0.05, op: 'overlay' },
    grain: 0,
    misreg: 0,
  },
  {
    name: 'B — newsprint',
    note: 'cream stock, three inks, a dot screen you can actually see. Nostalgic in the specific way a 1970s floppy comic is.',
    city: { skyTop: '#f4e7c8', skyBottom: '#e6cf9c', buildingColor: '#22406b', windowColor: '#d8452f' },
    body: '#151019', rim: '#d8452f', web: '#2b2028',
    halftone: { cell: 7, radius: 2.5, color: '#8a5a3c', alpha: 0.3, op: 'multiply' },
    grain: 0.11,
    misreg: 0,
    paper: '#f4e7c8',
  },
  {
    name: 'C — vector noir',
    note: 'one saturated sky, black shapes, no texture at all. Reads at any size, including a 200px thumbnail in a feed.',
    city: { skyTop: '#c8452e', skyBottom: '#3a0d18', buildingColor: '#0a0508', windowColor: '#ffb43c' },
    body: '#07040a', rim: '#ff8a3c', web: '#ffd9a0',
    halftone: null,
    grain: 0,
    misreg: 0,
  },
  {
    name: 'D — risograph duotone',
    note: 'two inks on off-white, deliberate misregistration, heavy grain. The most "printed" of the four.',
    city: { skyTop: '#f0ebe2', skyBottom: '#f7c3d0', buildingColor: '#2b3a8c', windowColor: '#ff4d8d' },
    body: '#1b2470', rim: '#ff4d8d', web: '#2b3a8c',
    halftone: { cell: 6, radius: 2.0, color: '#2b3a8c', alpha: 0.22, op: 'multiply' },
    grain: 0.16,
    misreg: 3.2,
    paper: '#f0ebe2',
  },
  {
    name: 'E — noir + print (C palette, B texture)',
    note: 'the hybrid. C separates the figure; B stops it looking computer-generated.',
    city: { skyTop: '#d4502f', skyBottom: '#33101c', buildingColor: '#0a0508', windowColor: '#ffc247' },
    body: '#07040a', rim: '#ff9640', web: '#ffe2b0',
    halftone: { cell: 6, radius: 2.1, color: '#1a0a10', alpha: 0.17, op: 'multiply' },
    grain: 0.1,
    misreg: 2.2,
  },
  {
    name: 'F — magic hour (same recipe, cool key)',
    note: 'proof the recipe is a SYSTEM, not one lucky palette. Swap two colours per track or per section.',
    city: { skyTop: '#1b3a8f', skyBottom: '#f2795c', buildingColor: '#0a0812', windowColor: '#ffd98a' },
    body: '#08060f', rim: '#ffca6b', web: '#fff0cf',
    halftone: { cell: 6, radius: 2.1, color: '#0f0a1a', alpha: 0.17, op: 'multiply' },
    grain: 0.1,
    misreg: 2.2,
  },
];

/* ------------------------------------------------------------------ *
 * Draw                                                                *
 * ------------------------------------------------------------------ */

const cityCache = new Map();
function cityFor(style, i) {
  if (!cityCache.has(i)) cityCache.set(i, createCity({ ...style.city, seed: 20240817 }));
  return cityCache.get(i);
}

function drawTile(ctx, style, i) {
  const city = cityFor(style, i);
  const cam = { x: 900, y: 560 };
  const scale = (TILE_H / 1080) * 1.5;

  // Sky.
  const g = ctx.createLinearGradient(0, 0, 0, TILE_H);
  g.addColorStop(0, style.city.skyTop);
  g.addColorStop(1, style.city.skyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TILE_W, TILE_H);

  // City layers.
  for (const layer of city.layers) {
    const p = layer.parallax;
    const tileW = layer.width * scale;
    const originX = TILE_W * 0.5 - cam.x * p * scale;
    const originY = TILE_H * 0.5 - cam.y * p * scale;
    const drawH = layer.height * scale;
    const first = Math.floor((0 - originX) / tileW);
    const last = Math.ceil((TILE_W - originX) / tileW);
    for (let t = first; t <= last; t++) {
      ctx.drawImage(layer.canvas, originX + t * tileW, originY, tileW, drawH);
    }
    const bottom = originY + drawH;
    if (bottom < TILE_H) {
      ctx.fillStyle = layer.bodyColor;
      ctx.fillRect(0, bottom - 1, TILE_W, TILE_H - bottom + 1);
    }
  }

  // Figure + web, in world space.
  const fig = () => {
    ctx.save();
    ctx.translate(TILE_W * 0.5, TILE_H * 0.52);
    ctx.scale(scale * 1.9, scale * 1.9);
    ctx.strokeStyle = style.web;
    ctx.lineWidth = 2.4 / (scale * 1.9);
    ctx.beginPath();
    ctx.moveTo(POSE.joints.handR.x, POSE.joints.handR.y);
    ctx.lineTo(POSE.anchor.x, POSE.anchor.y);
    ctx.stroke();
    drawSilhouette(ctx, POSE, { bodyColor: style.body, rimColor: style.rim });
    ctx.restore();
  };

  if (style.misreg > 0) {
    // Offset ink plates: the same art printed twice, slightly out of register.
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = 'multiply';
    ctx.translate(style.misreg, -style.misreg * 0.6);
    fig();
    ctx.restore();
  }
  fig();

  // Halftone, screen space.
  if (style.halftone) {
    const h = style.halftone;
    const pat = ctx.createPattern(halftoneTile(h.cell, h.radius, h.color), 'repeat');
    ctx.save();
    ctx.globalCompositeOperation = h.op;
    ctx.globalAlpha = h.alpha;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, TILE_W, TILE_H);
    ctx.restore();
  }

  // Grain.
  if (style.grain > 0) {
    const pat = ctx.createPattern(grain(), 'repeat');
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = style.grain;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, TILE_W, TILE_H);
    ctx.restore();
  }
}

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#111';
ctx.fillRect(0, 0, 1600, 1380);

STYLES.forEach((style, i) => {
  const ox = (i % 2) * TILE_W;
  const oy = Math.floor(i / 2) * TILE_H;
  const tile = makeCanvas(TILE_W, TILE_H);
  drawTile(tile.getContext('2d'), style, i);
  ctx.drawImage(tile, ox, oy);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(ox, oy, TILE_W, 30);
  ctx.fillStyle = '#fff';
  ctx.font = '15px ui-monospace, Menlo, monospace';
  ctx.fillText(style.name, ox + 12, oy + 20);
});
