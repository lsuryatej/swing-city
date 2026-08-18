/**
 * SWINGER — the simulation entry point described in contract.js.
 *
 *   createSwinger({ gravity, minWebLength, maxWebLength }) -> Swinger
 *   Swinger.update(dt, input) -> void
 *   Swinger.pose -> Pose
 *
 * Three phases, and the whole design is organised around making the two
 * transitions between them invisible:
 *
 *   swing  -> flight : trivially continuous. We stop applying the rope
 *                      constraint and keep the exact position and velocity the
 *                      pendulum already had.
 *   flight -> swing  : made continuous by CHOOSING the anchor perpendicular to
 *                      the incoming velocity, so there is no radial component
 *                      for the rope to annihilate. See anchorForCatch().
 *
 * A pop at either seam is a bug, and both are covered by tests.
 */

import {
  Pendulum,
  FIXED_DT,
  createAccumulator,
  signLockedImpulse,
  naturalPeriod,
  MAX_THETA,
  clamp,
} from './pendulum.js';
import {
  CHOREO_DEFAULTS,
  predictBallistic,
  anchorForCatch,
  chooseWebLength,
  predictTheta,
  tangentAt,
  planLaunch,
} from './choreo.js';
import { createSkeleton } from './skeleton.js';
import { GRAVITY } from '../contract.js';

export const SWINGER_DEFAULTS = {
  gravity: GRAVITY,
  minWebLength: 180,
  maxWebLength: 620,
  preferredWebLength: 360,

  /**
   * Damping coefficient in theta'' = ... - damping * theta'.
   * This is what turns the sign-locked impulses into a signal rather than a
   * ratchet: without it, every beat adds energy forever and the character ends
   * up rotating over the bar. With it, amplitude settles at the level where
   * injection and bleed balance, so the size of the arc tracks how hard the
   * track is currently hitting. Amplitude half-life is ~ln2/(damping/2), so
   * 0.5 gives a musical memory of roughly 2.8 s — about a bar and a half.
   */
  damping: 0.5,

  /**
   * Quadratic governor on angular speed. Without it, every catch returns the
   * full flight speed (that is the price of a pop-free catch) and every beat
   * adds a little more, so the swing compounds until the character is orbiting
   * the anchor. 0.05 is negligible at a cruising ~3 rad/s and bites hard past
   * ~8, which caps the top end without touching the expressive range.
   */
  quadDrag: 0.05,

  /**
   * Speed governor. Does nothing below `omegaMax`; above it, bleeds hard.
   * 6.5 rad/s at a typical 230-unit rope is ~1500 world units/s, which is
   * already a fast, dramatic swing — the governor exists to stop the compound
   * growth described in speedGovernorAccel, not to set the cruising speed.
   */
  omegaMax: 6.5,
  governorGain: 20,

  /** Angular impulse per full-strength beat, rad/s. */
  beatImpulse: 0.38,
  /** Fraction of beatImpulse applied regardless of beat strength. */
  impulseFloor: 0.35,
  /** Continuous energy drizzle from live FFT bass, rad/s per unit energy. */
  energyGain: 0.55,

  /** Reduced-motion mode multiplies the amplitude clamp by this. */
  reducedAmplitude: 0.45,
  reducedMotion: false,

  /** Starting state. */
  startX: 0,
  startY: 620,
};

export function createSwinger(options = {}) {
  const cfg = { ...SWINGER_DEFAULTS, ...CHOREO_DEFAULTS, ...options };
  const g = cfg.gravity;

  const pendulum = new Pendulum({
    length: clamp(cfg.preferredWebLength, cfg.minWebLength, cfg.maxWebLength),
    gravity: g,
    damping: cfg.damping,
    quadDrag: cfg.quadDrag,
    omegaMax: cfg.omegaMax,
    governorGain: cfg.governorGain,
  });

  const skeleton = createSkeleton(options.skeleton);

  // --- Persistent state. Everything below is mutated in place; the hot path
  // --- allocates nothing.
  const hip = { x: cfg.startX, y: cfg.startY };
  const vel = { x: 260, y: 0 };
  const anchor = { x: cfg.startX, y: cfg.startY - pendulum.length };
  const up = { x: 0, y: -1 };

  // Scratch vectors, reused every step.
  const _v = { x: 0, y: 0 };
  const _p = { x: 0, y: 0 };
  const _dir = { x: 0, y: 0 };

  let phase = 'swing';
  let clock = 0;
  let targetLength = pendulum.length;
  let beatInterval = 0.5;
  let lastBeatClock = -1;

  // Flight bookkeeping.
  const launchPos = { x: 0, y: 0 };
  const launchVel = { x: 0, y: 0 };
  let flightElapsed = 0;
  let flightDuration = 0;

  let anchorElapsed = 0;
  let swingElapsed = 0;
  let webProgress = 1; // 0..1, how far the web has visually shot out
  let currentSwing = null; // the SwingPoint we are currently flying toward
  let plannedArrival = 0;
  let lastArrivalError = 0;

  const accumulator = createAccumulator(FIXED_DT);

  const pose = {
    anchor,
    hip,
    theta: 0,
    omega: 0,
    webLength: pendulum.length,
    phase,
    joints: skeleton.joints,
    // Extras beyond the contract, for the HUD and the debug overlay only. The
    // renderer proper reads pose.joints and nothing else.
    velocity: vel,
    webProgress,
    arrivalError: 0,
  };

  // prefers-reduced-motion narrows the arc rather than freezing it: the same
  // choreography, played smaller.
  const maxTheta = cfg.reducedMotion ? MAX_THETA * cfg.reducedAmplitude : MAX_THETA;
  pendulum.maxTheta = maxTheta;

  function syncFromPendulum() {
    pendulum.positionFrom(anchor, hip);
    pendulum.velocity(vel);
  }

  /** Body up-axis: along the rope while attached, a blend of world-up and the
   *  reverse of travel while airborne (so a dive reads as a dive). */
  function updateUp() {
    if (phase === 'flight') {
      const s = Math.hypot(vel.x, vel.y) || 1;
      const bx = -vel.x / s;
      const by = -vel.y / s;
      // Blend halfway to world up so the figure never goes fully head-down.
      let ux = bx * 0.55;
      let uy = by * 0.55 + -1 * 0.45;
      const n = Math.hypot(ux, uy) || 1;
      up.x = ux / n;
      up.y = uy / n;
    } else {
      const dx = anchor.x - hip.x;
      const dy = anchor.y - hip.y;
      const n = Math.hypot(dx, dy) || 1;
      up.x = dx / n;
      up.y = dy / n;
    }
  }

  /**
   * Leave the rope. Position and velocity carry over untouched — that is the
   * entire trick to making this seam invisible.
   */
  function release(duration) {
    syncFromPendulum();
    launchPos.x = hip.x;
    launchPos.y = hip.y;
    launchVel.x = vel.x;
    launchVel.y = vel.y;
    flightElapsed = 0;
    // The floor is deliberately tiny: a late release leaves a short flight,
    // and honouring it is what keeps arrival pinned to tNext.
    flightDuration = clamp(duration, 0.05, 2.6);
    plannedArrival = clock + flightDuration;
    phase = 'flight';
    webProgress = 0;
  }

  /**
   * Catch the next web. The anchor is placed perpendicular to the incoming
   * velocity so the rope constraint has nothing to remove.
   */
  function attach() {
    const L = clamp(targetLength, cfg.minWebLength, cfg.maxWebLength);
    // Passing cruiseY makes the catch angle self-correcting: the further the
    // character has drifted below cruise altitude, the more upright the
    // anchor, so height recovers instead of ratcheting downward.
    const sol = anchorForCatch(hip, vel, L, { cruiseY: cfg.cruiseY });
    anchor.x = sol.anchor.x;
    anchor.y = sol.anchor.y;
    pendulum.length = L;
    // NOT clamped: clamping here would break the perpendicular construction
    // and put back the velocity discontinuity it exists to remove. A steep
    // catch legitimately lands beyond the soft limit; the wall walks it back.
    pendulum.theta = sol.theta;
    pendulum.omega = sol.omega;
    // Re-derive hip from the pendulum so position is exactly on the rope; the
    // perpendicular construction makes this a no-op to within float error, but
    // being explicit keeps the invariant true by construction.
    syncFromPendulum();
    phase = 'anchor';
    anchorElapsed = 0;
    swingElapsed = 0;
    webProgress = 0;
    lastArrivalError = clock - plannedArrival;
  }

  /** Rate-limited rope-length change. An instantaneous length change is an
   *  instantaneous velocity change, because v = L * omega. */
  function easeLength(dt) {
    const want = clamp(targetLength, cfg.minWebLength, cfg.maxWebLength);
    const d = want - pendulum.length;
    const step = cfg.lengthRate * dt;
    pendulum.length += clamp(d, -step, step);
  }

  /**
   * One fixed sub-step of the whole machine.
   */
  /**
   * HEROIC ASSIST — deliberately not physics.
   *
   * Spider-Man is not a pendulum, and a physically honest pendulum does not
   * behave like Spider-Man. A real swing bleeds height on every cycle: some
   * energy goes to drag, the catch annihilates radial velocity, and nothing
   * ever puts height back. Left alone the character sinks below the skyline
   * and stays there, which is what the first build did — measured at 8000
   * units of descent in a single flight.
   *
   * The games cheat, openly and constantly: webs attach to empty sky, speed
   * appears from nowhere, and the player never sinks into the streets. So
   * altitude is treated here as a CONSTRAINT the simulation is bent to
   * satisfy, not an outcome it is allowed to produce.
   *
   * The trick is to translate the anchor and the character TOGETHER. The rope
   * vector, theta, omega and every derived velocity are unchanged, so the
   * swing dynamics do not notice; the whole apparatus just sits higher. That
   * makes this invisible in motion while being a hard guarantee.
   */
  function heroicAssist(dt) {
    const sag = hip.y - cfg.cruiseY;
    if (sag <= 0) return;

    // Proportional, so a small sag is corrected gently and a large one firmly,
    // and rate-capped so it can never read as the character being winched.
    let lift = Math.min(sag, sag * cfg.altitudeAssist * dt, cfg.maxLiftRate * dt);

    // Hard floor. The assist above is a spring and a spring can be outrun — a
    // long flight falls faster than any sane rate cap corrects, which is
    // exactly what happened before this existed: 8.5 seconds of airtime and
    // 7000 units of descent in one uninterrupted plunge. Below maxSag the
    // constraint stops negotiating.
    const excess = sag - lift - cfg.maxSag;
    if (excess > 0) lift += excess;

    hip.y -= lift;
    anchor.y -= lift;

    // Bleed off downward velocity as we lift, so the character does not fight
    // its own assist. Without this the parabola keeps accelerating downward
    // while being pushed up, which reads as stuttering rather than flight.
    if (vel.y > 0) vel.y = Math.max(0, vel.y - (lift / Math.max(dt, 1e-6)) * cfg.liftDrag);
  }

  function fixedStep(dt, input) {
    const next = input.nextSwing;

    if (phase === 'swing' || phase === 'anchor') {
      easeLength(dt);

      // --- Choreographed pre-release steering -----------------------------
      // Inside the yank window we predict where the swing will be at the
      // release instant, inverse-solve the launch speed that lands the flight
      // on tNext at the cruise altitude, and ramp omega toward it. Ramping (as
      // opposed to setting) is what keeps velocity continuous: the correction
      // starts at zero and grows, so it is an acceleration, not a jump.
      if (next && clock < next.t) {
        const tToRelease = next.t - clock;
        if (tToRelease <= cfg.yankWindow && tToRelease > 1e-4) {
          const flight = next.tNext - next.t;
          if (flight > 0.05) {
            const thetaRel = predictTheta(
              pendulum.theta,
              pendulum.omega,
              tToRelease,
              pendulum.length,
              g
            );
            tangentAt(thetaRel, pendulum.omega, _dir);
            _p.x = anchor.x + pendulum.length * Math.sin(thetaRel);
            _p.y = anchor.y + pendulum.length * Math.cos(thetaRel);

            const plan = planLaunch(_p, _dir, flight, g, cfg);
            if (plan.conditioned) {
              const sign = pendulum.omega >= 0 ? 1 : -1;
              const cur = Math.abs(pendulum.omega);
              // Bound the ask to a band around the swing speed we already
              // have. The solver is happy to demand a launch three times
              // faster than the character is moving; delivering that in 140 ms
              // is a pop, and the residual costs us nothing because the next
              // anchor goes wherever we actually land.
              const wantMag = clamp(
                plan.speed / pendulum.length,
                cur * cfg.yankSpeedBand[0],
                cur * cfg.yankSpeedBand[1]
              );
              // Track a linear ramp to the target across the remaining window:
              // dt/tToRelease is exactly the fraction of the remaining error
              // this sub-step should retire, so the per-step change is constant
              // rather than front- or back-loaded.
              const k = clamp((dt / tToRelease) * cfg.yankAuthority, 0, 1);
              let dOmega = (wantMag * sign - pendulum.omega) * k;
              // Hard acceleration ceiling: continuity guarantee of last resort.
              const cap = cfg.maxYankAccel * dt;
              pendulum.omega += clamp(dOmega, -cap, cap);
            }
          }
        }
      }

      // Amplitude limiting lives inside the integrator as a soft barrier; see
      // softWallAccel. Clamping theta out here would reintroduce the pop.
      pendulum.stepFixed(dt);
      syncFromPendulum();
      heroicAssist(dt);

      if (phase === 'anchor') {
        anchorElapsed += dt;
        webProgress = clamp(anchorElapsed / cfg.anchorTime, 0, 1);
        if (anchorElapsed >= cfg.anchorTime) {
          phase = 'swing';
          webProgress = 1;
        }
      } else {
        swingElapsed += dt;
        webProgress = 1;
      }

      // --- Release decision ------------------------------------------------
      // The `next !== currentSwing` guard stops us re-releasing against a
      // swing point the caller has not yet advanced past.
      if (next && next !== currentSwing && clock >= next.t - cfg.releaseEarly) {
        // Only let go when the tangent is up-and-forward. See releaseGrace in
        // CHOREO_DEFAULTS: arrival stays pinned to tNext either way, so this
        // costs nothing musically and saves the arc from becoming a fall.
        tangentAt(pendulum.theta, pendulum.omega, _dir);
        // Travelling forward is NON-NEGOTIABLE. Letting go on the backswing
        // launches the character the way they came, and since every catch
        // preserves the incoming velocity, one backwards release turns into
        // sustained backwards travel that the choreography never recovers
        // from. The pendulum crosses the forward-moving half of its arc once
        // per period, so waiting for it is always cheap.
        const forwardOk = _dir.x > cfg.releaseMinForward;
        const risingOk = _dir.y < cfg.releaseMaxRise;
        // Rising, by contrast, IS negotiable: under time pressure a flat
        // launch is much better than a late one.
        const budget = Math.min(cfg.releaseGrace, (next.tNext - next.t) * 0.4);
        const overdue = clock - next.t >= budget;
        // Last possible moment to leave and still land on tNext.
        const mustGoBy = next.tNext - cfg.minFlightTime;

        const late = clock >= next.t;
        if (forwardOk && (risingOk || (late && (overdue || clock >= mustGoBy)))) {
          currentSwing = next;
          // Whatever time is left is exactly the flight time: arrival lands on
          // tNext regardless of how late the release ended up being.
          const remaining = next.tNext - clock;
          release(remaining > 0.05 ? remaining : cfg.minFlightTime);
        } else if (clock >= mustGoBy) {
          // Out of time and still pointing the wrong way. Skipping the beat is
          // strictly better than launching backwards: a missed swing point is
          // invisible, whereas one backwards launch is preserved by every
          // subsequent catch and sends the character back the way it came.
          currentSwing = next;
        }
      } else if (!next && swingElapsed >= cfg.reactiveSwingTime) {
        // Reactive fallback: no plan, so release on the forward upswing, where
        // the launch direction is naturally up-and-forward.
        if (pendulum.omega > 0 && pendulum.theta > 0.25) {
          currentSwing = null;
          release(naturalPeriod(pendulum.length, g) * 0.42);
        }
      }
      return;
    }

    // --- Flight -----------------------------------------------------------
    // Free parabola. The last sub-step is truncated to land exactly on the
    // planned arrival time rather than up to one step past it, which is what
    // keeps the beat-sync tight.
    let h = dt;
    if (flightElapsed + h > flightDuration) h = flightDuration - flightElapsed;
    if (h > 0) {
      hip.x += vel.x * h;
      hip.y += vel.y * h + 0.5 * g * h * h;
      vel.y += g * h;
      flightElapsed += h;
    }
    // The altitude constraint applies in the air too. This is the phase where
    // it matters most: a long flight is the only place the character can fall
    // far enough to leave the skyline entirely.
    heroicAssist(dt);
    webProgress = 0;

    if (flightElapsed >= flightDuration - 1e-9) {
      attach();
      // Any leftover of this sub-step is simply carried by the next one; the
      // error is bounded by FIXED_DT and does not accumulate.
    }
  }

  const swinger = {
    /** @param {number} dt @param {object} input */
    update(dt, input = {}) {
      const now = input.now;
      if (Number.isFinite(now)) clock = now;

      // Beat interval inference, used to tune the rope toward a musical
      // period. The sandbox and the audio side can also set it explicitly.
      if (input.beatPulse) {
        if (lastBeatClock >= 0) {
          const gap = clock - lastBeatClock;
          if (gap > 0.15 && gap < 2.0) beatInterval = beatInterval * 0.7 + gap * 0.3;
        }
        lastBeatClock = clock;
      }

      // Tune rope length so the natural period sits on a musical subdivision.
      targetLength = chooseWebLength(beatInterval, g, {
        minLength: cfg.minWebLength,
        maxLength: cfg.maxWebLength,
        preferred: cfg.preferredWebLength,
      });

      // --- Energy injection ------------------------------------------------
      // Both paths go through signLockedImpulse: the push is always along the
      // current direction of travel, so it can never fight the swing no matter
      // how the tempo relates to the pendulum's natural period.
      if (input.beatPulse && phase !== 'flight') {
        const strength = Number.isFinite(input.beatStrength) ? input.beatStrength : 1;
        const amt =
          cfg.beatImpulse * (cfg.impulseFloor + (1 - cfg.impulseFloor) * clamp(strength, 0, 1));
        pendulum.omega = signLockedImpulse(pendulum.theta, pendulum.omega, amt);
      }
      const energy = Number.isFinite(input.energy) ? clamp(input.energy, 0, 1) : 0;
      if (energy > 0 && phase !== 'flight') {
        const dtc = clamp(dt, 0, 0.05);
        pendulum.omega = signLockedImpulse(
          pendulum.theta,
          pendulum.omega,
          cfg.energyGain * energy * dtc
        );
      }

      // --- Fixed-step integration ------------------------------------------
      accumulator.run(dt, (h) => {
        fixedStep(h, input);
        clock += h;
      });

      updateUp();

      // Skeleton runs on the real frame delta, not the fixed step: the springs
      // are solved in closed form so they are exact at any dt, and running
      // them once per frame instead of 240 times per second is free accuracy
      // we do not need to pay for.
      skeleton.solve(
        { hip, anchor, vel, up, attached: phase !== 'flight' },
        clamp(dt, 1e-4, 0.1)
      );

      pose.theta = pendulum.theta;
      pose.omega = pendulum.omega;
      pose.webLength = pendulum.length;
      pose.phase = phase;
      pose.webProgress = webProgress;
      pose.arrivalError = lastArrivalError;
    },

    get pose() {
      return pose;
    },

    /** Manual impulse (spacebar in the sandbox). Sign-locked like every other
     *  injection, so mashing it can only ever add energy. */
    pulse(amount = cfg.beatImpulse) {
      if (phase !== 'flight') {
        pendulum.omega = signLockedImpulse(pendulum.theta, pendulum.omega, amount);
      }
    },

    /** Explicit tempo hint; lets the rope length track the track. */
    setBeatInterval(seconds) {
      if (seconds > 0.05 && seconds < 4) beatInterval = seconds;
    },

    reset(x = cfg.startX, y = cfg.startY) {
      hip.x = x;
      hip.y = y;
      vel.x = 260;
      vel.y = 0;
      pendulum.theta = -0.5;
      pendulum.omega = 1.2;
      pendulum.length = clamp(cfg.preferredWebLength, cfg.minWebLength, cfg.maxWebLength);
      anchor.x = hip.x - pendulum.length * Math.sin(pendulum.theta);
      anchor.y = hip.y - pendulum.length * Math.cos(pendulum.theta);
      syncFromPendulum();
      phase = 'swing';
      swingElapsed = 0;
      webProgress = 1;
      accumulator.reset();
      skeleton.reset();
    },

    /** Introspection for the HUD and the tests. */
    get debug() {
      return {
        phase,
        clock,
        beatInterval,
        targetLength,
        flightElapsed,
        flightDuration,
        plannedArrival,
        arrivalError: lastArrivalError,
        currentSwing,
        launchPos,
        launchVel,
        up,
      };
    },
    config: cfg,
    pendulum,
    skeleton,
  };

  swinger.reset();
  // Prime the pose so a renderer can draw frame 0 without calling update.
  updateUp();
  skeleton.solve({ hip, anchor, vel, up, attached: true }, 1 / 60);
  pose.theta = pendulum.theta;
  pose.omega = pendulum.omega;
  pose.webLength = pendulum.length;
  pose.phase = phase;

  return swinger;
}

export { predictBallistic, anchorForCatch, chooseWebLength } from './choreo.js';
