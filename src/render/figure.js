/**
 * Detailed character rendering — a costumed figure instead of a flat
 * silhouette.
 *
 * Consumes exactly what drawSilhouette consumes: `pose.joints`, the same 13
 * named positions, plus `pose.velocity` for facing. Nothing about the physics,
 * the skeleton solve, or the comic pass changes. That seam is the whole reason
 * this is a drop-in swap rather than a rewrite.
 *
 * ONE ADAPTATION WORTH KNOWING
 * ----------------------------
 * Spider-Verse ink lines are DARK, and they work on the page because the
 * character sits against lighter artwork. Here the character is a near-black
 * suit against a night sky, so dark outlines would erase him.
 *
 * The fix is to use both, for different jobs:
 *   - a LIGHT rim light on the outer edge, separating the figure from the sky
 *   - DARK ink on the interior, separating the red panels from the black suit
 *
 * That keeps the ink language of the films while staying legible at night.
 *
 * SCALE
 * -----
 * The figure is roughly 190 world units tall and often renders around 150
 * screen pixels, so every detail here has to survive being small. Anything
 * finer than about 4 units disappears. The eye lenses are deliberately the
 * largest and highest-contrast element, because they are what makes a shape
 * read as this character rather than as a person.
 */

export const FIGURE_COLORS = {
  suit: '#0d0d16',
  /** Interior ink, between colour regions. Never on the outer edge. */
  ink: '#000004',
  red: '#d82b3c',
  redDeep: '#8d1a26',
  lens: '#f2f6ff',
  lensEdge: '#05060c',
  sole: '#ece6dc',
  hood: '#151a2b',
};

/** Local capsule so this module does not import from canvas.js and create a
 *  cycle. Same construction: two arcs joined by the tangent lines. */
function capsule(ctx, x0, y0, r0, x1, y1, r1) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const h = Math.PI / 2;
  ctx.beginPath();
  ctx.arc(x0, y0, r0, a + h, a - h);
  ctx.arc(x1, y1, r1, a - h, a + h);
  ctx.closePath();
}

function fillCapsule(ctx, pa, pb, r0, r1, color) {
  ctx.fillStyle = color;
  capsule(ctx, pa.x, pa.y, r0, pb.x, pb.y, r1);
  ctx.fill();
}

/** Unit vector from a to b, plus its length. */
function dir(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len, len };
}

/** Limb radii, matching the silhouette rig so proportions do not shift when
 *  switching between the two renderers. */
const R = {
  torso: [15, 11],
  head: [9.5, 9.5],
  clav: [8, 7],
  upperArm: [7, 5.4],
  foreArm: [5.4, 3.4],
  thigh: [9.5, 7],
  shin: [7, 4.4],
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{joints:Object, velocity?:{x:number,y:number}}} pose
 * @param {object} opts
 */
export function drawDetailedFigure(ctx, pose, opts = {}) {
  const j = pose.joints;
  const C = { ...FIGURE_COLORS, ...(opts.figureColors || {}) };
  const s = opts.figureScale || 1;
  const rim = opts.rimColor || '#8fc8ff';
  const hood = opts.hood !== false;

  // Which way he is looking. Facing drives the mask, so it must not flicker;
  // near-zero horizontal speed keeps the previous facing rather than snapping.
  const vx = pose.velocity?.x ?? 1;
  const facing = Math.abs(vx) < 20 ? (opts._lastFacing ?? 1) : Math.sign(vx);
  opts._lastFacing = facing;

  const r = (k, i) => R[k][i] * s;

  /* ---- 1. Rim light -------------------------------------------------- *
   * The whole body drawn once, fattened and offset toward the key light.
   * This is the OUTER edge treatment and it is what keeps a black suit
   * readable against a black sky.                                         */
  ctx.save();
  ctx.translate(-2.2 * s, -3.2 * s);
  paintBase(ctx, j, rim, s, r, 1.6 * s, hood, C);
  ctx.restore();

  /* ---- 2. Base suit --------------------------------------------------- */
  paintBase(ctx, j, C.suit, s, r, 0, hood, C);

  /* ---- 3. Red edge stripes -------------------------------------------- *
   * The signature of this suit is NOT a red chest. It is a black suit with a
   * red line running down the OUTER edge of each limb, plus a red emblem.
   * Those stripes are what shape the silhouette and what make the limbs read
   * as costumed rather than as bare shapes.
   *
   * Each stripe is a narrower capsule pushed perpendicular until it sits flush
   * against one edge of the limb beneath it, so it reads as piping on the seam
   * rather than as a band painted across the middle.                        */
  const torsoDir = dir(j.hipC, j.neck);
  const perp = { x: -torsoDir.y, y: torsoDir.x };

  stripe(ctx, j.shoulderL, j.elbowL, r('upperArm', 0), r('upperArm', 1), C.red, facing);
  stripe(ctx, j.elbowL, j.handL, r('foreArm', 0), r('foreArm', 1), C.red, facing);
  stripe(ctx, j.shoulderR, j.elbowR, r('upperArm', 0), r('upperArm', 1), C.red, facing);
  stripe(ctx, j.elbowR, j.handR, r('foreArm', 0), r('foreArm', 1), C.red, facing);
  stripe(ctx, j.hipC, j.kneeL, r('thigh', 0), r('thigh', 1), C.red, facing);
  stripe(ctx, j.kneeL, j.footL, r('shin', 0), r('shin', 1), C.red, facing);
  stripe(ctx, j.hipC, j.kneeR, r('thigh', 0), r('thigh', 1), C.red, facing);
  stripe(ctx, j.kneeR, j.footR, r('shin', 0), r('shin', 1), C.red, facing);

  // Shoulder caps: a red curve over the deltoid, which is where the arm
  // stripe originates in the reference art.
  fillCapsule(ctx, j.neck, j.shoulderL, r('clav', 0) * 0.5, r('clav', 1) * 1.08, C.red);
  fillCapsule(ctx, j.neck, j.shoulderR, r('clav', 0) * 0.5, r('clav', 1) * 1.08, C.red);

  /* ---- 4. Spider emblem ----------------------------------------------- *
   * RED, on a black chest — the single strongest identifier on the costume,
   * and the thing I originally had backwards as a black mark on a red chest.
   *
   * Drawn as a body plus three swept legs per side rather than an anatomical
   * spider. Individual legs are below the resolution that survives at this
   * size, but their combined MASS reads as a spider where a plain diamond
   * reads as a diamond.                                                     */
  const emX = j.hipC.x + torsoDir.x * torsoDir.len * 0.72;
  const emY = j.hipC.y + torsoDir.y * torsoDir.len * 0.72;
  drawSpider(ctx, emX, emY, torsoDir, perp, 8.4 * s, C.red, s);

  /* ---- 5. Shoes -------------------------------------------------------- *
   * Untied high-tops. Miles' most recognisable non-suit element, and cheap:
   * a fattened foot with a pale sole is enough at this scale.               */
  drawShoe(ctx, j.kneeL, j.footL, s, C, facing);
  drawShoe(ctx, j.kneeR, j.footR, s, C, facing);

  /* ---- 6. Hands -------------------------------------------------------- *
   * The single biggest readability win available in code.
   *
   * Splayed fingers are one of the most recognisable things about this
   * character, and without them the arms simply end in rounded stubs — which
   * is most of why the figure read as assembled tubes rather than as a person.
   * Three fingers plus a thumb is enough; at this size a fourth is a pixel.   */
  drawHand(ctx, j.elbowL, j.handL, s, C, 0.92);
  drawHand(ctx, j.elbowR, j.handR, s, C, 1);

  /* ---- 7. Mask --------------------------------------------------------- */
  drawMask(ctx, j, s, C, facing);
}

/**
 * A hand: palm plus three splayed fingers and an opposed thumb.
 *
 * The fan is built around the forearm direction so it continues the arm rather
 * than sitting on the end of it, and the spread is deliberately wide — a
 * relaxed hand disappears at this scale, a splayed one reads instantly.
 */
function drawHand(ctx, elbow, hand, s, C, depth) {
  if (!elbow || !hand) return;
  const d = dir(elbow, hand);
  const n = { x: -d.y, y: d.x };

  ctx.save();
  ctx.globalAlpha = depth;

  // Palm.
  const palm = { x: hand.x + d.x * 1.6 * s, y: hand.y + d.y * 1.6 * s };
  fillCapsule(ctx, hand, palm, 3.6 * s, 4.1 * s, C.suit);

  // Fingers, fanned about the forearm axis.
  ctx.strokeStyle = C.suit;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.1 * s;
  for (const spread of [-0.62, -0.16, 0.3]) {
    const len = (7.4 - Math.abs(spread) * 1.8) * s;
    const fx = d.x * Math.cos(spread) + n.x * Math.sin(spread);
    const fy = d.y * Math.cos(spread) + n.y * Math.sin(spread);
    ctx.beginPath();
    ctx.moveTo(palm.x, palm.y);
    ctx.lineTo(palm.x + fx * len, palm.y + fy * len);
    ctx.stroke();
  }

  // Thumb, opposed and shorter.
  ctx.lineWidth = 2.4 * s;
  const tx = d.x * Math.cos(1.15) - n.x * Math.sin(1.15);
  const ty = d.y * Math.cos(1.15) - n.y * Math.sin(1.15);
  ctx.beginPath();
  ctx.moveTo(palm.x - d.x * 1.2 * s, palm.y - d.y * 1.2 * s);
  ctx.lineTo(palm.x + tx * 4.6 * s, palm.y + ty * 4.6 * s);
  ctx.stroke();

  ctx.restore();
}

/**
 * A red edge stripe along one side of a limb.
 *
 * A narrower capsule offset perpendicular by exactly (limbRadius - stripeWidth)
 * so its far edge lands flush with the limb's edge. Offsetting less would put a
 * band across the middle of the limb, which reads as a stripe painted on rather
 * than as piping along a seam.
 */
function stripe(ctx, a, b, r0, r1, color, facing) {
  if (!a || !b) return;
  const d = dir(a, b);
  // Perpendicular, flipped to whichever side faces the camera.
  const nx = -d.y * facing;
  const ny = d.x * facing;
  // Thin. At 0.34 the stripe was nearly as wide as the limb, so the figure
  // read as a RED limb with a black core — the inverse of the reference,
  // which is a black suit with a red seam.
  const w0 = r0 * 0.2;
  const w1 = r1 * 0.2;
  const o0 = r0 - w0;
  const o1 = r1 - w1;
  fillCapsule(
    ctx,
    { x: a.x + nx * o0, y: a.y + ny * o0 },
    { x: b.x + nx * o1, y: b.y + ny * o1 },
    w0,
    w1,
    color
  );
}

/**
 * The chest spider: a body with three swept legs each side.
 *
 * `u` is the torso up-axis and `p` its perpendicular, so the emblem rotates
 * with the chest instead of staying screen-aligned.
 */
function drawSpider(ctx, cx, cy, u, p, size, color, s) {
  const at = (fwd, side) => ({
    x: cx + u.x * fwd + p.x * side,
    y: cy + u.y * fwd + p.y * side,
  });

  ctx.fillStyle = color;

  // Abdomen and thorax, the mass that actually reads at distance.
  const body = [
    [at(size * 0.05, 0), size * 0.3],
    [at(-size * 0.34, 0), size * 0.22],
    [at(size * 0.4, 0), size * 0.16],
  ];
  for (const [pt, rr] of body) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Legs, swept back and down like the emblem in the films.
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.1 * s, size * 0.11);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const spread = 0.55 + i * 0.42;
      const reach = size * (0.95 - i * 0.1);
      const from = at(size * 0.1, side * size * 0.2);
      const mid = at(size * (0.34 - i * 0.28), side * reach * 0.62);
      const end = at(size * (0.05 - spread * 0.42), side * reach);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(mid.x, mid.y, end.x, end.y);
      ctx.stroke();
    }
  }
}

/** Body shapes shared by the rim pass and the fill pass. `grow` fattens every
 *  limb, which is how the rim pass produces an outline without a stroke. */
function paintBase(ctx, j, color, s, r, grow, hood, C) {
  ctx.fillStyle = color;
  const g = grow;

  const limbs = [
    [j.hipC, j.neck, r('torso', 0), r('torso', 1)],
    [j.neck, j.shoulderL, r('clav', 0), r('clav', 1)],
    [j.neck, j.shoulderR, r('clav', 0), r('clav', 1)],
    [j.shoulderL, j.elbowL, r('upperArm', 0), r('upperArm', 1)],
    [j.elbowL, j.handL, r('foreArm', 0), r('foreArm', 1)],
    [j.shoulderR, j.elbowR, r('upperArm', 0), r('upperArm', 1)],
    [j.elbowR, j.handR, r('foreArm', 0), r('foreArm', 1)],
    [j.hipC, j.kneeL, r('thigh', 0), r('thigh', 1)],
    [j.kneeL, j.footL, r('shin', 0), r('shin', 1)],
    [j.hipC, j.kneeR, r('thigh', 0), r('thigh', 1)],
    [j.kneeR, j.footR, r('shin', 0), r('shin', 1)],
  ];

  for (const [a, b, r0, r1] of limbs) {
    if (!a || !b) continue;
    capsule(ctx, a.x, a.y, r0 + g, b.x, b.y, r1 + g);
    ctx.fill();
  }

  // Hood bunched at the back of the neck. Drawn before the head so the head
  // sits in front of it.
  if (hood) {
    const d = dir(j.neck, j.head);
    const hx = j.neck.x - d.x * 3 * s;
    const hy = j.neck.y - d.y * 3 * s;
    ctx.beginPath();
    ctx.arc(hx, hy, (11 + grow) * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // Head: an ellipse aligned to the neck->head axis, not a circle.
  //
  // A circle reads as a ball on a stick from every angle. An ellipse slightly
  // taller than it is wide, rotated with the head, gives the mask a jaw and a
  // crown — which is most of what makes a covered head read as a head.
  const hd = dir(j.neck, j.head);
  ctx.save();
  ctx.translate(j.head.x, j.head.y);
  ctx.rotate(Math.atan2(hd.y, hd.x));
  ctx.beginPath();
  ctx.ellipse(0, 0, (r('head', 0) + g) * 1.06, (r('head', 0) + g) * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * The mask, and specifically the eye lenses.
 *
 * These are the highest-contrast element on the figure by a wide margin, and
 * that is intentional: at this scale the lenses are what convert "a dark
 * humanoid shape" into "this character". Everything else on the costume is
 * supporting detail.
 */
function drawMask(ctx, j, s, C, facing) {
  const up = dir(j.neck, j.head); // neck -> head is the head's up axis
  const side = { x: -up.y * facing, y: up.x * facing }; // toward the face
  const hx = j.head.x;
  const hy = j.head.y;

  const lens = (fwd, lift, w, h, alpha) => {
    const cx = hx + side.x * fwd * s + up.x * lift * s;
    const cy = hy + side.y * fwd * s + up.y * lift * s;
    // Rotated so the lens tilts with the head rather than staying axis-aligned,
    // which is what stops it looking like a sticker.
    const ang = Math.atan2(side.y, side.x);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.globalAlpha = alpha;

    ctx.fillStyle = C.lensEdge;
    ctx.beginPath();
    ctx.ellipse(0, 0, (w + 1.1) * s, (h + 1.1) * s, -0.32 * facing, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = C.lens;
    ctx.beginPath();
    ctx.ellipse(0, 0, w * s, h * s, -0.32 * facing, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();
  };

  // Big. In the reference art the lenses dominate the head — they are most of
  // the face — and undersizing them is what makes a masked head read as a
  // plain dark ball. Far eye first, smaller and dimmer, for cheap depth.
  lens(0.4, 0.9, 4.0, 2.9, 0.6);
  lens(4.9, 0.5, 5.6, 3.9, 1);

  // A red brow line across the top of the mask, standing in for the webbing.
  ctx.strokeStyle = C.red;
  ctx.lineWidth = 1.3;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(hx - side.x * 5 + up.x * 6.5, hy - side.y * 5 + up.y * 6.5);
  ctx.quadraticCurveTo(
    hx + up.x * 9.5,
    hy + up.y * 9.5,
    hx + side.x * 6 + up.x * 5.5,
    hy + side.y * 6 + up.y * 5.5
  );
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Fattened foot with a pale sole. */
function drawShoe(ctx, knee, foot, s, C, facing) {
  if (!knee || !foot) return;
  const d = dir(knee, foot);
  // The toe extends past the foot joint, in the facing direction rather than
  // along the shin, so the shoe reads as a shoe and not as a thicker ankle.
  const toe = {
    x: foot.x + (-d.y * facing) * 5.2 * s + d.x * 1.6 * s,
    y: foot.y + (d.x * facing) * 5.2 * s + d.y * 1.6 * s,
  };
  fillCapsule(ctx, foot, toe, 5.2 * s, 4.2 * s, C.red);
  ctx.globalAlpha = 0.9;
  fillCapsule(
    ctx,
    { x: foot.x + d.x * 2.4 * s, y: foot.y + d.y * 2.4 * s },
    { x: toe.x + d.x * 1.6 * s, y: toe.y + d.y * 1.6 * s },
    2.4 * s,
    2.0 * s,
    C.suit
  );
  ctx.globalAlpha = 1;
}
