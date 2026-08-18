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

  /* ---- 3. Red panels -------------------------------------------------- *
   * Miles' suit is predominantly black with red at the chest, shoulders and
   * mask. Keeping red OFF the limbs is deliberate: at this size, colour on a
   * fast-moving arm turns into a smear, while colour on the torso reads as a
   * stable emblem.                                                          */
  const torsoDir = dir(j.hipC, j.neck);
  const chestX = j.hipC.x + torsoDir.x * torsoDir.len * 0.62;
  const chestY = j.hipC.y + torsoDir.y * torsoDir.len * 0.62;

  // Upper-chest wedge, tapering down from the neck.
  fillCapsule(ctx, { x: chestX, y: chestY }, j.neck, r('torso', 1) * 1.02, r('torso', 1) * 0.94, C.red);

  // Shoulder caps.
  fillCapsule(ctx, j.neck, j.shoulderL, r('clav', 0) * 0.95, r('clav', 1) * 1.05, C.red);
  fillCapsule(ctx, j.neck, j.shoulderR, r('clav', 0) * 0.95, r('clav', 1) * 1.05, C.red);

  // Interior ink: a hairline between the red chest and the black abdomen.
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1.4 * s;
  ctx.beginPath();
  const perp = { x: -torsoDir.y, y: torsoDir.x };
  const w = r('torso', 0) * 0.96;
  ctx.moveTo(chestX - perp.x * w, chestY - perp.y * w);
  ctx.lineTo(chestX + perp.x * w, chestY + perp.y * w);
  ctx.stroke();

  /* ---- 4. Spider emblem ----------------------------------------------- *
   * An elongated diamond, not an anatomically correct spider. At 150px tall
   * the legs of a real emblem collapse into mush; the silhouette of the body
   * is what actually reads.                                                */
  const emX = j.hipC.x + torsoDir.x * torsoDir.len * 0.78;
  const emY = j.hipC.y + torsoDir.y * torsoDir.len * 0.78;
  const eh = 7 * s;
  const ew = 3.6 * s;
  ctx.fillStyle = C.ink;
  ctx.beginPath();
  ctx.moveTo(emX + torsoDir.x * eh, emY + torsoDir.y * eh);
  ctx.lineTo(emX + perp.x * ew, emY + perp.y * ew);
  ctx.lineTo(emX - torsoDir.x * eh, emY - torsoDir.y * eh);
  ctx.lineTo(emX - perp.x * ew, emY - perp.y * ew);
  ctx.closePath();
  ctx.fill();

  /* ---- 5. Shoes -------------------------------------------------------- *
   * Untied high-tops. Miles' most recognisable non-suit element, and cheap:
   * a fattened foot with a pale sole is enough at this scale.               */
  drawShoe(ctx, j.kneeL, j.footL, s, C, facing);
  drawShoe(ctx, j.kneeR, j.footR, s, C, facing);

  /* ---- 6. Mask --------------------------------------------------------- */
  drawMask(ctx, j, s, C, facing);
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

  ctx.beginPath();
  ctx.arc(j.head.x, j.head.y, r('head', 0) + g, 0, Math.PI * 2);
  ctx.fill();
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

  // Far eye first, smaller and dimmer — cheap depth without any real 3D.
  lens(1.2, 0.4, 3.0, 2.1, 0.55);
  lens(4.6, 0.2, 4.3, 2.9, 1);
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
  fillCapsule(ctx, foot, toe, 5.2 * s, 4.2 * s, C.suit);
  ctx.globalAlpha = 0.9;
  fillCapsule(
    ctx,
    { x: foot.x + d.x * 2.4 * s, y: foot.y + d.y * 2.4 * s },
    { x: toe.x + d.x * 1.6 * s, y: toe.y + d.y * 1.6 * s },
    2.6 * s,
    2.2 * s,
    C.sole
  );
  ctx.globalAlpha = 1;
}
