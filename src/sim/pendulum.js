/**
 * PENDULUM — the core integrator.
 *
 * Coordinate convention (matches canvas / the contract's "world units are
 * pixels at a nominal 1080p"):
 *   +x is right, +y is DOWN, gravity is +y.
 *
 * theta is measured from the downward vertical, positive toward +x:
 *   hip = anchor + L * (sin theta,  cos theta)
 *   d(hip)/d(theta) = L * (cos theta, -sin theta)
 *   velocity = omega * L * (cos theta, -sin theta)
 *
 * Sanity check on the sign of the restoring term: at theta > 0 the bob is to
 * the right of the anchor, so gravity must pull theta back toward 0, hence the
 * acceleration is negative. That is exactly -(g/L) * sin(theta).
 */

/**
 * Fixed simulation timestep. 1/240 s.
 *
 * We never integrate with a raw rAF delta. A variable dt in a stiff-ish ODE
 * changes the effective damping and, on a frame hitch, can hand the integrator
 * a 500 ms step that throws the bob over the bar and never recovers. A fixed
 * step plus an accumulator makes the trajectory a pure function of total
 * elapsed time, which also makes it testable and reproducible.
 */
export const FIXED_DT = 1 / 240;

/**
 * Longest wall-clock delta we will honour in one call. Anything above this is
 * discarded rather than simulated: a tab that was backgrounded for 30 s should
 * resume, not fast-forward. 0.25 s is ~15 dropped frames at 60 Hz.
 */
export const MAX_FRAME_DT = 0.25;

/** Ceiling on steps per call. MAX_FRAME_DT / FIXED_DT = 60, so this can never
 *  be hit by a clamped delta; it is a spiral-of-death backstop only. */
export const MAX_STEPS_PER_CALL = 64;

/** Limit on |theta|. Beyond this the bob is heading over the bar, which reads
 *  as broken rather than energetic. 1.45 rad is ~83 degrees, already a very
 *  dramatic arc. */
export const MAX_THETA = 1.45;

/** Width of the soft barrier in front of MAX_THETA, radians.
 *
 *  The obvious implementation of an amplitude limit — clamp theta, set omega to
 *  zero — is a velocity discontinuity, i.e. exactly the pop this project is
 *  built to avoid, and it fires precisely at the dramatic peak of the arc where
 *  it is most visible. Instead the wall is a quadratic spring plus a one-way
 *  damper that only resists OUTWARD motion, so the bob decelerates into the
 *  limit and accelerates back out of it cleanly. The hard clamp below it
 *  survives only as a NaN-safety net and is not reached in practice. */
export const WALL_MARGIN = 0.45;
/** Peak wall stiffness is WALL_K * WALL_MARGIN^2 ~ 44 rad/s^2, roughly 4x the
 *  gravitational restoring term at a typical rope length. Strong enough to
 *  hold the limit, weak enough that it reads as the rope going taut rather
 *  than as a wall being hit. A wide margin matters more than a stiff spring:
 *  the same total impulse spread over a longer approach is invisible. */
export const WALL_K = 220;
export const WALL_C = 14;

/** How far past maxTheta the hard safety clamp sits.
 *
 *  The soft wall needs room to work, and the catch can legitimately hand the
 *  pendulum an angle slightly beyond the soft limit (a steeply falling catch
 *  is perpendicular to a near-vertical velocity, i.e. theta near +/-pi/2).
 *  Clamping at exactly maxTheta in that moment would break the perpendicular
 *  construction and reintroduce the velocity pop the whole catch design exists
 *  to avoid. So the hard clamp sits clear of the working range and really is
 *  only a numerical backstop. */
export const HARD_LIMIT_SLACK = 0.4;

const EPS = 1e-9;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * theta'' = -(g / L) * sin(theta) - damping * theta' - quadDrag * theta' * |theta'|
 *
 * The optional quadratic term is a governor, not physics-for-its-own-sake.
 * Linear damping alone scales with omega, so it loses the arms race against a
 * steady stream of sign-locked impulses: each beat adds a fixed amount and
 * every catch hands back the full flight speed, so amplitude creeps up cycle
 * over cycle until the character is whipping round the anchor. A term that
 * grows with omega^2 is negligible at a lazy swing and dominant at a violent
 * one, which pins the top end without flattening the dynamics that make the
 * amplitude track the music. Defaults to 0 so the pure pendulum stays pure.
 */
export function pendulumAccel(theta, omega, length, gravity, damping, quadDrag = 0) {
  return (
    -(gravity / length) * Math.sin(theta) -
    damping * omega -
    quadDrag * omega * Math.abs(omega)
  );
}

/**
 * One semi-implicit (symplectic) Euler step.
 *
 * Velocity is updated first, then position uses the NEW velocity. That
 * ordering is what makes the scheme symplectic: energy oscillates within a
 * bounded band forever instead of drifting monotonically the way explicit
 * Euler does. For an undamped pendulum at 1/240 s the band is well under 1%.
 *
 * Mutates and returns `state` ({theta, omega}) to keep the hot path
 * allocation-free.
 */
export function stepSemiImplicit(
  state,
  dt,
  length,
  gravity,
  damping,
  quadDrag = 0,
  maxTheta = MAX_THETA,
  omegaMax = Infinity,
  governorGain = 0
) {
  let a = pendulumAccel(state.theta, state.omega, length, gravity, damping, quadDrag);
  a += softWallAccel(state.theta, state.omega, maxTheta);
  a += speedGovernorAccel(state.omega, omegaMax, governorGain);

  state.omega += a * dt;
  state.theta += state.omega * dt;

  // Safety net only — the soft wall above should make this unreachable.
  const hard = maxTheta + HARD_LIMIT_SLACK;
  if (state.theta > hard) state.theta = hard;
  else if (state.theta < -hard) state.theta = -hard;
  return state;
}

/**
 * SPEED GOVERNOR — a soft wall in velocity space.
 *
 * The swing cycle is not energy-neutral and cannot be made so. Releases are
 * gated to happen on the forward stroke, which systematically cashes the swing
 * out at its fastest; the catch then preserves the full incoming velocity
 * (that is the price of a pop-free catch, and it is worth paying); and the
 * flight has usually gained altitude-energy on the way down. Every lap adds a
 * little. Left alone the character reaches several thousand units per second
 * inside twenty seconds.
 *
 * So something has to take energy out, and it should be something that does
 * nothing at all until the motion is already unreasonable — otherwise it
 * flattens the dynamic range that makes amplitude track the music. A quadratic
 * penalty above a threshold has exactly that shape: identically zero below
 * `omegaMax`, and steep enough above it that the speed cannot climb far past.
 *
 * Physically this is the character deliberately bleeding speed — reeling in
 * line, taking the impact on the legs. It is not friction, and it is not
 * pretending to be.
 */
export function speedGovernorAccel(omega, omegaMax, gain) {
  const a = Math.abs(omega);
  if (a <= omegaMax) return 0;
  const over = a - omegaMax;
  return -(omega > 0 ? 1 : -1) * gain * over * over;
}

/**
 * Continuous amplitude barrier. Zero (and zero-derivative) outside the margin,
 * so it contributes nothing to normal swinging.
 */
export function softWallAccel(theta, omega, maxTheta = MAX_THETA) {
  const s = theta >= 0 ? 1 : -1;
  const over = Math.abs(theta) - (maxTheta - WALL_MARGIN);
  if (over <= 0) return 0;
  // Quadratic in `over` so the force and its slope are both continuous at the
  // point the wall engages; a linear spring would produce a visible kink.
  let a = -s * WALL_K * over * over;
  // Damp only motion heading further out. Damping the return stroke as well
  // would make the character stick to the wall.
  if (omega * s > 0) a += -omega * WALL_C * over;
  return a;
}

/**
 * Specific mechanical energy (per unit mass) of the pendulum, in world units.
 *   E = 1/2 (L omega)^2  +  g L (1 - cos theta)
 * Potential is measured from the bottom of the arc.
 */
export function energy(theta, omega, length, gravity) {
  const v = length * omega;
  return 0.5 * v * v + gravity * length * (1 - Math.cos(theta));
}

/** Small-angle natural period: T = 2*pi*sqrt(L/g). */
export function naturalPeriod(length, gravity) {
  return 2 * Math.PI * Math.sqrt(length / gravity);
}

/** Inverse of naturalPeriod: the rope length whose period is T. */
export function lengthForPeriod(period, gravity) {
  const r = period / (2 * Math.PI);
  return gravity * r * r;
}

/**
 * PHASE-SAFE ENERGY INJECTION — the core trick of the whole project.
 *
 *   omega += impulse * Math.sign(omega)
 *
 * The push is applied ALONG the current direction of travel, never in a fixed
 * world direction. Why this matters: the song's beat period and the pendulum's
 * natural period are unrelated numbers. A naive impulse (`omega += impulse`,
 * always +x) lands on a random phase of the swing each time. Roughly half the
 * beats then arrive while the bob is travelling the other way and actively
 * cancel the swing — the character stalls mid-arc, reverses, and reads as
 * broken. Sign-locking makes every beat constructive by construction, for any
 * tempo, at any phase, forever. Amplitude then becomes a pure function of how
 * hard and how often the track is hitting, which is exactly the mapping we
 * want, and damping is what bleeds it back out.
 *
 * Guard on omega ~ 0 (the bob momentarily at rest at an extreme of the arc):
 * there is no direction of travel to lock to, so we pick the direction gravity
 * is about to take it, which is toward theta = 0.
 *
 * Invariant, asserted hard in tests: |result| >= |omega| for impulse >= 0.
 */
export function signLockedImpulse(theta, omega, impulse) {
  let s;
  if (Math.abs(omega) > EPS) {
    s = omega > 0 ? 1 : -1;
  } else if (Math.abs(theta) > EPS) {
    // At rest off-centre: gravity will drive it back toward vertical.
    s = theta > 0 ? -1 : 1;
  } else {
    // Dead centre and dead still. Any direction is as good as any other.
    s = 1;
  }
  return omega + Math.abs(impulse) * s;
}

/**
 * Fixed-timestep accumulator.
 *
 * Feed it arbitrary wall-clock deltas; it calls `fn(FIXED_DT)` a whole number
 * of times and carries the remainder to the next call. Total simulated time
 * therefore tracks total real time to within one step, and identical delta
 * sequences produce bit-identical results.
 */
export function createAccumulator(fixedDt = FIXED_DT, maxFrameDt = MAX_FRAME_DT) {
  let acc = 0;
  return {
    get remainder() {
      return acc;
    },
    /** Fractional progress into the next step; useful for render interpolation. */
    get alpha() {
      return acc / fixedDt;
    },
    reset() {
      acc = 0;
    },
    /** @returns {number} how many fixed steps were run. */
    run(dt, fn) {
      if (!Number.isFinite(dt) || dt <= 0) return 0;
      acc += dt > maxFrameDt ? maxFrameDt : dt;
      let n = 0;
      while (acc >= fixedDt) {
        if (n >= MAX_STEPS_PER_CALL) {
          // Cannot keep up. Drop the backlog instead of accumulating it, which
          // is what turns a hitch into a permanent death spiral.
          acc = 0;
          break;
        }
        fn(fixedDt);
        acc -= fixedDt;
        n++;
      }
      return n;
    },
  };
}

/**
 * A pendulum with a fixed-step integrator attached.
 * `length` is mutable — the choreographer retracts and extends the web — but
 * changing it mid-swing is done gradually (see choreo.js) because an
 * instantaneous length change is an instantaneous velocity change (v = L*omega)
 * and reads as a pop.
 */
export class Pendulum {
  constructor({
    theta = 0,
    omega = 0,
    length = 300,
    gravity = 2400,
    damping = 0.18,
    quadDrag = 0,
    maxTheta = MAX_THETA,
    omegaMax = Infinity,
    governorGain = 0,
  } = {}) {
    this.maxTheta = maxTheta;
    this.omegaMax = omegaMax;
    this.governorGain = governorGain;
    this.theta = theta;
    this.omega = omega;
    this.length = length;
    this.gravity = gravity;
    this.damping = damping;
    this.quadDrag = quadDrag;
    this._acc = createAccumulator();
  }

  /** Advance by a real-world delta using fixed sub-steps. */
  advance(dt) {
    return this._acc.run(dt, (h) =>
      stepSemiImplicit(this, h, this.length, this.gravity, this.damping, this.quadDrag, this.maxTheta,
        this.omegaMax, this.governorGain)
    );
  }

  /** Advance by exactly one fixed step (used by the outer sim's own accumulator). */
  stepFixed(h = FIXED_DT) {
    stepSemiImplicit(this, h, this.length, this.gravity, this.damping, this.quadDrag, this.maxTheta,
        this.omegaMax, this.governorGain);
  }

  pulse(impulse) {
    this.omega = signLockedImpulse(this.theta, this.omega, impulse);
  }

  get energy() {
    return energy(this.theta, this.omega, this.length, this.gravity);
  }

  get period() {
    return naturalPeriod(this.length, this.gravity);
  }

  /** Bob position for a given anchor, written into `out` to avoid allocating. */
  positionFrom(anchor, out = { x: 0, y: 0 }) {
    out.x = anchor.x + this.length * Math.sin(this.theta);
    out.y = anchor.y + this.length * Math.cos(this.theta);
    return out;
  }

  /** Bob velocity, written into `out`. */
  velocity(out = { x: 0, y: 0 }) {
    const s = this.omega * this.length;
    out.x = s * Math.cos(this.theta);
    out.y = -s * Math.sin(this.theta);
    return out;
  }

  /** Tangential speed magnitude (signed by direction of travel). */
  get speed() {
    return this.omega * this.length;
  }
}
