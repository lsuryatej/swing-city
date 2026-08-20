/**
 * Swing model: freefall, web to a visible roof, pump the pendulum, release
 * up-and-forward.
 *
 * WHAT CAME BEFORE, AND WHY IT WAS WRONG
 * --------------------------------------
 * Two earlier models failed, each instructively.
 *
 * A *pure pendulum* oscillated: its defining behaviour is returning to where
 * it started, so it read as a metronome, and the backswing was the source of
 * the jerky web arm (travelling backward relative to the anchor makes the arm
 * whip around).
 *
 * A *radial grapple* pulled the character toward the anchor. That was a
 * physics error: on a circular path a radial force does almost no work, so
 * every grapple bought a weak hop rather than a climb. Energy has to go in
 * TANGENTIALLY — which is what pumping a swing actually is.
 *
 * THE MODEL HERE
 * --------------
 *   freefall — full gravity, no floor. The drop is not wasted time; it is
 *              where the potential energy comes from.
 *   fire     — web travels to a chosen roof at finite speed
 *   swing    — rope constrains him to a circle; a TANGENTIAL boost scaled by
 *              audio energy pumps the arc, strongest at the bottom where it
 *              does the most work
 *   release  — when the velocity vector points up-and-forward at ~45 degrees
 *
 * GEOMETRY, WHICH DRIVES EVERY NUMBER HERE
 * ----------------------------------------
 * Anchors are constrained to roofs the viewer can actually see — the city is
 * the mechanism, not a backdrop. That constraint sets the radius budget: the
 * bottom of the arc lands at anchor.y + ropeLength, the screen is ~1080 tall,
 * and the tallest roofs sit near y 310. To keep the bottom of the swing in
 * frame the rope wants to be roughly 550, so the anchor search runs ~400-750
 * ahead rather than the 1000+ a longer arc would want. A 550 rope has a period
 * of about 3.1s, so a half-swing is ~1.5s: close enough to one bar to feel
 * musical.
 */

import { GRAVITY, WORLD_HEIGHT } from '../contract.js';
import { createSkeleton } from './skeleton.js';
import { createAccumulator } from './pendulum.js';

export const SWING_DEFAULTS = {
  gravity: GRAVITY, // 2400, constant in EVERY phase

  /** Altitude the traversal drifts around. Not enforced; see emergency drop. */
  cruiseY: WORLD_HEIGHT * 0.39,

  /** Baseline forward speed he is nudged toward while falling. */
  cruiseSpeedX: 640,
  /**
   * Horizontal drag, per second. Deliberately weak: momentum earned from a
   * swing should survive the next fall rather than being scrubbed off.
   */
  cruiseDrag: 0.05,

  /**
   * Quadratic drag coefficient, applied always.
   *
   * This replaces the hard speed cap, and it is not optional. Adding
   * tangential energy every swing makes this a DRIVEN oscillator, and a driven
   * oscillator with no dissipation grows without bound — gravity only trades
   * energy back and forth over a cycle, it never removes any. Quadratic drag
   * self-limits at a terminal speed and looks natural doing it.
   */
  dragQuad: 0.00035,
  /** Backstop only; drag should be what actually holds the ceiling. */
  maxSpeed: 2600,

  /** Web extension speed. Fast, so the thwip reads as a snap. */
  webSpeed: 6000,

  /** Anchor search window. Short because roof height caps the radius; see the
   *  geometry note above. `maxAnchorAhead` is the far edge used at FULL
   *  energy — unchanged from before this file scaled with the music, so it
   *  is still the proven-safe ceiling. */
  minAnchorAhead: 400,
  maxAnchorAhead: 900,
  /**
   * Near edge of the reach window at zero energy, paired with
   * `maxAnchorAhead` above. A quiet verse should reach for the nearest roof
   * that clears him, not the same 900-unit window every time — reaching far
   * on a quiet passage produced a swing that LOOKED like a chorus while the
   * track was doing nothing. See `anchorReach()`.
   */
  maxAnchorAheadFloor: 550,
  /** Floor of the reach/rope energy curves, separate from `energyFloor`
   *  below (which exists so the PUMP never fully stalls). These are allowed
   *  to sit low: reach and rope length should visibly shrink in a quiet
   *  verse, that is the point of this whole change. */
  arcEnergyFloor: 0.12,
  /** Attach point sits this far above the roof surface — a web wraps a corner,
   *  it does not terminate flush. */
  roofClearance: 30,
  /** How many of the tallest candidates to rotate through. Larger = more
   *  variety, but dips into shorter roofs and therefore shorter arcs. */
  anchorPool: 3,

  /** Tangential pump acceleration at full energy, units/sec^2. Comparable to
   *  gravity, so it meaningfully drives the arc. */
  pumpAccel: 2600,
  /** Height above cruise over which the pump fades out. */
  pumpFadeHeight: 420,
  /** Pump multiplier when well above cruise. */
  pumpMinHigh: 0.1,
  /** Energy floor, so quiet passages still swing — just less. Raw energy sits
   *  near zero a lot of the time and would stall the pump entirely. */
  energyFloor: 0.35,

  /** Release when the velocity vector is at least this far above horizontal. */
  releaseAngle: Math.PI / 4,
  /** Give up and release anyway after this long on the rope, so a shallow
   *  swing that never reaches the release angle cannot hang forever. */
  maxSwingTime: 2.6,
  /** Minimum time on the rope, so a grazing catch cannot instantly release. */
  minSwingTime: 0.25,
  /**
   * Minimum freefall before the next web may be fired.
   *
   * This is what buys airtime and horizontal distance. Without it he webbed on
   * every beat (0.63s at 95 BPM), which meant no fall, no speed, almost no
   * ground covered, and — critically — he never sank into the roof band, so
   * every anchor was a fallback point in empty sky.
   */
  minFreefallTime: 1.15,
  /**
   * Fraction of minFreefallTime at which the NEXT anchor is committed.
   *
   * The anchor used to be chosen at the instant of firing, which left the
   * renderer nothing to telegraph: the target did not exist until it was
   * already being hit. Committing early exposes it as `pose.nextAnchor` for a
   * count-in, and costs nothing — an anchor picked 0.4s early is still a roof
   * ahead of him, and a target that stops moving is exactly what makes the
   * count-in legible. Re-validated at fire time regardless.
   */
  anchorCommitAt: 0.35,
  /** Clearance required of a roof at COMMIT time. A little above the 40 the
   *  physics needs, purely as margin. */
  commitClearance: 70,
  /** Extra kick at release, scaled by energy. */
  releaseKick: 140,

  /** Rope shorter than this has no meaningful radial direction. */
  minRope: 40,
  /** Longest usable radius. See the geometry note: bottom of arc lands at
   *  anchor.y + rope, and the screen ends at ~1080. Also the QUIETEST rope
   *  target now — see `chooseWebLength()` — a long rope leaves him further
   *  below the anchor at the end of the reel, which is the small, low arc a
   *  quiet passage wants. */
  maxRope: 620,
  /**
   * Rope-length target at FULL energy. Paired with `maxRope` above through
   * `chooseWebLength()` — a short target for a loud passage, because a short
   * target reels him in CLOSE to the anchor, and that climb is the visible
   * arc. See that function's doc comment for the reasoning and the wrong
   * turn taken getting there.
   *
   * Before this whole mechanism existed, every fall long enough to clear
   * `minFreefallTime` (about 1.15s of gravity) covered well over 620 units,
   * so `ropeTarget` was `clamp(raw, minRope, maxRope)` with `raw` almost
   * always past the ceiling — meaning ropeTarget was, in practice, just
   * `maxRope`, a constant, every single swing. That is the bug this file was
   * written to fix: energy fed the tangential pump, but the ROPE — the thing
   * that actually sets how big the recovery reads — never heard about it.
   * Loud and quiet passages produced statistically identical arcs.
   */
  ropeReelFloor: 300,
  /**
   * Fraction of the remaining rope excess reeled in per second.
   *
   * Raised from 3.2. At 3.2 the reel barely dents a 1500-2000 unit overshoot
   * before `maxSwingTime` cuts the swing off — measured, `ropeLength` was
   * still 700+ units from `chooseWebLength()`'s target when most swings
   * ended, which made the whole energy-scaled target close to moot: the
   * target the reel is chasing barely matters if it never gets there.
   *
   * Tried 8 first. It closes the gap faster and the height ratio measured
   * even bigger, but swept across tempos it measurably raised the emergency
   * rate at low energy on some (135-145 BPM, specifically) — a weak pump
   * plus a fast reel is still a weak pump, and at that tempo the beat grid
   * left less room to recover before the next drop. 4 is the number where
   * every tempo tested (95/120/140/174 BPM) held at or under its own
   * baseline emergency rate.
   */
  reelRate: 4,
  /** Minimum reel speed, units/sec, so the last few units do not crawl. */
  reelFloor: 90,

  /**
   * Emergency anchor. NOT a floor he rides — a state he should never reach in
   * normal play. Removing the old hard floor is correct (no drop means no
   * potential energy means no swing), but an earlier build measured 8000 units
   * of uninterrupted descent when anchor selection failed, which is
   * unrecoverable. This catches that.
   */
  emergencyDrop: 1200,

  /**
   * Fraction of `emergencyDrop` at which the count-in ring STOPS promising.
   *
   * Emergency recovery fires at whatever it can reach, which is not
   * necessarily the roof the ring has spent several beats pointing at. The
   * ring going dark at the same instant the web leaves for somewhere else is
   * a visible broken promise, and a count-in that lies is worse than no
   * count-in — it is the one element on screen whose whole job is to prove the
   * choreography is planned.
   *
   * Measured before this existed: at low energy 61-78% of count-ins were
   * broken this way. It did not show up in tests because the test excluded
   * emergency fires, so it asserted the invariant the code happened to have
   * rather than the one a viewer sees.
   *
   * Withdrawing the promise EARLY, while he is still falling and well before
   * the emergency threshold, means the ring fades out during the fall rather
   * than being contradicted at the fire.
   *
   * Tuned by measurement, not taste. At 0.55 the count-in became honest and
   * almost never appeared — no lie, no proof either. At 1.0 (i.e. abandoning
   * only at the emergency itself) the old 61-78% lie rate came straight back.
   * 0.9 is the knee: zero broken promises at every tempo and energy tested,
   * and the ring still shows on most high-energy swings.
   *
   * That it shows RARELY during quiet passages is not this constant's fault.
   * It is reporting the real problem — see the emergency-rate note in
   * HANDOFF.md. Do not raise this to make the ring appear more often; that
   * only restores the lie.
   */
  ringAbandonAt: 0.9,

  startX: 0,
  startY: WORLD_HEIGHT * 0.34,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createSwinger(options = {}) {
  const cfg = { ...SWING_DEFAULTS, ...options };
  const findBuildings = options.buildingsAheadOf ?? null;

  const skeleton = createSkeleton(options.skeleton);
  const accumulator = createAccumulator();

  const hip = { x: cfg.startX, y: cfg.startY };
  const vel = { x: cfg.cruiseSpeedX, y: 0 };
  const anchor = { x: cfg.startX, y: cfg.startY - 400 };
  const webTip = { x: hip.x, y: hip.y };

  let phase = 'freefall';
  let clock = 0;
  let ropeLength = 0;
  let attached = false;
  let currentSwing = null;
  let swingTime = 0;
  let freefallTime = 0;
  let energy = 0.5;
  let swingCount = 0;
  let ropeTarget = 0;
  /** The anchor the next web WILL go to, committed before the fire beat so the
   *  renderer can telegraph it. Null whenever there is nothing to telegraph. */
  let plannedAnchor = null;

  /* ------------------------------------------------------------------ *
   * Energy -> arc plan                                                  *
   *                                                                      *
   * Both of these are PLAN values — read once, when a swing is set up    *
   * (anchor search, rope clamp) — not forces applied during it. That     *
   * matters here specifically: the pump already reads energy every       *
   * frame, and turning it up further to make arcs bigger was tried and   *
   * produces exactly what it should not — a bigger FORCE fighting the    *
   * same drag ceiling, which mostly shows up as a faster swing at        *
   * nearly the same radius, not a bigger one. The radius has to be       *
   * decided before the swing starts.                                    *
   * ------------------------------------------------------------------ */

  /** Shared low-energy floor for both curves below, kept out of
   *  `energyFloor` (the pump's own floor) on purpose — see
   *  `arcEnergyFloor`'s doc comment. */
  function arcDrive(e) {
    return cfg.arcEnergyFloor + (1 - cfg.arcEnergyFloor) * e;
  }

  /**
   * Rope-length ceiling for THIS swing. `raw` (how far he actually fell) is
   * still clamped against it in `stepFire`, so a short fall never gets
   * artificially stretched.
   *
   * COUNTERINTUITIVE, so read this before changing it: a LONGER target rope
   * produces a SMALLER visible recovery. `raw` is routinely 1500-2000+ —
   * several times any sane rope length — because he free-falls under full
   * gravity for `minFreefallTime` before the beat lets him fire, so every
   * swing starts by reeling in from a huge overshoot rather than settling
   * into an oscillation. The reel is the whole visible arc: it is what
   * carries him from the bottom of the dive back up toward the anchor. A
   * SHORT target reels him in CLOSE to the anchor — a big, dramatic recovery
   * that climbs a long way — and a LONG target leaves him further below it —
   * a small, shallow recovery.
   *
   * First attempt got this backwards: longer rope for loud passages, on the
   * (correct, for an actual oscillating pendulum) intuition that a longer
   * rope swings bigger. Measured result was the opposite of the brief — loud
   * passages came out LOWER than quiet ones — because this file's rope never
   * gets anywhere near equilibrium long enough to oscillate; it is a winch,
   * not a pendulum, for the entire useful duration of a swing.
   */
  function chooseWebLength(e) {
    return cfg.maxRope - (cfg.maxRope - cfg.ropeReelFloor) * arcDrive(e);
  }

  /** Far edge of the anchor search window for THIS pick. A big arc that
   *  only got taller and not further would read as a bounce, not a swing —
   *  reach has to grow with it. */
  function anchorReach(e) {
    return cfg.maxAnchorAheadFloor + (cfg.maxAnchorAhead - cfg.maxAnchorAheadFloor) * arcDrive(e);
  }

  /* ------------------------------------------------------------------ *
   * Anchor selection                                                    *
   * ------------------------------------------------------------------ */

  /**
   * @param {number} clearance  How far above him a roof must sit to qualify.
   *
   * The default is the physical minimum. The COMMIT path asks for much more,
   * and has to: freefall begins with an upward launch, so he is often HIGHER
   * at the fire beat than he was when the target was picked. A roof chosen
   * with only the minimum clearance is therefore routinely invalid by the time
   * it is used, and re-picking at the last moment moves the target the ring has
   * spent four beats pointing at. Measured, that was 6 of 17 swings.
   */
  function chooseAnchor(clearance = 40) {
    if (findBuildings) {
      // Only roofs actually ABOVE him are usable: webbing a roof at or below
      // your own height gives a sideways rope that carries no weight, which is
      // what produced a runaway descent in an earlier build.
      const usable = findBuildings(hip.x, cfg.minAnchorAhead, anchorReach(energy))
        .filter((b) => b.y < hip.y - clearance)
        .sort((a, b) => a.y - b.y); // tallest (smallest y) first

      if (usable.length) {
        // Vary WHICH of the tall candidates gets used, AND — this is the
        // energy hook — vary how tall a candidate energy is even allowed to
        // reach for.
        //
        // Always taking the tallest made the motion visibly loop: the skyline
        // is one repeating tile, so that rule resolved to the same five
        // buildings forever and every swing came out identical. Rotating
        // through a band by a counter breaks the period without giving up
        // the height preference.
        //
        // The band itself SLIDES with energy rather than sitting fixed at the
        // top. This is the one lever in this file that moves the needle on
        // its own: anchor height sets `anchor.y` directly, and everything
        // downstream — the rope's resting length, the swing's resting
        // altitude — is `anchor.y + (something bounded)`. A rope-length or
        // reel-speed change only ever adjusts that second term, and by the
        // time a fall this deep has reeled in at all, the swing is usually
        // over; the anchor's own height is not subject to that arithmetic, it
        // is added once and holds. A quiet passage settles for whatever roof
        // clears him with the least margin — a small, low arc. A loud one
        // reaches for the tallest roof in range — a bigger reel-in, a higher
        // ceiling, an arc that actually reads as bigger on screen.
        const pool = Math.max(1, Math.min(cfg.anchorPool, usable.length));
        const bands = Math.max(1, usable.length - pool + 1);
        const bandStart = Math.round((1 - arcDrive(energy)) * (bands - 1));
        const b = usable[bandStart + (swingCount % pool)];
        swingCount++;
        return { x: b.x, y: b.y - cfg.roofClearance };
      }
    }
    // No suitable roof. Anchor at a FIXED altitude, never relative to him.
    //
    // Using hip.y - 320 built an infinite ladder: once he rose above every
    // roof, nothing qualified, so the fallback placed each anchor 320 above
    // wherever he already was and he climbed out of the world. Measured
    // running away to y = -1449. A fixed band cannot ratchet.
    // `min` here would take whichever is HIGHER and re-create the ladder, so
    // the fixed band wins and the relative term only applies when he is
    // already low enough for it to sit below the band.
    return {
      x: hip.x + cfg.minAnchorAhead,
      y: Math.max(cfg.cruiseY - 300, hip.y - 420),
    };
  }

  function fireAt(target) {
    anchor.x = target.x;
    anchor.y = target.y;
    webTip.x = hip.x;
    webTip.y = hip.y;
    phase = 'fire';
    attached = false;
  }

  /* ------------------------------------------------------------------ *
   * Shared forces                                                       *
   * ------------------------------------------------------------------ */

  function applyDrag(dt) {
    const s = Math.hypot(vel.x, vel.y);
    if (s < 1e-6) return;
    const d = cfg.dragQuad * s * dt;
    vel.x -= vel.x * d;
    vel.y -= vel.y * d;
    if (s > cfg.maxSpeed) {
      vel.x = (vel.x / s) * cfg.maxSpeed;
      vel.y = (vel.y / s) * cfg.maxSpeed;
    }
  }

  function integrate(dt) {
    hip.x += vel.x * dt;
    hip.y += vel.y * dt;
  }

  /* ------------------------------------------------------------------ *
   * Phases                                                              *
   * ------------------------------------------------------------------ */

  function stepFreefall(dt) {
    freefallTime += dt;
    vel.y += cfg.gravity * dt; // full gravity, always
    vel.x -= (vel.x - cfg.cruiseSpeedX) * cfg.cruiseDrag * dt;
    applyDrag(dt);
    integrate(dt);
  }

  function stepFire(dt) {
    stepFreefall(dt); // he keeps falling while the line travels

    const dx = anchor.x - webTip.x;
    const dy = anchor.y - webTip.y;
    const dist = Math.hypot(dx, dy);
    const step = cfg.webSpeed * dt;

    if (dist <= step) {
      webTip.x = anchor.x;
      webTip.y = anchor.y;
      attached = true;
      // Clamp the radius. Rope length is whatever the gap happened to be at
      // the instant of contact, and after a long fall that measured 1521 —
      // roughly three times the design radius, putting the bottom of the arc
      // 800 units below the screen. Clamping means a long fall ends with the
      // line snapping taut and yanking him onto the circle, which is both
      // correct for a rope and better-looking than an enormous lazy arc.
      // Start the rope at its ACTUAL length and reel it in, rather than
      // clamping it immediately.
      //
      // Clamping on contact was a visible teleport: the swing step snaps the
      // character onto a circle of radius `ropeLength`, so if he made contact
      // 900 away and the rope was clamped to 620, he jumped 280 units toward
      // the anchor in a single frame. The clamp is still wanted — it stops a
      // long fall producing a 1500-unit arc that swings off the bottom of the
      // screen — but it has to be reached continuously.
      //
      // Reeling in is also just what a web-line does, so the fix costs nothing
      // in plausibility.
      const raw = Math.hypot(hip.x - anchor.x, hip.y - anchor.y);
      ropeLength = Math.max(raw, cfg.minRope);
      // The upper bound used to be the constant `cfg.maxRope`. It almost
      // never bound anything BUT that ceiling: `raw` after a minFreefallTime
      // fall is routinely past 620, so ropeTarget was, in effect, always
      // `maxRope` regardless of energy — see `chooseWebLength()`'s doc
      // comment for the measurement. Swapping in the energy-scaled ceiling
      // is what actually lets a quiet passage reel in shorter.
      ropeTarget = clamp(raw, cfg.minRope, chooseWebLength(energy));
      swingTime = 0;
      freefallTime = 0;
      phase = 'swing';
    } else {
      webTip.x += (dx / dist) * step;
      webTip.y += (dy / dist) * step;
    }
  }

  function stepSwing(dt) {
    swingTime += dt;

    // Reel toward the target radius. Exponential, so it is fastest when the
    // discrepancy is largest and settles without a hard stop.
    if (ropeLength > ropeTarget) {
      ropeLength = Math.max(ropeTarget, ropeLength - (ropeLength - ropeTarget) * cfg.reelRate * dt - cfg.reelFloor * dt);
    }

    vel.y += cfg.gravity * dt;

    // --- Rope constraint, by vector projection --------------------------
    // n points anchor -> character. Any velocity along n would stretch the
    // rope, and a rope cannot stretch, so that component is removed. Position
    // is then snapped back onto the circle to stop numerical drift
    // accumulating over a long arc.
    let dx = hip.x - anchor.x;
    let dy = hip.y - anchor.y;
    let dist = Math.hypot(dx, dy);

    if (dist > cfg.minRope) {
      const nx = dx / dist;
      const ny = dy / dist;

      const radial = vel.x * nx + vel.y * ny;
      if (radial > 0) {
        vel.x -= nx * radial;
        vel.y -= ny * radial;
      }

      // --- The pump ------------------------------------------------------
      // Energy goes in ALONG THE TANGENT. This is the correction to the
      // previous model: a radial pull does almost no work on a circular path,
      // which is why grapples used to produce weak hops. Pumping a swing is
      // tangential, and so is this.
      //
      // Weighted by ny, which peaks at 1 when he is directly below the anchor.
      // That is both where a real swing is pumped and where the boost does the
      // most work, since speed is highest there.
      let tx = -ny;
      let ty = nx;
      if (vel.x * tx + vel.y * ty < 0) {
        tx = -tx;
        ty = -ty;
      }
      const bottomness = clamp(ny, 0, 1);
      const drive = cfg.energyFloor + (1 - cfg.energyFloor) * energy;
      // Altitude damping. The pump is a driver, and a driver with no ceiling
      // ratchets: every swing ended higher than the last until he left the
      // top of the frame. Fading it out above cruise means altitude settles
      // into a band instead of growing without bound, and it costs nothing
      // visually because a high swing does not need the extra push.
      const high = clamp((cfg.cruiseY - hip.y) / cfg.pumpFadeHeight, 0, 1);
      const altitudeGate = 1 - high * (1 - cfg.pumpMinHigh);
      const pump = cfg.pumpAccel * drive * bottomness * altitudeGate * dt;
      vel.x += tx * pump;
      vel.y += ty * pump;
    }

    applyDrag(dt);
    integrate(dt);

    // Snap back onto the circle.
    dx = hip.x - anchor.x;
    dy = hip.y - anchor.y;
    dist = Math.hypot(dx, dy);
    if (dist > cfg.minRope) {
      hip.x = anchor.x + (dx / dist) * ropeLength;
      hip.y = anchor.y + (dy / dist) * ropeLength;
    }

    // --- Release --------------------------------------------------------
    // Fire when the velocity vector points up and forward. `vel.x > 0` is
    // essential: the velocity also passes through 45 degrees on the BACKSWING,
    // and releasing there launches him the way he came.
    const rising = -vel.y; // +y is down
    const angle = Math.atan2(rising, Math.abs(vel.x));
    const goingForward = vel.x > 0;
    const ready = swingTime >= cfg.minSwingTime;

    // A shallow swing may never reach the release angle, so it must not be the
    // only way off the rope.
    const stalled = swingTime > cfg.maxSwingTime;

    if (ready && ((goingForward && angle >= cfg.releaseAngle) || stalled)) {
      // The kick fades with altitude for the same reason the pump does: an
      // unconditional upward impulse every cycle is a ratchet. With it always
      // on he settled ABOVE every roof, which meant no building ever qualified
      // as an anchor and he swung from fallback points in empty sky — exactly
      // what anchoring to visible roofs is meant to avoid.
      const highK = clamp((cfg.cruiseY - hip.y) / cfg.pumpFadeHeight, 0, 1);
      const kick =
        cfg.releaseKick *
        (cfg.energyFloor + (1 - cfg.energyFloor) * energy) *
        (1 - highK);
      vel.y -= kick;
      if (vel.x < cfg.cruiseSpeedX * 0.35) vel.x = cfg.cruiseSpeedX * 0.35;
      phase = 'freefall';
      attached = false;
      currentSwing = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Step                                                                *
   * ------------------------------------------------------------------ */

  function fixedStep(dt, input) {
    const next = input.nextSwing;

    if (phase === 'freefall') {
      // Fire early enough that the web LANDS on the beat rather than starting
      // to travel on it.
      // Fire on the NEXT BEAT, not on a sparse swing point.
      //
      // Swing points sit ~4.5s apart at the shipping density, which suited the
      // old model but is fatal here: under full gravity he falls roughly
      // 24,000 units in that gap. Measured, it put him 1500 below the anchor
      // with the arc entirely off-screen. The cycle is fall-swing-release and
      // it is short, so it wants a beat-level cadence. Firing on whichever
      // beat arrives next also makes the rhythm self-pacing — he re-locks to
      // the music every cycle instead of drifting between distant checkpoints.
      // Fire on the next beat AFTER a real fall has happened.
      //
      // Firing on every beat was an overcorrection: at 95 BPM that is every
      // 0.63s, so he never fell, never built speed, covered almost no ground,
      // and — the knock-on that matters — never dropped into the roof band, so
      // no building ever qualified as an anchor and every web went to empty
      // sky. Requiring a minimum freefall restores the airtime AND puts him
      // back among the buildings. Still beat-locked, just not every beat.
      // Commit the target ahead of the fire beat — but only once he is past
      // the apex and descending.
      //
      // Freefall STARTS with an upward launch, so committing on a timer alone
      // picks a roof that clears him now and may not clear him at the fire
      // beat, because he is still rising toward it. Measured: 6 of 17 swings
      // re-picked at the last moment, which moves the target the ring has
      // spent four beats pointing at — the count-in becomes a lie exactly when
      // someone is watching it most closely.
      //
      // After the apex his altitude only decreases, so any roof above him now
      // is still above him at the fire beat. The commit is then correct by
      // construction rather than by margin, which is why this is a phase test
      // and not a bigger clearance number.
      if (
        !plannedAnchor &&
        vel.y >= 0 &&
        freefallTime >= cfg.minFreefallTime * cfg.anchorCommitAt
      ) {
        plannedAnchor = chooseAnchor(cfg.commitClearance);
      }

      if (input.beatPulse && freefallTime >= cfg.minFreefallTime) {
        currentSwing = next ?? null;
        // Re-validate: he has been falling since the commit, so a target that
        // was above him then may not be now. A sideways rope carries no weight
        // and produced the runaway descent documented in chooseAnchor.
        const t = plannedAnchor && plannedAnchor.y < hip.y - 40 ? plannedAnchor : chooseAnchor();
        plannedAnchor = null;
        fireAt(t);
      }

      // Stop promising once the fall is deep enough that emergency recovery
      // is plausible. See cfg.ringAbandonAt — this is what keeps the count-in
      // honest, and it has to happen BEFORE the emergency fire, not at it.
      if (plannedAnchor && hip.y > cfg.cruiseY + cfg.emergencyDrop * cfg.ringAbandonAt) {
        plannedAnchor = null;
      }

      // Emergency recovery — see emergencyDrop.
      if (phase === 'freefall' && hip.y > cfg.cruiseY + cfg.emergencyDrop) {
        // Prefer the roof already committed to, when it is still usable. The
        // emergency is about altitude, not about the target being wrong, so
        // re-picking here threw away a perfectly good anchor and — before
        // ringAbandonAt above — moved the web away from the ring.
        const t = plannedAnchor && plannedAnchor.y < hip.y - 40 ? plannedAnchor : chooseAnchor();
        plannedAnchor = null;
        fireAt(t);
      }
    }

    if (phase === 'freefall') stepFreefall(dt);
    else if (phase === 'fire') stepFire(dt);
    else if (phase === 'swing') stepSwing(dt);
  }

  const pose = {
    anchor,
    /** Where the NEXT web will attach, or null. Renderer-facing: this is what
     *  lets the target be telegraphed before it is used. */
    nextAnchor: null,
    hip,
    webTip,
    velocity: vel,
    theta: 0,
    omega: 0,
    webLength: 0,
    phase,
    webProgress: 0,
    joints: skeleton.joints,
  };

  function syncPose() {
    pose.theta = Math.atan2(hip.x - anchor.x, hip.y - anchor.y);
    pose.omega = 0;
    pose.webLength = attached || phase === 'fire' ? Math.hypot(hip.x - anchor.x, hip.y - anchor.y) : 0;
    pose.phase = phase;
    pose.webProgress = phase === 'fire' ? 0.5 : attached ? 1 : 0;
    pose.nextAnchor = phase === 'freefall' ? plannedAnchor : null;
  }

  return {
    config: cfg,

    update(dt, input = {}) {
      if (Number.isFinite(input.now)) clock = input.now;
      if (Number.isFinite(input.energy)) energy = clamp(input.energy, 0, 1);

      accumulator.run(dt, (h) => fixedStep(h, input));

      // The arm tracks the travelling web tip during `fire` and the anchor
      // once attached, so the shot reads rather than snapping to its target.
      const aim = phase === 'fire' ? webTip : anchor;
      const roped = attached || phase === 'fire';
      const ax = aim.x - hip.x;
      const ay = aim.y - hip.y;
      const alen = Math.hypot(ax, ay) || 1;
      const speed = Math.hypot(vel.x, vel.y) || 1;
      const up = roped
        ? { x: ax / alen, y: ay / alen }
        : { x: vel.x / speed, y: -Math.abs(vel.y / speed) };

      skeleton.solve({ hip, anchor: aim, vel, up, attached: roped }, clamp(dt, 1e-4, 0.1));
      syncPose();
    },

    get pose() {
      return pose;
    },

    pulse() {
      if (phase === 'freefall') fireAt(chooseAnchor());
    },

    setBeatInterval() {},

    reset(x = cfg.startX, y = cfg.startY) {
      hip.x = x;
      hip.y = y;
      vel.x = cfg.cruiseSpeedX;
      vel.y = 0;
      phase = 'freefall';
      attached = false;
      currentSwing = null;
      swingTime = 0;
      accumulator.reset();
      skeleton.reset();
      syncPose();
    },
  };
}
