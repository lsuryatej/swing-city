/**
 * RENDER — Canvas 2D silhouette + parallax city. No WebGL, no dependencies.
 *
 * Performance rules held throughout:
 *   - devicePixelRatio capped at 2. Beyond that you are shading four times the
 *     pixels for a difference nobody can see.
 *   - ctx.shadowBlur is NEVER touched in the frame loop. It is a full-canvas
 *     gaussian per draw call and it will destroy the frame budget on its own.
 *     Glows are pre-rendered to an offscreen sprite once and blitted.
 *   - Nothing allocates per frame: every vector, array and snapshot below is
 *     created at construction and mutated in place.
 *
 * The character seam: drawSilhouette() reads pose.joints and NOTHING else.
 * When this is swapped for a detailed Miles, the physics does not move.
 */

import { BONES, JOINT_NAMES } from '../sim/skeleton.js';
import { createCity, createSky, CITY_DEFAULTS } from './city.js';
import { WORLD_HEIGHT } from '../contract.js';

/** Cap on devicePixelRatio. */
export const MAX_DPR = 2;

/** Pose sampling rate for "on twos" — 12fps, two frames of 24. The camera and
 *  the city keep running at display rate; only the character is stepped. This
 *  is the Spider-Verse trick, and it reads as deliberate rather than janky
 *  precisely because everything AROUND the character stays smooth. */
export const TWOS_HZ = 12;

export const RENDER_DEFAULTS = {
  onTwos: true,
  parallax: true,
  debug: false,
  reducedMotion: false,
  /** World height mapped to the viewport height, before zoom. */
  zoom: 1.25,
  /** Camera spring half-life, seconds. */
  cameraHalfLife: 0.28,
  /** Seconds of velocity to lead the camera by. Look-ahead is what stops the
   *  character sitting dead centre like a tracking shot from a tripod. */
  lookAhead: 0.38,
  /** Camera is biased upward so there is room to see the arc below. */
  verticalBias: -70,
  bodyColor: '#05060c',
  rimColor: '#8fc8ff',
  webColor: '#e8f2ff',
  accentColor: '#ff4d5e',
};

/** Bone radii: [rootRadius, tipRadius] in world units. Tapering is what makes
 *  a stack of capsules read as a body instead of a balloon animal. */
const BONE_RADII = {
  'hipC>neck': [14, 10.5],
  'neck>head': [9, 9],
  'neck>shoulderL': [8, 7],
  'neck>shoulderR': [8, 7],
  'shoulderL>elbowL': [7, 5.4],
  'elbowL>handL': [5.4, 3.4],
  'shoulderR>elbowR': [7, 5.4],
  'elbowR>handR': [5.4, 3.4],
  'hipC>kneeL': [9, 6.2],
  'kneeL>footL': [6.2, 3.6],
  'hipC>kneeR': [9, 6.2],
  'kneeR>footR': [6.2, 3.6],
};

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Pre-render a soft radial glow once. This exists so that nothing in the frame
 * loop ever needs shadowBlur.
 */
export function createGlowSprite(radius, color, alpha = 1) {
  const size = radius * 2;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  g.addColorStop(0, color);
  g.addColorStop(0.35, color);
  g.addColorStop(1, 'transparent');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(radius, radius, radius, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/**
 * A tapered capsule from (x0,y0) radius r0 to (x1,y1) radius r1.
 * Two half-circle arcs joined by the straight sides; the arcs are swept in
 * opposite directions so the path closes without a self-intersection.
 */
export function taperedCapsule(ctx, x0, y0, r0, x1, y1, r1) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const h = Math.PI / 2;
  ctx.beginPath();
  ctx.arc(x0, y0, r0, a + h, a - h);
  ctx.arc(x1, y1, r1, a - h, a + h);
  ctx.closePath();
}

/**
 * THE CHARACTER RENDERER.
 *
 * Consumes `pose.joints` and nothing else about the simulation — no phase, no
 * theta, no anchor. Everything it needs to know about the body's state is
 * already in where the 13 joints are. That is the whole point of the seam.
 *
 * @param {CanvasRenderingContext2D} ctx  Already in world space.
 * @param {{joints: Record<string,{x:number,y:number}>}} pose
 */
export function drawSilhouette(ctx, pose, opts = {}) {
  const j = pose.joints;
  const body = opts.bodyColor || RENDER_DEFAULTS.bodyColor;
  const rim = opts.rimColor || RENDER_DEFAULTS.rimColor;
  const rimOffsetX = opts.rimOffsetX ?? -2.2;
  const rimOffsetY = opts.rimOffsetY ?? -3.2;
  const scale = opts.figureScale || 1;

  // The rim light is the same silhouette drawn once behind the body, offset a
  // couple of units toward the light. Cheap, stable, and it does not need a
  // stroke pass per bone or any blur at all.
  ctx.save();
  ctx.translate(rimOffsetX, rimOffsetY);
  paintBody(ctx, j, rim, scale);
  ctx.restore();

  paintBody(ctx, j, body, scale);
}

function paintBody(ctx, j, color, scale) {
  ctx.fillStyle = color;

  for (let i = 0; i < BONES.length; i++) {
    const [a, b] = BONES[i];
    const pa = j[a];
    const pb = j[b];
    if (!pa || !pb) continue;
    const r = BONE_RADII[`${a}>${b}`];
    if (!r) continue;
    taperedCapsule(ctx, pa.x, pa.y, r[0] * scale, pb.x, pb.y, r[1] * scale);
    ctx.fill();
  }

  // Torso mass: the shoulder span filled as a wedge down to the hips, so the
  // chest is not just two sticks meeting at the neck.
  ctx.beginPath();
  ctx.moveTo(j.shoulderL.x, j.shoulderL.y);
  ctx.lineTo(j.shoulderR.x, j.shoulderR.y);
  ctx.lineTo(j.hipC.x, j.hipC.y);
  ctx.closePath();
  ctx.fill();

  // Head last, so it sits on top of the neck capsule cleanly.
  ctx.beginPath();
  ctx.arc(j.head.x, j.head.y, 13 * scale, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Bright wireframe over the top of the silhouette: bones, joints, anchor and
 * web line. Kept entirely separate from drawSilhouette so the seam stays clean.
 */
export function drawDebugSkeleton(ctx, pose, opts = {}) {
  const j = pose.joints;
  const lw = opts.lineWidth || 2;

  ctx.lineWidth = lw;
  ctx.strokeStyle = '#00ff9d';
  ctx.beginPath();
  for (let i = 0; i < BONES.length; i++) {
    const [a, b] = BONES[i];
    ctx.moveTo(j[a].x, j[a].y);
    ctx.lineTo(j[b].x, j[b].y);
  }
  ctx.stroke();

  ctx.fillStyle = '#ffe14d';
  for (let i = 0; i < JOINT_NAMES.length; i++) {
    const p = j[JOINT_NAMES[i]];
    ctx.beginPath();
    ctx.arc(p.x, p.y, lw * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  if (pose.anchor && pose.hip) {
    // Web line and anchor cross.
    ctx.strokeStyle = '#ff3ea5';
    ctx.beginPath();
    ctx.moveTo(pose.anchor.x, pose.anchor.y);
    ctx.lineTo(pose.hip.x, pose.hip.y);
    ctx.stroke();

    const s = 14;
    ctx.strokeStyle = '#ff3ea5';
    ctx.beginPath();
    ctx.moveTo(pose.anchor.x - s, pose.anchor.y);
    ctx.lineTo(pose.anchor.x + s, pose.anchor.y);
    ctx.moveTo(pose.anchor.x, pose.anchor.y - s);
    ctx.lineTo(pose.anchor.x, pose.anchor.y + s);
    ctx.stroke();
  }

  if (pose.velocity) {
    ctx.strokeStyle = '#4dc3ff';
    ctx.beginPath();
    ctx.moveTo(j.hipC.x, j.hipC.y);
    ctx.lineTo(j.hipC.x + pose.velocity.x * 0.12, j.hipC.y + pose.velocity.y * 0.12);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ *
 * The renderer                                                        *
 * ------------------------------------------------------------------ */

export function createRenderer(canvas, options = {}) {
  const opts = { ...RENDER_DEFAULTS, ...options };
  const ctx = canvas.getContext('2d', { alpha: false });

  const city = createCity(options.city || CITY_DEFAULTS);
  const sky = createSky(city.config);
  const anchorGlow = createGlowSprite(90, 'rgba(140,200,255,0.5)');
  const figureGlow = createGlowSprite(160, 'rgba(60,110,200,0.28)');

  // --- Persistent state -------------------------------------------------
  const cam = { x: 0, y: WORLD_HEIGHT * 0.5, vx: 0, vy: 0 };
  const camTarget = { x: 0, y: 0 };
  let dpr = 1;
  let vw = 1;
  let vh = 1;
  let scale = 1;

  // "On twos" snapshot: a second set of 13 joint objects, allocated once and
  // overwritten at TWOS_HZ. The pose passed to drawSilhouette is this one.
  const snapJoints = {};
  for (const n of JOINT_NAMES) snapJoints[n] = { x: 0, y: 0 };
  const snapshot = {
    joints: snapJoints,
    anchor: { x: 0, y: 0 },
    hip: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    webProgress: 1,
    phase: 'swing',
  };
  let twosAccum = 0;
  let snapped = false;

  // Velocity estimate derived from the hip joint alone, so the camera does not
  // reach past the joints seam either.
  const lastHip = { x: 0, y: 0 };
  const hipVel = { x: 0, y: 0 };
  let haveLastHip = false;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const rect = canvas.getBoundingClientRect();
    vw = Math.max(1, Math.round(rect.width));
    vh = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    scale = (vh / WORLD_HEIGHT) * opts.zoom;
  }

  /** Exact critically-damped step, same maths as the skeleton springs. */
  function camStep(axis, target, halfLife, dt) {
    const y = 2.4 / Math.max(halfLife, 1e-4);
    const j0 = cam[axis] - target;
    const j1 = cam['v' + axis] + j0 * y;
    const e = Math.exp(-y * dt);
    cam[axis] = target + (j0 + j1 * dt) * e;
    cam['v' + axis] = (cam['v' + axis] - j1 * y * dt) * e;
  }

  function updateCamera(hip, dt) {
    if (!haveLastHip) {
      lastHip.x = hip.x;
      lastHip.y = hip.y;
      cam.x = hip.x;
      cam.y = hip.y + opts.verticalBias;
      haveLastHip = true;
    }
    if (dt > 1e-5) {
      // Smoothed finite difference; a raw one is far too noisy to lead with.
      const k = Math.min(1, dt * 8);
      hipVel.x += ((hip.x - lastHip.x) / dt - hipVel.x) * k;
      hipVel.y += ((hip.y - lastHip.y) / dt - hipVel.y) * k;
    }
    lastHip.x = hip.x;
    lastHip.y = hip.y;

    camTarget.x = hip.x + hipVel.x * opts.lookAhead;
    camTarget.y = hip.y + hipVel.y * opts.lookAhead * 0.35 + opts.verticalBias;

    camStep('x', camTarget.x, opts.cameraHalfLife, dt);
    camStep('y', camTarget.y, opts.cameraHalfLife * 1.5, dt);
  }

  function drawCity() {
    const halfW = vw * 0.5;
    const halfH = vh * 0.5;

    for (let i = 0; i < city.layers.length; i++) {
      const layer = city.layers[i];
      // With parallax off, every layer moves with the world: the skyline is
      // still there, it just stops sliding against itself.
      const p = opts.parallax && !opts.reducedMotion ? layer.parallax : 1;
      const tileW = layer.width * scale;
      const originX = halfW - cam.x * p * scale;
      const originY = halfH - cam.y * p * scale;
      const drawH = layer.height * scale;

      const first = Math.floor((0 - originX) / tileW);
      const last = Math.ceil((vw - originX) / tileW);
      for (let t = first; t <= last; t++) {
        ctx.drawImage(layer.canvas, originX + t * tileW, originY, tileW, drawH);
      }
    }
  }

  function drawWeb(pose) {
    if (pose.phase === 'flight') return;
    const hand = pose.joints.handR;
    const a = pose.anchor;
    // During the 'anchor' phase the web is still shooting out, so draw only
    // the fraction of the line that has arrived.
    const p = pose.phase === 'anchor' ? pose.webProgress : 1;
    const ex = hand.x + (a.x - hand.x) * p;
    const ey = hand.y + (a.y - hand.y) * p;

    ctx.strokeStyle = opts.webColor;
    ctx.lineWidth = 2.2 / scale + 0.6;
    ctx.beginPath();
    ctx.moveTo(hand.x, hand.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    if (p >= 1) {
      const r = 90;
      ctx.drawImage(anchorGlow, a.x - r, a.y - r, r * 2, r * 2);
    }
  }

  /**
   * @param {object} state
   * @param {object} state.pose  A Pose from the swinger.
   * @param {number} state.dt    Real frame delta, seconds.
   */
  function render(state) {
    const { pose } = state;
    const dt = Math.min(state.dt || 1 / 60, 0.1);

    updateCamera(pose.joints.hipC, dt);

    // --- Character sampling ----------------------------------------------
    // The camera above and the city below run at display rate; only this is
    // quantised.
    twosAccum += dt;
    const interval = 1 / TWOS_HZ;
    if (!opts.onTwos) {
      copyPose(pose, snapshot);
      snapped = true;
    } else if (!snapped || twosAccum >= interval) {
      twosAccum = twosAccum % interval;
      copyPose(pose, snapshot);
      snapped = true;
    }

    // --- Draw --------------------------------------------------------------
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(sky, 0, 0, 1, 256, 0, 0, vw, vh);

    drawCity();

    // World space: origin at the camera, scaled, centred on the viewport.
    ctx.setTransform(
      scale * dpr,
      0,
      0,
      scale * dpr,
      (vw * 0.5 - cam.x * scale) * dpr,
      (vh * 0.5 - cam.y * scale) * dpr
    );

    const gr = 160;
    ctx.drawImage(
      figureGlow,
      snapshot.joints.hipC.x - gr,
      snapshot.joints.hipC.y - gr,
      gr * 2,
      gr * 2
    );

    drawWeb(snapshot);
    drawSilhouette(ctx, snapshot, opts);

    if (opts.debug) {
      ctx.lineWidth = 2 / scale;
      drawDebugSkeleton(ctx, snapshot, { lineWidth: 2 / scale });
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function copyPose(src, dst) {
    const sj = src.joints;
    for (let i = 0; i < JOINT_NAMES.length; i++) {
      const n = JOINT_NAMES[i];
      dst.joints[n].x = sj[n].x;
      dst.joints[n].y = sj[n].y;
    }
    dst.anchor.x = src.anchor.x;
    dst.anchor.y = src.anchor.y;
    dst.hip.x = src.hip.x;
    dst.hip.y = src.hip.y;
    if (src.velocity) {
      dst.velocity.x = src.velocity.x;
      dst.velocity.y = src.velocity.y;
    }
    dst.webProgress = src.webProgress;
    dst.phase = src.phase;
  }

  resize();

  return {
    render,
    resize,
    options: opts,
    setOption(k, v) {
      opts[k] = v;
    },
    camera: cam,
    city,
    get dpr() {
      return dpr;
    },
    get scale() {
      return scale;
    },
  };
}
