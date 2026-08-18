/**
 * Sprite figure — hand-drawn limb assets pinned to the solved skeleton.
 *
 * The third renderer, alongside drawSilhouette and drawDetailedFigure. All
 * three consume only `pose.joints`, so this is a swap: nothing in the physics,
 * the skeleton solve or the comic pass changes.
 *
 * WHY SPRITES AT ALL
 * ------------------
 * The procedural figure draws each limb as a tapered capsule, which describes
 * a SKELETON rather than a body: the outline breaks at every joint, and limbs
 * are uniform tubes with no deltoid swell, no calf mass, no thigh taper. That
 * construction is visible in the silhouette and no amount of added detail
 * hides it. Hand-drawn assets carry the anatomy that code cannot generate.
 *
 * THE PIVOT MODEL
 * ---------------
 * Each asset declares where its bone STARTS and ENDS inside the image, as
 * fractions of image size. The renderer then computes one affine transform
 * that lands the asset's start pivot on the parent joint and its end pivot on
 * the child joint, scaling and rotating to fit.
 *
 * Crucially the bone end is NOT the edge of the image. On `forearm` the bone
 * ends at the WRIST and the hand extends past it; on `shin` it ends at the
 * ANKLE and the foot extends past. That overhang is the whole point — it is
 * what gives hands and feet that the capsule rig never had.
 *
 * ROUNDED CAPS
 * ------------
 * The assets have semicircular ends at the pivots. A circle rotated about its
 * own centre is invariant, so overlapping limbs stay seamless at any joint
 * angle. Non-circular ends visibly shear apart as the limb rotates.
 */

const ASSET_DIR = '/figure/';

/**
 * Bone pivots as fractions of image width/height.
 *
 * These are starting estimates measured by eye against the supplied art and
 * are expected to need tuning — nudge them while watching the live figure
 * rather than trying to derive them. `s` is the start (parent) joint, `e` the
 * end (child) joint. `w` is limb width as a fraction of image height, used to
 * keep thickness sensible when the bone is scaled.
 */
export const SPRITE_PIVOTS = {
  // MEASURED from each asset's alpha channel, not estimated. The first pass
  // used eyeballed fractions and the figure visibly came apart — the upper
  // arm's elbow sits at y 0.318, not the 0.5 a symmetric limb would suggest,
  // and torso/thigh run the full image width where they were guessed at 0.86
  // and 0.93. Re-measure with the alpha-scan snippet if the art is redrawn.
  torso: { file: 'torso.png', s: [0.01, 0.498], e: [0.99, 0.489] },
  // End pivot is the head CENTRE, not the crown. The `head` joint from the
  // skeleton is the centre of the skull, so mapping the bone onto neck->crown
  // stretched the sprite well past the joint and left the head visibly
  // detached and oversized.
  head: { file: 'head.png', s: [0.211, 0.536], e: [0.50, 0.51] },
  upperArm: { file: 'upper-arm.png', s: [0.01, 0.523], e: [0.99, 0.318] },
  // End pivot is the WRIST, not the image edge — the hand overhangs to the
  // right. Measured thickness at the far edge is 0.05, i.e. fingertips.
  forearm: { file: 'forearm.png', s: [0.01, 0.482], e: [0.62, 0.50] },
  thigh: { file: 'thigh.png', s: [0.01, 0.474], e: [0.99, 0.563] },
  // End pivot is the ANKLE; the foot overhangs.
  shin: { file: 'shin.png', s: [0.01, 0.303], e: [0.76, 0.52] },
};

/**
 * Which asset each bone uses, and whether it draws before or after the torso.
 * Far-side limbs are drawn first and dimmed, so the figure reads with depth
 * instead of collapsing into one flat mass — the thing the capsule version
 * could never do because every limb was the same solid black.
 */
const RIG = [
  // Far side, behind the torso.
  { a: 'shoulderR', b: 'elbowR', asset: 'upperArm', depth: 0 },
  { a: 'elbowR', b: 'handR', asset: 'forearm', depth: 0 },
  { a: 'hipC', b: 'kneeR', asset: 'thigh', depth: 0 },
  { a: 'kneeR', b: 'footR', asset: 'shin', depth: 0 },
  // Body.
  { a: 'hipC', b: 'neck', asset: 'torso', depth: 1 },
  { a: 'neck', b: 'head', asset: 'head', depth: 1 },
  // Near side, in front.
  { a: 'hipC', b: 'kneeL', asset: 'thigh', depth: 2 },
  { a: 'kneeL', b: 'footL', asset: 'shin', depth: 2 },
  { a: 'shoulderL', b: 'elbowL', asset: 'upperArm', depth: 2 },
  { a: 'elbowL', b: 'handL', asset: 'forearm', depth: 2 },
];

/** How much the far-side limbs are darkened. */
const FAR_DIM = 0.62;

let images = null;
let ready = false;

/**
 * Kick off loading. Safe to call repeatedly; resolves once.
 * @returns {Promise<boolean>} whether every asset loaded
 */
export function loadSpriteAssets(base = ASSET_DIR) {
  if (images) return images;
  const entries = Object.entries(SPRITE_PIVOTS);
  images = Promise.all(
    entries.map(
      ([key, cfg]) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve([key, img]);
          // A missing asset must not break the site — it falls back to the
          // procedural figure rather than rendering nothing.
          img.onerror = () => resolve([key, null]);
          img.src = base + cfg.file;
        })
    )
  ).then((pairs) => {
    const map = {};
    for (const [k, img] of pairs) map[k] = img;
    ready = pairs.every(([, img]) => img);
    return map;
  });
  return images;
}

let loaded = null;
loadSpriteAssets().then((m) => {
  loaded = m;
});

export function spritesReady() {
  return ready && loaded !== null;
}

/**
 * Pin one asset between two joints.
 *
 * Builds the transform from the asset's own pivot pair to the joint pair:
 * translate the start pivot onto joint A, rotate so the pivot axis points at
 * joint B, and scale uniformly so the pivot distance equals the bone length.
 * Uniform scale matters — scaling x and y independently to "fit" the bone is
 * what makes sprite rigs look like melting rubber.
 */
function drawBone(ctx, img, cfg, ja, jb, scaleBias) {
  if (!img || !ja || !jb) return;

  const iw = img.width;
  const ih = img.height;
  const sx = cfg.s[0] * iw;
  const sy = cfg.s[1] * ih;
  const ex = cfg.e[0] * iw;
  const ey = cfg.e[1] * ih;

  const pivotDx = ex - sx;
  const pivotDy = ey - sy;
  const pivotLen = Math.hypot(pivotDx, pivotDy) || 1;
  const pivotAng = Math.atan2(pivotDy, pivotDx);

  const boneDx = jb.x - ja.x;
  const boneDy = jb.y - ja.y;
  const boneLen = Math.hypot(boneDx, boneDy);
  const boneAng = Math.atan2(boneDy, boneDx);

  const k = (boneLen / pivotLen) * scaleBias;

  ctx.save();
  ctx.translate(ja.x, ja.y);
  ctx.rotate(boneAng - pivotAng);
  ctx.scale(k, k);
  ctx.drawImage(img, -sx, -sy);
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{joints:Object, velocity?:{x:number,y:number}}} pose
 * @param {object} opts
 */
export function drawSpriteFigure(ctx, pose, opts = {}) {
  if (!loaded) return false;
  const j = pose.joints;
  // Slight oversize so pieces OVERLAP at the joints instead of butting.
  //
  // A cutout rig with pieces meeting exactly edge-to-edge shows a seam at
  // every joint the moment it rotates, which is most of why the figure reads
  // as loose parts rather than a body. Overlapping the rounded caps hides the
  // seam: a circle rotated about its own centre is invariant, so the overlap
  // region stays constant at any angle.
  const bias = opts.spriteScale ?? 1.12;

  // Mirror the whole figure when travelling left, so the drawn art always
  // faces the direction of travel. Assets are drawn facing right.
  const vx = pose.velocity?.x ?? 1;
  const facing = Math.abs(vx) < 20 ? (opts._lastFacing ?? 1) : Math.sign(vx);
  opts._lastFacing = facing;

  ctx.save();
  if (facing < 0) {
    // Mirror about the hip so the figure does not jump sideways when it flips.
    ctx.translate(j.hipC.x, 0);
    ctx.scale(-1, 1);
    ctx.translate(-j.hipC.x, 0);
  }

  for (const bone of RIG) {
    const cfg = SPRITE_PIVOTS[bone.asset];
    const img = loaded[bone.asset];
    ctx.globalAlpha = bone.depth === 0 ? FAR_DIM : 1;
    drawBone(ctx, img, cfg, j[bone.a], j[bone.b], bias);
  }

  ctx.globalAlpha = 1;
  ctx.restore();

  // The mask goes on AFTER the sprites and OUTSIDE the mirror transform, so
  // the lenses are never drawn back-to-front. The art deliberately has a blank
  // head — keeping the face procedural means it stays tunable without
  // regenerating any assets.
  drawFace(ctx, j, facing, opts);
  return true;
}

const FACE = {
  lens: '#f4f7ff',
  edge: '#04050b',
  red: '#ff1e35',
};

/**
 * Eye lenses and brow, positioned from the neck->head axis.
 *
 * These are the highest-contrast marks on the whole figure by design: at this
 * render size they are what turns a dark head into a recognisable character.
 * Everything else on the costume is supporting detail.
 */
function drawFace(ctx, j, facing, opts) {
  const head = j.head;
  const neck = j.neck;
  if (!head || !neck) return;

  const dx = head.x - neck.x;
  const dy = head.y - neck.y;
  const len = Math.hypot(dx, dy) || 1;
  const up = { x: dx / len, y: dy / len };          // neck -> head, the skull axis
  const side = { x: -up.y * facing, y: up.x * facing }; // toward the face
  const S = (opts.faceScale ?? 1) * (len / 26);      // scale with the head bone

  // Two lenses SIDE BY SIDE across the face, each taller than wide.
  //
  // The first version offset them along the FACING axis, which put one behind
  // the other so they merged into a single horizontal blob. They separate
  // across the face — perpendicular to the neck->head axis — and each ellipse
  // is elongated along that same perpendicular, giving the upright teardrop
  // shape the mask actually has.
  const across = { x: -up.y, y: up.x };

  const lens = (offset, w, h, alpha) => {
    const cx = head.x + side.x * 3.4 * S + across.x * offset * S;
    const cy = head.y + side.y * 3.4 * S + across.y * offset * S;
    ctx.save();
    ctx.translate(cx, cy);
    // Align the ellipse to the head, then tilt outward from the centre line.
    ctx.rotate(Math.atan2(across.y, across.x) + 0.34 * Math.sign(offset || 1));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = FACE.edge;
    ctx.beginPath();
    ctx.ellipse(0, 0, (w + 1.3) * S, (h + 1.3) * S, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = FACE.lens;
    ctx.beginPath();
    ctx.ellipse(0, 0, w * S, h * S, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  // w < h: taller than wide. Far lens slightly smaller and dimmer.
  lens(-3.6, 2.4, 4.4, 0.72);
  lens(3.6, 2.7, 5.0, 1);
}
