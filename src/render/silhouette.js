/**
 * SILHOUETTE — the shipping character renderer.
 *
 * Consumes `pose.joints` and nothing else. Same seam as figure.js and
 * sprite-figure.js, so the three stay interchangeable.
 *
 * WHY THIS IS NOT A STACK OF CAPSULES
 *
 * The previous version drew twelve tapered capsules and filled each one. That
 * has two failures that are obvious once you see them at play size:
 *
 *   1. The outline BREAKS at every joint. Two capsules meeting at an elbow
 *      overlap as two convex blobs, so the contour has a notch on the inside
 *      of the bend and a step on the outside. It reads as a skeleton with
 *      thickness rather than as a body.
 *   2. Limbs are uniform tubes. A real arm has a deltoid at the top and a
 *      wrist at the bottom; a real leg has a calf. Linear taper from root to
 *      tip gives you neither, so every limb reads as the same rubber tube at a
 *      different length.
 *
 * The fix is one continuous outline per limb CHAIN, not per bone. Each chain
 * is sampled along its arc length, given a radius from an anatomical profile,
 * and offset to left and right by that radius using a tangent that is BLENDED
 * across the joint. The blend is what removes the crease: the normal rotates
 * smoothly through the bend instead of jumping, so the contour has no corner
 * even though the centreline still does — and the centreline staying exact is
 * what keeps the bone lengths the simulation solved for.
 *
 * WINDING
 *
 * Everything is accumulated into ONE path and filled ONCE. That is the only
 * way to get rid of the seams entirely: separate fills of overlapping opaque
 * shapes still show an antialiased join along every overlap edge, because each
 * fill blends its own edge against what is already there.
 *
 * One path means winding matters. Canvas fills nonzero, so two overlapping
 * subpaths wound in OPPOSITE directions cancel to a hole — which is exactly
 * what you get if you mix `arc()` (positive) with an offset ribbon (negative).
 * Rather than reason about the orientation of each shape, every loop goes
 * through emitLoop(), which measures its own signed area and reverses itself
 * when needed. Circles are emitted as polygons through the same path for the
 * same reason; at these radii 20 segments is past the point of visibility.
 *
 * ALLOCATION
 *
 * Nothing here allocates per frame. All the scratch below is module-level and
 * reused; a limb is built, emitted, and the buffers are overwritten by the
 * next limb.
 */

/** Samples along a two-bone limb chain. */
const LIMB_SAMPLES = 26;
/** Upper bound on points in a single emitted loop. */
const MAX_LOOP = 192;

// --- Scratch (module-level, reused every loop, never reallocated) ----------
const _cx = new Float64Array(LIMB_SAMPLES);
const _cy = new Float64Array(LIMB_SAMPLES);
const _nx = new Float64Array(LIMB_SAMPLES);
const _ny = new Float64Array(LIMB_SAMPLES);
const _cr = new Float64Array(LIMB_SAMPLES);
const _lx = new Float64Array(MAX_LOOP);
const _ly = new Float64Array(MAX_LOOP);
let _n = 0;

function push(x, y) {
  if (_n >= MAX_LOOP) return;
  _lx[_n] = x;
  _ly[_n] = y;
  _n++;
}

/**
 * Emit the accumulated loop as a subpath of `ctx`'s current path, normalised
 * to negative signed area so every subpath in the body agrees and nonzero fill
 * unions them instead of punching holes.
 */
function emitLoop(ctx) {
  if (_n < 3) {
    _n = 0;
    return;
  }
  let a2 = 0;
  for (let i = 0, j = _n - 1; i < _n; j = i++) {
    a2 += _lx[j] * _ly[i] - _lx[i] * _ly[j];
  }
  if (a2 > 0) {
    // Reverse in place. Cheap, and it keeps the emit order the only thing the
    // shape builders have to think about.
    for (let i = 0, j = _n - 1; i < j; i++, j--) {
      const tx = _lx[i];
      const ty = _ly[i];
      _lx[i] = _lx[j];
      _ly[i] = _ly[j];
      _lx[j] = tx;
      _ly[j] = ty;
    }
  }
  ctx.moveTo(_lx[0], _ly[0]);
  for (let i = 1; i < _n; i++) ctx.lineTo(_lx[i], _ly[i]);
  ctx.closePath();
  _n = 0;
}

/* ------------------------------------------------------------------ *
 * Anatomical radius profiles                                          *
 * ------------------------------------------------------------------ */

/**
 * Flat [t, radius, t, radius, ...] pairs, t in [0,1] along the chain's arc
 * length, strictly increasing. Flat arrays rather than objects so sampling
 * never touches the allocator.
 *
 * The numbers are the point of this file. Read them as an anatomy chart:
 * the arm swells at the deltoid, narrows above the elbow, swells again through
 * the forearm belly and ends at a wrist half the width of the shoulder. The
 * leg is thickest at the glute, has its second mass in the calf BELOW the
 * knee, and ends at an ankle. Uniform taper cannot express either shape, and
 * that is why the old capsules read as tubes.
 */
const ARM_PROFILE = [
  0.00, 7.6,   // deltoid
  0.14, 7.0,
  0.34, 5.9,
  0.50, 5.5,   // elbow
  0.64, 5.4,   // forearm belly (brachioradialis)
  0.86, 3.9,
  1.00, 3.0,   // wrist
];

const LEG_PROFILE = [
  0.00, 11.2,  // glute / hip mass
  0.16, 9.6,   // thigh belly
  0.42, 6.7,
  0.52, 6.2,   // knee
  0.66, 7.1,   // calf belly, deliberately BELOW the knee
  0.88, 3.9,
  1.00, 3.1,   // ankle
];

/**
 * The neck. Thin on purpose: at 8+ it is as wide as the head is tall and the
 * figure reads as a bull-necked lineman. It only has to bridge the trapezius
 * to the skull, and the torso's own top already covers most of that span.
 */
const NECK_PROFILE = [
  0.00, 6.6,
  0.55, 5.6,
  1.00, 6.2,
];

/** Torso half-width profile: [u along hip->neck, half-width]. */
const TORSO_PROFILE = [
  -0.05, 11.4,
  0.14, 13.7,
  0.38, 11.3,  // waist
  0.68, 15.2,  // ribcage
];

function sampleProfile(p, t) {
  if (t <= p[0]) return p[1];
  const last = p.length - 2;
  if (t >= p[last]) return p[last + 1];
  for (let i = 0; i <= last - 2; i += 2) {
    const t0 = p[i];
    const t1 = p[i + 2];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      // Smoothstep between control points: a linear ramp between two radii
      // puts a visible crease in the outline wherever the slope changes.
      const s = u * u * (3 - 2 * u);
      return p[i + 1] + (p[i + 3] - p[i + 1]) * s;
    }
  }
  return p[last + 1];
}

/* ------------------------------------------------------------------ *
 * Limb ribbon                                                         *
 * ------------------------------------------------------------------ */

/**
 * Build and emit one continuous outline through a-b-c (root, joint, tip).
 *
 * The centreline is the exact polyline, so bone lengths are untouched. Only
 * the NORMAL is smoothed, over a window around the joint proportional to the
 * limb's own radius there, which is what turns the corner into a curve.
 */
function limbRibbon(ctx, ax, ay, bx, by, cx, cy, profile, scale) {
  let d1x = bx - ax;
  let d1y = by - ay;
  const l1 = Math.hypot(d1x, d1y) || 1;
  d1x /= l1;
  d1y /= l1;

  let d2x = cx - bx;
  let d2y = cy - by;
  const l2 = Math.hypot(d2x, d2y) || 1;
  d2x /= l2;
  d2y /= l2;

  const total = l1 + l2;
  // Blend window: wide enough that the joint reads round, never wider than the
  // shorter bone (which would let the two blends overlap and flatten the limb).
  const w = Math.min(l1 * 0.85, l2 * 0.85, 14 * scale);

  for (let i = 0; i < LIMB_SAMPLES; i++) {
    const t = i / (LIMB_SAMPLES - 1);
    const s = t * total;

    let px;
    let py;
    if (s <= l1) {
      px = ax + d1x * s;
      py = ay + d1y * s;
    } else {
      px = bx + d2x * (s - l1);
      py = by + d2y * (s - l1);
    }

    let tx = s <= l1 ? d1x : d2x;
    let ty = s <= l1 ? d1y : d2y;
    if (s > l1 - w && s < l1 + w) {
      const u = (s - (l1 - w)) / (2 * w);
      const k = u * u * (3 - 2 * u);
      tx = d1x + (d2x - d1x) * k;
      ty = d1y + (d2y - d1y) * k;
      const m = Math.hypot(tx, ty) || 1;
      tx /= m;
      ty /= m;
    }

    _cx[i] = px;
    _cy[i] = py;
    _nx[i] = -ty;
    _ny[i] = tx;
    _cr[i] = sampleProfile(profile, t) * scale;
  }

  // Down the left offset...
  for (let i = 0; i < LIMB_SAMPLES; i++) {
    push(_cx[i] + _nx[i] * _cr[i], _cy[i] + _ny[i] * _cr[i]);
  }
  // ...round the tip...
  //
  // The sweep is NEGATIVE on both caps, and it has to be. n is t rotated by
  // +90 degrees, so the outward direction at the tip (+t) sits at angle(n) - 90:
  // sweeping +PI from the left offset would carry the cap back ACROSS the limb
  // instead of around its end, folding the outline over itself. A fold is not
  // a cosmetic problem here — it makes the subpath self-intersect, and under
  // nonzero fill the doubled-back region cancels to a hole. That is exactly
  // what put a dark notch at every hip, shoulder and wrist the first time.
  arcInto(_cx[LIMB_SAMPLES - 1], _cy[LIMB_SAMPLES - 1], _cr[LIMB_SAMPLES - 1],
    Math.atan2(_ny[LIMB_SAMPLES - 1], _nx[LIMB_SAMPLES - 1]), -Math.PI, 7);
  // ...back up the right offset...
  for (let i = LIMB_SAMPLES - 1; i >= 0; i--) {
    push(_cx[i] - _nx[i] * _cr[i], _cy[i] - _ny[i] * _cr[i]);
  }
  // ...and round the root.
  arcInto(_cx[0], _cy[0], _cr[0],
    Math.atan2(-_ny[0], -_nx[0]), -Math.PI, 7);

  emitLoop(ctx);
}

/** Append `steps` points of an arc of `sweep` radians from `a0`. */
function arcInto(x, y, r, a0, sweep, steps) {
  for (let i = 1; i < steps; i++) {
    const a = a0 + (sweep * i) / steps;
    push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
}

/** A circle, emitted as a polygon so it goes through the winding fixer. */
function circle(ctx, x, y, r, steps = 20) {
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  emitLoop(ctx);
}

/** An axis-oriented ellipse: `along` is a unit vector, `ra`/`rb` its radii. */
function ellipse(ctx, x, y, ax, ay, ra, rb, steps = 18) {
  const bx = -ay;
  const by = ax;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const u = Math.cos(a) * ra;
    const v = Math.sin(a) * rb;
    push(x + ax * u + bx * v, y + ay * u + by * v);
  }
  emitLoop(ctx);
}

/* ------------------------------------------------------------------ *
 * Body parts                                                          *
 * ------------------------------------------------------------------ */

/**
 * The torso as one closed shape: pelvis, waist, ribcage, then out to the real
 * shoulder joints and up into the trapezius. Built in the torso's own frame
 * (axis hip->neck, perpendicular = the front/back axis of this side view), so
 * it stays glued to the body through every rotation.
 */
function torso(ctx, j, scale) {
  const hx = j.hipC.x;
  const hy = j.hipC.y;
  let tx = j.neck.x - hx;
  let ty = j.neck.y - hy;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len;
  ty /= len;
  const px = -ty;
  const py = tx;

  // Half the shoulder span, measured off the actual joints rather than assumed
  // from the rig constants, so a rig change cannot desync the art.
  const shoulderHalf = Math.abs((j.shoulderR.x - j.neck.x) * px + (j.shoulderR.y - j.neck.y) * py);

  const at = (u, w) => push(hx + tx * len * u + px * w, hy + ty * len * u + py * w);

  for (let i = 0; i < TORSO_PROFILE.length; i += 2) {
    at(TORSO_PROFILE[i], TORSO_PROFILE[i + 1] * scale);
  }
  // Up over the shoulders and into the trapezius. Kept LOW and narrow on
  // purpose: run the torso all the way to u=1.1 at full shoulder width and the
  // head loses its neck, which is the one notch a silhouette needs to read a
  // head as a head rather than as a lump on a pair of shoulders.
  at(0.93, shoulderHalf * 0.80);
  at(1.02, shoulderHalf * 0.44);
  at(1.06, 6.6 * scale);
  at(1.06, -6.6 * scale);
  at(1.02, -shoulderHalf * 0.44);
  at(0.93, -shoulderHalf * 0.80);
  for (let i = TORSO_PROFILE.length - 2; i >= 0; i -= 2) {
    at(TORSO_PROFILE[i], -TORSO_PROFILE[i + 1] * scale);
  }
  emitLoop(ctx);
}

/**
 * A hand: an oval past the wrist, on the forearm's axis. Small, but its
 * absence is what made the arms end in a blunt stub.
 */
function hand(ctx, elbow, wrist, scale) {
  let ax = wrist.x - elbow.x;
  let ay = wrist.y - elbow.y;
  const m = Math.hypot(ax, ay) || 1;
  ax /= m;
  ay /= m;
  ellipse(ctx, wrist.x + ax * 2.6 * scale, wrist.y + ay * 2.6 * scale, ax, ay, 5.4 * scale, 3.9 * scale);
}

/**
 * A foot. `foot` in the rig is the ANKLE, so the shape is built forward of it,
 * perpendicular to the shin, in whichever direction the body is facing.
 */
function foot(ctx, knee, ankle, fwdX, fwdY, scale) {
  let sx = ankle.x - knee.x;
  let sy = ankle.y - knee.y;
  const m = Math.hypot(sx, sy) || 1;
  sx /= m;
  sy /= m;

  // Forward, with the shin component removed, so the foot is square to the leg
  // however the leg is swinging.
  const dot = fwdX * sx + fwdY * sy;
  let fx = fwdX - sx * dot;
  let fy = fwdY - sy * dot;
  const fm = Math.hypot(fx, fy);
  if (fm < 1e-4) {
    fx = -sy;
    fy = sx;
  } else {
    fx /= fm;
    fy /= fm;
  }

  const at = (a, f) =>
    push(ankle.x + sx * a * scale + fx * f * scale, ankle.y + sy * a * scale + fy * f * scale);

  // Slim. A foot drawn as thick as the ankle is wide reads as a flipper; the
  // whole shape is a wedge that is long, low, and thickest at the heel.
  at(-2.8, -2.6);  // back of the ankle
  at(3.0, -3.6);   // heel
  at(4.2, 1.4);
  at(4.0, 8.4);    // toe
  at(1.4, 8.0);    // instep
  at(-2.8, 2.2);   // front of the ankle
  emitLoop(ctx);
}

/* ------------------------------------------------------------------ *
 * The renderer                                                        *
 * ------------------------------------------------------------------ */

/**
 * Paint the whole body as a single path in `color`.
 *
 * Order does not matter for the result — the path is filled once — but the
 * far-side limbs are built first anyway so the debug overlay and any future
 * per-part shading inherit a sane back-to-front ordering.
 */
export function paintBody(ctx, j, color, scale = 1) {
  // Facing: which way the shoulder offset points along the torso's front/back
  // axis. The simulation sets it from travel direction; recovering it from the
  // joints keeps this renderer on the pose.joints seam.
  let tx = j.neck.x - j.hipC.x;
  let ty = j.neck.y - j.hipC.y;
  const tm = Math.hypot(tx, ty) || 1;
  tx /= tm;
  ty /= tm;
  const px = -ty;
  const py = tx;
  const side = (j.shoulderR.x - j.neck.x) * px + (j.shoulderR.y - j.neck.y) * py;
  const facing = side >= 0 ? 1 : -1;
  const fwdX = px * facing;
  const fwdY = py * facing;

  ctx.fillStyle = color;
  ctx.beginPath();

  limbRibbon(ctx, j.hipC.x, j.hipC.y, j.kneeL.x, j.kneeL.y, j.footL.x, j.footL.y, LEG_PROFILE, scale);
  limbRibbon(ctx, j.hipC.x, j.hipC.y, j.kneeR.x, j.kneeR.y, j.footR.x, j.footR.y, LEG_PROFILE, scale);
  foot(ctx, j.kneeL, j.footL, fwdX, fwdY, scale);
  foot(ctx, j.kneeR, j.footR, fwdX, fwdY, scale);

  torso(ctx, j, scale);

  limbRibbon(ctx, j.shoulderL.x, j.shoulderL.y, j.elbowL.x, j.elbowL.y, j.handL.x, j.handL.y, ARM_PROFILE, scale);
  limbRibbon(ctx, j.shoulderR.x, j.shoulderR.y, j.elbowR.x, j.elbowR.y, j.handR.x, j.handR.y, ARM_PROFILE, scale);
  hand(ctx, j.elbowL, j.handL, scale);
  hand(ctx, j.elbowR, j.handR, scale);

  // Neck is a degenerate two-bone chain: the midpoint is the actual midpoint,
  // so the ribbon builder does the taper without a special case.
  limbRibbon(
    ctx,
    j.neck.x, j.neck.y,
    (j.neck.x + j.head.x) * 0.5, (j.neck.y + j.head.y) * 0.5,
    j.head.x, j.head.y,
    NECK_PROFILE, scale
  );
  circle(ctx, j.head.x, j.head.y, 12.2 * scale);

  ctx.fill();
}

/**
 * THE CHARACTER RENDERER.
 *
 * @param {CanvasRenderingContext2D} ctx  Already in world space.
 * @param {{joints: Record<string,{x:number,y:number}>}} pose
 */
export function drawSilhouette(ctx, pose, opts = {}) {
  const j = pose.joints;
  const body = opts.bodyColor || '#05060c';
  const rim = opts.rimColor || '#8fc8ff';
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
