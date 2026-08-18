/**
 * SKELETON — 13 named joints, solved from the pendulum state each frame.
 *
 * Two ideas do all the work here:
 *
 * 1. The web-holding arm is not simulated. By definition it points along the
 *    web line, because that is what holding a rope means. Everything reads as
 *    correct if that one constraint is exact.
 *
 * 2. Every other bone LAGS its parent through a critically-damped spring.
 *    This is "overlap and follow-through", and it is the single animation
 *    principle that separates motion that looks alive from motion that looks
 *    like a rigid body with limbs welded on. Critically damped specifically:
 *    underdamped adds a wobble that reads as rubber, overdamped reads as
 *    treacle. Critical is the fastest approach with no overshoot.
 *
 * All joint objects are allocated once at construction and mutated in place.
 * Nothing in this file allocates per frame.
 */

const TAU = Math.PI * 2;

/** Wrap an angle to (-pi, pi]. */
export function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/**
 * Exact critically-damped spring step.
 *
 * For the critically damped case the ODE x'' = -y^2 (x - target) - 2y x' has
 * the closed-form solution x(t) = target + (j0 + j1 t) e^(-y t), so we can
 * step it exactly at any dt instead of numerically. That matters because it is
 * unconditionally stable — a big frame delta settles the spring, it never
 * explodes it.
 *
 * `halfLife` is the time for the remaining error to halve; y = 2.4/halfLife is
 * the standard approximation of that relation for the critical case.
 */
export function criticalStep(s, target, halfLife, dt) {
  const y = 2.4 / Math.max(halfLife, 1e-4);
  const j0 = s.x - target;
  const j1 = s.v + j0 * y;
  const e = Math.exp(-y * dt);
  s.x = target + (j0 + j1 * dt) * e;
  s.v = (s.v - j1 * y * dt) * e;
  return s.x;
}

/** Critically-damped spring on an ANGLE, taking the shortest arc to target. */
export function criticalAngleStep(s, target, halfLife, dt) {
  // Re-express the target adjacent to the current value so the spring never
  // takes the long way round when the angle crosses +/-pi.
  const unwrapped = s.x + wrapPi(target - s.x);
  return criticalStep(s, unwrapped, halfLife, dt);
}

/**
 * Two-bone IK. Places `mid` so that |root-mid| = l1 and |mid-target| = l2,
 * choosing the elbow/knee side with `bendSign`.
 */
export function solveTwoBone(rootX, rootY, tx, ty, l1, l2, bendSign, mid) {
  let dx = tx - rootX;
  let dy = ty - rootY;
  let d = Math.hypot(dx, dy);

  const dMax = l1 + l2 - 1e-4;
  const dMin = Math.abs(l1 - l2) + 1e-4;
  if (d < 1e-6) {
    dx = 0;
    dy = 1;
    d = 1;
  } else {
    dx /= d;
    dy /= d;
  }
  d = d < dMin ? dMin : d > dMax ? dMax : d;

  // Distance from root to the projection of the mid joint onto the root-target
  // line, from the intersection of two circles.
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const hSq = l1 * l1 - a * a;
  const h = hSq > 0 ? Math.sqrt(hSq) : 0;

  mid.x = rootX + dx * a + -dy * h * bendSign;
  mid.y = rootY + dy * a + dx * h * bendSign;
  return mid;
}

/** Default proportions. World units; total standing height ~156. */
export const RIG = {
  torso: 56, // hipC -> neck
  neck: 22, // neck -> head
  shoulderHalf: 21,
  upperArm: 34,
  foreArm: 32,
  hipHalf: 13,
  thigh: 40,
  shin: 38,
};

/**
 * Tunable secondary-motion parameters. All half-lives in seconds: bigger =
 * more lag = floppier. The ordering torso < head < arm < leg is deliberate —
 * mass closest to the root leads, extremities follow.
 */
export const LAG_DEFAULTS = {
  torso: 0.055,
  head: 0.085,
  freeArmUpper: 0.11,
  freeArmFore: 0.15,
  legThigh: 0.13,
  legShin: 0.19,
  /**
   * Limb drag. The deflection saturates as tanh(sweep / refSpeed) * maxDrag
   * rather than scaling linearly with a hard clamp.
   *
   * A linear coefficient has to be tuned against an assumed speed, and this
   * character's speed varies by 4x across a single arc — tune it for the
   * bottom of the swing and the limbs windmill past vertical at the top, tune
   * it for the top and they barely move at the bottom. tanh gives a near-linear
   * response where the motion is gentle and a smooth ceiling where it is not,
   * so one setting covers the whole range and the limbs can never invert.
   */
  refSpeed: 900,
  legDrag: 0.62,
  armDrag: 0.5,
  headDrag: 0.24,
  /** Shin deflection relative to thigh. Above 1 the lower leg whips past the
   *  upper one, which is where most of the sense of weight comes from. */
  shinFollow: 1.15,
  /** Left/right limb desynchronisation, 0..1. Perfectly symmetric limbs read
   *  as a mannequin; a small offset reads as a person. */
  asymmetry: 0.22,
};

const J = [
  'head',
  'neck',
  'hipC',
  'shoulderL',
  'shoulderR',
  'elbowL',
  'elbowR',
  'handL',
  'handR',
  'kneeL',
  'kneeR',
  'footL',
  'footR',
];

export function createSkeleton(opts = {}) {
  const rig = { ...RIG, ...(opts.rig || {}) };
  const lag = { ...LAG_DEFAULTS, ...(opts.lag || {}) };

  /** @type {Record<string,{x:number,y:number}>} */
  const joints = {};
  for (const name of J) joints[name] = { x: 0, y: 0 };

  // Spring state, in world angles (radians, atan2(dy,dx) with +y down).
  const springs = {
    torso: { x: -Math.PI / 2, v: 0 },
    head: { x: -Math.PI / 2, v: 0 },
    armUpperL: { x: Math.PI / 2, v: 0 },
    armForeL: { x: Math.PI / 2, v: 0 },
    thighL: { x: Math.PI / 2, v: 0 },
    thighR: { x: Math.PI / 2, v: 0 },
    shinL: { x: Math.PI / 2, v: 0 },
    shinR: { x: Math.PI / 2, v: 0 },
  };

  let initialised = false;

  /**
   * @param {object} s
   * @param {{x:number,y:number}} s.hip      Root position, world.
   * @param {{x:number,y:number}} s.anchor   Web anchor, world.
   * @param {{x:number,y:number}} s.vel      Hip velocity, world units/s.
   * @param {{x:number,y:number}} s.up       Unit body up-axis.
   * @param {boolean} s.attached             Is the web currently held?
   * @param {number} dt
   */
  function solve(s, dt) {
    const { hip, anchor, vel, up, attached } = s;

    // --- Root -------------------------------------------------------------
    joints.hipC.x = hip.x;
    joints.hipC.y = hip.y;

    // The torso wants to lie along the body up-axis. On the rope that is the
    // line to the anchor (you hang off your arm); in flight it is a blend of
    // "up" and the direction of travel, which is what makes a dive read as a
    // dive rather than a person falling upright.
    // hip -> neck points ALONG the body up-axis: on the rope you hang below
    // your own arm, so the chest is between the hips and the anchor.
    const torsoTarget = Math.atan2(up.y, up.x);

    if (!initialised) {
      springs.torso.x = torsoTarget;
      springs.head.x = torsoTarget;
      initialised = true;
    }

    const torsoA = criticalAngleStep(springs.torso, torsoTarget, lag.torso, dt);
    const tcx = Math.cos(torsoA);
    const tcy = Math.sin(torsoA);

    joints.neck.x = hip.x + tcx * rig.torso;
    joints.neck.y = hip.y + tcy * rig.torso;

    // --- Head -------------------------------------------------------------
    // The head lags the torso and leans into the sweep: people look where they
    // are going, and the neck is the last thing to get there.
    const sweep = signedAlong(vel, tcx, tcy);
    const headTarget = torsoA + saturate(sweep, lag.refSpeed, lag.headDrag);
    const headA = criticalAngleStep(springs.head, headTarget, lag.head, dt);
    joints.head.x = joints.neck.x + Math.cos(headA) * rig.neck;
    joints.head.y = joints.neck.y + Math.sin(headA) * rig.neck;

    // --- Shoulders --------------------------------------------------------
    // Perpendicular to the torso. Facing is inferred from travel direction so
    // the character never appears to swing backwards.
    const facing = vel.x >= 0 ? 1 : -1;
    const px = -tcy * facing;
    const py = tcx * facing;
    joints.shoulderR.x = joints.neck.x + px * rig.shoulderHalf;
    joints.shoulderR.y = joints.neck.y + py * rig.shoulderHalf;
    joints.shoulderL.x = joints.neck.x - px * rig.shoulderHalf;
    joints.shoulderL.y = joints.neck.y - py * rig.shoulderHalf;

    // --- Web arm (right) --------------------------------------------------
    // Not simulated: it points along the web line, by definition. If the
    // anchor is closer than full reach the arm bends to meet it.
    let wx = anchor.x - joints.shoulderR.x;
    let wy = anchor.y - joints.shoulderR.y;
    const wd = Math.hypot(wx, wy) || 1;
    wx /= wd;
    wy /= wd;
    const reach = rig.upperArm + rig.foreArm;
    const handDist = attached ? Math.min(reach * 0.99, wd) : reach * 0.72;
    joints.handR.x = joints.shoulderR.x + wx * handDist;
    joints.handR.y = joints.shoulderR.y + wy * handDist;
    solveTwoBone(
      joints.shoulderR.x,
      joints.shoulderR.y,
      joints.handR.x,
      joints.handR.y,
      rig.upperArm,
      rig.foreArm,
      -facing,
      joints.elbowR
    );

    // --- Free arm (left) --------------------------------------------------
    // Hangs from the shoulder and is dragged backwards by travel. Signed
    // tangential speed, so it trails on the way out and swings through and
    // leads as the character comes back the other way.
    const drag = -saturate(sweep, lag.refSpeed, lag.armDrag);
    const downA = torsoA + Math.PI; // neck -> hip direction: "down" the body
    const armUpperTarget = downA + drag;
    const aU = criticalAngleStep(springs.armUpperL, armUpperTarget, lag.freeArmUpper, dt);
    joints.elbowL.x = joints.shoulderL.x + Math.cos(aU) * rig.upperArm;
    joints.elbowL.y = joints.shoulderL.y + Math.sin(aU) * rig.upperArm;

    const armForeTarget = aU + drag * (1 + lag.asymmetry);
    const aF = criticalAngleStep(springs.armForeL, armForeTarget, lag.freeArmFore, dt);
    joints.handL.x = joints.elbowL.x + Math.cos(aF) * rig.foreArm;
    joints.handL.y = joints.elbowL.y + Math.sin(aF) * rig.foreArm;

    // --- Legs -------------------------------------------------------------
    // Hips are perpendicular offsets from the root, then each leg is a
    // two-segment chain with its own lag. The left leg carries a slightly
    // different drag coefficient and half-life so the pair never moves as one
    // welded unit.
    const hipOffX = px * rig.hipHalf;
    const hipOffY = py * rig.hipHalf;

    const legDrag = -saturate(sweep, lag.refSpeed, lag.legDrag);

    solveLeg(
      'R',
      joints.kneeR,
      joints.footR,
      hip.x + hipOffX,
      hip.y + hipOffY,
      downA,
      legDrag,
      springs.thighR,
      springs.shinR,
      1
    );
    solveLeg(
      'L',
      joints.kneeL,
      joints.footL,
      hip.x - hipOffX,
      hip.y - hipOffY,
      downA,
      legDrag * (1 - lag.asymmetry),
      springs.thighL,
      springs.shinL,
      1 + lag.asymmetry
    );

    function solveLeg(_side, knee, foot, hx, hy, down, dragAmt, thighS, shinS, lagScale) {
      const thighTarget = down + dragAmt;
      const a1 = criticalAngleStep(thighS, thighTarget, lag.legThigh * lagScale, dt);
      knee.x = hx + Math.cos(a1) * rig.thigh;
      knee.y = hy + Math.sin(a1) * rig.thigh;
      // The shin overshoots the thigh's drag: the lower leg is lighter and
      // whips. That whip is most of what sells the arc.
      const shinTarget = a1 + dragAmt * lag.shinFollow;
      const a2 = criticalAngleStep(shinS, shinTarget, lag.legShin * lagScale, dt);
      foot.x = knee.x + Math.cos(a2) * rig.shin;
      foot.y = knee.y + Math.sin(a2) * rig.shin;
    }

    return joints;
  }

  /** Snap all springs to their targets — used after a teleport/reset so the
   *  limbs do not visibly catch up from the old pose. */
  function reset() {
    initialised = false;
    for (const k in springs) springs[k].v = 0;
  }

  return { joints, solve, reset, rig, lag, springs };
}

/** Component of `v` along the torso axis (cx, cy). */
function signedAlong(v, cx, cy) {
  // Perpendicular to the torso is the direction the body sweeps through the
  // arc, which is what the limbs actually drag against.
  return v.x * -cy + v.y * cx;
}

/**
 * Saturating drag response: near-linear for |v| << ref, asymptotic to +/-max.
 * See LAG_DEFAULTS.refSpeed for why this is not a clamp.
 */
function saturate(v, ref, max) {
  return Math.tanh(v / ref) * max;
}

export const JOINT_NAMES = J;

/** Bone connectivity, for the renderer and the debug overlay. */
export const BONES = [
  ['hipC', 'neck'],
  ['neck', 'head'],
  ['neck', 'shoulderL'],
  ['neck', 'shoulderR'],
  ['shoulderL', 'elbowL'],
  ['elbowL', 'handL'],
  ['shoulderR', 'elbowR'],
  ['elbowR', 'handR'],
  ['hipC', 'kneeL'],
  ['kneeL', 'footL'],
  ['hipC', 'kneeR'],
  ['kneeR', 'footR'],
];
