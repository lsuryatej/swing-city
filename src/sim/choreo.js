/**
 * CHOREO — turns a BeatMap's swingPoints into physically continuous motion.
 *
 * The problem: the beat map says "release at t, re-attach at tNext". Flight is
 * ballistic, so once the character lets go we have no control at all. The only
 * moment we can influence anything is the instant of release, and the only two
 * things we can influence are the launch DIRECTION and the launch SPEED.
 *
 * Direction is not ours to pick — it is the pendulum tangent at whatever angle
 * the swing happens to be at when the beat lands, and forcing it would be a
 * visible pop. So the direction is an input, and we inverse-solve for the one
 * remaining unknown: the speed that makes the parabola pass through the
 * altitude (or forward distance) we want after exactly T = tNext - t seconds.
 * That is a 1-D solve, it is always exactly satisfiable, and the required
 * change in speed is delivered as a "web yank" ramped over ~120 ms before
 * release, so velocity stays continuous.
 *
 * Timing is then exact by construction rather than by control: after release
 * we forward-integrate the true launch state for exactly T seconds, and place
 * the next anchor at the point the character will actually be. The city is
 * procedural, so where the next building is costs us nothing; when we get
 * there is what the audience hears.
 */

import { lengthForPeriod, clamp } from './pendulum.js';

/* ------------------------------------------------------------------ *
 * Ballistics                                                          *
 * ------------------------------------------------------------------ */

/**
 * Position after `t` seconds of free flight. y is down, gravity is +y.
 *   p(t) = p0 + v0 t + 1/2 g t^2
 */
export function predictBallistic(p0, v0, t, gravity, out = { x: 0, y: 0 }) {
  out.x = p0.x + v0.x * t;
  out.y = p0.y + v0.y * t + 0.5 * gravity * t * t;
  return out;
}

/** Velocity after `t` seconds of free flight. */
export function ballisticVelocity(v0, t, gravity, out = { x: 0, y: 0 }) {
  out.x = v0.x;
  out.y = v0.y + gravity * t;
  return out;
}

/**
 * Full 2-D inverse solve: the unique launch velocity that carries `from` to
 * `to` in exactly `t` seconds under constant gravity.
 *
 *   to.x = from.x + vx t                =>  vx = dx / t
 *   to.y = from.y + vy t + 1/2 g t^2    =>  vy = (dy - 1/2 g t^2) / t
 *
 * Both components are closed-form because the flight time is given rather
 * than solved for; that is the whole reason a precomputed beat map makes this
 * easy. Without a known T you get a quartic and a choice of trajectories.
 */
export function solveLaunchVelocity(from, to, t, gravity, out = { x: 0, y: 0 }) {
  if (!(t > 0)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  out.x = (to.x - from.x) / t;
  out.y = (to.y - from.y - 0.5 * gravity * t * t) / t;
  return out;
}

/**
 * Constrained inverse solve: the launch DIRECTION is fixed (it is whatever the
 * pendulum tangent is at the release instant) and we solve for the scalar
 * speed `s` such that the parabola hits a target on one axis after `t`.
 *
 *   x: from.x + s*dir.x*t                 = targetX
 *   y: from.y + s*dir.y*t + 1/2 g t^2     = targetY
 *
 * We solve on whichever axis the direction is better aligned with, because the
 * other one has a near-zero coefficient and would blow the answer up. At the
 * bottom of the arc the tangent is horizontal (dir.y ~ 0) and only the x
 * equation is conditioned; near the top of the arc it is the reverse.
 *
 * @returns {{speed:number, axis:'x'|'y', conditioned:boolean}}
 */
export function solveLaunchSpeed(from, dir, t, gravity, target, opts = {}) {
  const { minSpeed = 0, maxSpeed = Infinity, wellConditioned = 0.3 } = opts;
  if (!(t > 0)) return { speed: minSpeed, axis: 'x', conditioned: false };

  const useY = Math.abs(dir.y) > wellConditioned && Number.isFinite(target.y);
  let s;
  let axis;
  if (useY) {
    axis = 'y';
    s = (target.y - from.y - 0.5 * gravity * t * t) / (dir.y * t);
  } else {
    axis = 'x';
    const denom = dir.x * t;
    if (Math.abs(denom) < 1e-6) {
      return { speed: clamp(minSpeed, minSpeed, maxSpeed), axis, conditioned: false };
    }
    s = (target.x - from.x) / denom;
  }
  const conditioned = Number.isFinite(s) && s > 0;
  // A negative solution means the target is behind the launch direction; there
  // is no forward speed that reaches it. Fall back to the minimum rather than
  // launching backwards.
  if (!conditioned) s = minSpeed;
  return { speed: clamp(s, minSpeed, maxSpeed), axis, conditioned };
}

/* ------------------------------------------------------------------ *
 * Re-attachment                                                       *
 * ------------------------------------------------------------------ */

/**
 * Where to put the next anchor so the catch is perfectly continuous.
 *
 * A rope can only carry tension along its own length, so at the instant of
 * attachment the RADIAL component of the character's velocity is annihilated —
 * that is the "snap" you feel on a real rope, and on screen it is a pop. The
 * fix is free: since we choose where the anchor goes, choose it so there is no
 * radial component to annihilate. Put the anchor perpendicular to the incoming
 * velocity and the entire velocity is already tangential.
 *
 * With n = (hip - anchor)/L, we need n . v = 0 and n pointing downward-ish
 * (the anchor is above the character). Of the two perpendiculars to v, that is
 *   n = (-v.y, v.x) / |v|      when travelling right (v.x > 0)
 * and its negation when travelling left. Then, substituting into
 * v = omega*L*(cos theta, -sin theta), the tangent works out to exactly v-hat,
 * so omega = |v| / L with a positive sign for rightward travel.
 */
/**
 * Maximum catch angle from vertical, radians. cos(60 degrees) = 0.5, so the
 * anchor is guaranteed to sit at least half a rope-length above the character
 * however steep the approach.
 */
export const MAX_CATCH_THETA = Math.PI / 3;

/**
 * Smallest angle the anchor may lead the character by, radians.
 *
 * A pendulum hung from directly overhead is symmetric: it swings out and
 * returns to where it started, forever. Forcing a minimum lead is what turns
 * the swing into travel.
 */
export const MIN_LEAD_THETA = 0.38;

export function anchorForCatch(hip, vel, length, opts = {}) {
  const {
    maxTheta = MAX_CATCH_THETA,
    /** Smallest lead angle. Below this the pendulum is symmetric and the
     *  character swings in place instead of travelling. */
    minLead = MIN_LEAD_THETA,
    /** Altitude the swing should hold. null disables regulation. */
    cruiseY = null,
    /** How hard a height deficit trades reach for lift, 0..1. */
    altitudeGain = 0.75,
  } = opts;

  const speed = Math.hypot(vel.x, vel.y);
  if (speed < 1e-6) {
    // No velocity to be perpendicular to; hang straight down.
    return { anchor: { x: hip.x, y: hip.y - length }, theta: 0, omega: 0 };
  }

  const dir = vel.x >= 0 ? 1 : -1;

  // Ideal, pop-free angle: perpendicular to the incoming velocity.
  let theta = Math.atan2((-vel.y / speed) * dir, (vel.x / speed) * dir);

  // ---- Why that angle cannot be used unmodified -----------------------
  //
  // anchor.y works out to hip.y - (|vx| / |v|) * length. When the character
  // falls steeply |vx|/|v| tends to zero, so the anchor collapses to level
  // with the hip: a rope stretched sideways, carrying no weight. The swing
  // then cannot arrest the fall, the next release starts lower, and the
  // descent runs away. Measured before this clamp, the anchor sat 9 units
  // above the hip on a 243-unit rope, and the character fell 8000 units in a
  // single 2.4s flight while advancing 1100 horizontally.
  //
  // A web attaches to a BUILDING, which is overhead. So force it overhead.
  // ---- And why the anchor must also LEAD ------------------------------
  //
  // Straightening the catch toward vertical maximises lift, but an anchor
  // directly overhead makes a symmetric pendulum: the character swings out,
  // swings back, and ends where he started. Measured with lift-only
  // regulation, x oscillated between 3778 and 4060 forever while the track
  // played — a metronome, not a journey.
  //
  // Forward travel comes from attaching AHEAD and swinging through. So the
  // angle is constrained to a BAND, never shrunk to zero: always leading by at
  // least minLead, never steeper than maxTheta. Altitude regulation then moves
  // within that band rather than collapsing it.
  const lead = -(vel.x >= 0 ? 1 : -1); // anchor ahead in the travel direction
  let mag = Math.min(Math.abs(theta), maxTheta);

  // Altitude regulation: the further below cruise, the more upright the catch
  // and the more of the swing goes into lift instead of reach.
  if (cruiseY !== null && hip.y > cruiseY) {
    const deficit = Math.min(1, (hip.y - cruiseY) / (length * 3));
    mag *= 1 - altitudeGain * deficit;
  }

  theta = lead * Math.max(mag, minLead);

  // n points anchor -> hip; the tangent is 90 degrees from it.
  const nx = Math.sin(theta);
  const ny = Math.cos(theta);

  // Project the incoming velocity onto the tangent and keep only that.
  //
  // Clamping theta reintroduces a radial component, which the perpendicular
  // construction existed to avoid. Discarding it is not a fudge: a rope cannot
  // carry radial motion, and annihilating it is exactly what a real web-line
  // does the instant it goes taut. That loss is the "snap", and it is small
  // whenever the clamp barely binds.
  const omega = (vel.x * ny + vel.y * -nx) / length;

  return {
    anchor: { x: hip.x - nx * length, y: hip.y - ny * length },
    theta,
    omega,
  };
}

/* ------------------------------------------------------------------ *
 * Musical web length                                                  *
 * ------------------------------------------------------------------ */

/**
 * Pick a rope length whose natural period lands on a musical subdivision of
 * the beat interval, so the swing breathes with the track instead of merely
 * happening near it.
 *
 * The visible arc is a HALF period (bottom-to-extreme-to-bottom is a half; a
 * full swing across and back is the full period), so we match the full period
 * against `subdivisions` multiples of the beat interval and keep the candidate
 * that is both in range and nearest a preferred length.
 */
export function chooseWebLength(beatInterval, gravity, opts = {}) {
  const {
    minLength = 180,
    maxLength = 620,
    preferred = 380,
    subdivisions = [1, 1.5, 2, 3, 4],
  } = opts;
  if (!(beatInterval > 0)) return clamp(preferred, minLength, maxLength);

  let best = null;
  for (const sub of subdivisions) {
    const L = lengthForPeriod(beatInterval * sub, gravity);
    if (L < minLength || L > maxLength) continue;
    const cost = Math.abs(L - preferred);
    if (!best || cost < best.cost) best = { L, cost, sub };
  }
  // Nothing in range: clamp the nearest candidate so we still track tempo
  // direction (faster track -> shorter rope) even when we cannot match exactly.
  if (!best) {
    let nearest = null;
    for (const sub of subdivisions) {
      const L = lengthForPeriod(beatInterval * sub, gravity);
      const cost = Math.abs(clamp(L, minLength, maxLength) - L);
      if (!nearest || cost < nearest.cost) nearest = { L, cost, sub };
    }
    return clamp(nearest.L, minLength, maxLength);
  }
  return best.L;
}

/* ------------------------------------------------------------------ *
 * The planner                                                         *
 * ------------------------------------------------------------------ */

export const CHOREO_DEFAULTS = {
  /** Seconds before release over which the web-yank speed correction ramps in.
   *  Long enough that the acceleration is not visible, short enough that the
   *  prediction of the release angle is accurate. */
  yankWindow: 0.3,

  /**
   * Release-angle gate. The beat says WHEN to let go, but letting go while
   * travelling backwards or diving turns a swing into a fall: the character
   * arrives at the next anchor at enormous speed and makes no forward
   * progress. So the beat proposes and the geometry disposes — we hold the
   * release until the tangent is genuinely up-and-forward, up to `grace`
   * seconds late. Crucially this does not desynchronise anything the audience
   * can hear: arrival is still pinned to tNext, because the flight time is
   * recomputed from whenever the release actually happens.
   */
  releaseMinForward: 0.12, // required tangent.x
  releaseMaxRise: -0.04, // required tangent.y (negative is upward)
  releaseGrace: 0.35,
  /**
   * How early the release may fire when the geometry is good.
   *
   * Releasing early is musically free: the flight time is recomputed from the
   * actual release instant, so arrival still lands exactly on tNext. All this
   * buys is a much wider window in which to find a forward-and-rising tangent
   * — without it the search window is only as long as the grace period, and on
   * a short flight that is a few tens of milliseconds against a two-second
   * swing cycle, which the pendulum usually misses.
   */
  releaseEarly: 0.28,
  /** Never plan a flight shorter than this, even if the release ran late. */
  minFlightTime: 0.12,
  /** Fraction of the required speed correction actually applied. Below 1 the
   *  character misses the ideal launch slightly and the anchor placement takes
   *  up the slack; that reads as human rather than robotic. */
  yankAuthority: 0.9,
  /** Bounds on launch speed, world units/s. Deliberately narrow: the yank is
   *  a nudge, not a teleport, and any residual is absorbed for free by where
   *  we choose to put the next anchor. */
  minLaunchSpeed: 300,
  maxLaunchSpeed: 1400,
  /** The yank may not scale the swing speed outside this band. */
  yankSpeedBand: [0.5, 2.2],
  /** Absolute ceiling on the angular acceleration the yank may apply, rad/s^2.
   *  This is the hard guarantee that no release can ever produce a visible
   *  pop, regardless of what the solver asks for. */
  maxYankAccel: 16,
  /** Desired hip altitude at the moment of the next catch, world units. */
  cruiseY: 620,
  /** Most altitude a single flight will try to regain, world units. Small
   *  enough to stay inside maxLaunchSpeed, large enough to recover from a bad
   *  swing within a few cycles. */
  maxClimbPerFlight: 260,
  /** Heroic altitude assist: fraction of the remaining sag corrected per
   *  second. See heroicAssist() in sim/index.js — this is not physics, it is
   *  the guarantee that the character stays above the skyline. */
  altitudeAssist: 2.6,
  /** Hard floor: never more than this far below cruise, in world units. The
   *  spring above can be outrun by a long fall; this cannot. */
  maxSag: 240,
  /** How much of the assist is also taken out of downward velocity, 0..1, so
   *  the character does not accelerate down while being pushed up. */
  liftDrag: 0.55,
  /** Ceiling on the assist, world units per second, so a large correction
   *  still reads as flight rather than as being winched upward. */
  maxLiftRate: 900,
  /** Desired forward travel per second, used when the y-axis solve is
   *  ill-conditioned (release near the bottom of the arc). */
  cruiseSpeedX: 620,
  /** Duration of the 'anchor' phase — the web visually shooting out. Physics
   *  is already swinging during it, so this is purely presentational. */
  anchorTime: 0.12,
  /** Reactive mode: seconds of swing before an automatic release. */
  reactiveSwingTime: 1.6,
  /** How fast the rope length is allowed to change, world units/s. Length
   *  changes are velocity changes (v = L*omega), so they must be rate-limited
   *  or they pop. */
  lengthRate: 900,
};

/**
 * Predict the pendulum's angle a short time ahead, cheaply.
 * Used inside the yank window to guess the release tangent before we get
 * there. A second-order expansion is plenty over 140 ms and avoids running a
 * whole shadow integration every frame.
 */
export function predictTheta(theta, omega, dt, length, gravity) {
  const a = -(gravity / length) * Math.sin(theta);
  return theta + omega * dt + 0.5 * a * dt * dt;
}

/** Unit tangent of the swing at (theta, omega). */
export function tangentAt(theta, omega, out = { x: 0, y: 0 }) {
  const s = omega >= 0 ? 1 : -1;
  out.x = Math.cos(theta) * s;
  out.y = -Math.sin(theta) * s;
  return out;
}

/**
 * Compute the launch speed the character should have at release, given the
 * predicted release state. Pure — the caller decides what to do with it.
 */
export function planLaunch(releaseHip, releaseDir, flightTime, gravity, cfg) {
  // Aim at a BOUNDED step toward cruise altitude, not at cruise altitude
  // itself.
  //
  // Targeting the absolute height is what let the descent run away: once the
  // character had fallen well below it, the launch speed needed to climb all
  // the way back in one flight exceeded maxLaunchSpeed, the solve clamped, he
  // fell short, and the next flight started lower still. Climbing at most
  // maxClimbPerFlight keeps every target reachable, so altitude converges on
  // cruise over a few swings instead of diverging.
  const error = releaseHip.y - cfg.cruiseY; // positive when too low
  const step = Math.max(-cfg.maxClimbPerFlight, Math.min(cfg.maxClimbPerFlight, error));

  const target = {
    x: releaseHip.x + cfg.cruiseSpeedX * flightTime,
    y: releaseHip.y - step,
  };
  return solveLaunchSpeed(releaseHip, releaseDir, flightTime, gravity, target, {
    minSpeed: cfg.minLaunchSpeed,
    maxSpeed: cfg.maxLaunchSpeed,
  });
}
