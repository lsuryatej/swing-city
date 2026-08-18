/**
 * Simulation tests. Headless — nothing here touches a canvas.
 *
 * The second block (sign-locked impulse) is the important one. The whole
 * design rests on that invariant holding for every phase/tempo combination,
 * so it is tested exhaustively rather than by example.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Pendulum,
  FIXED_DT,
  MAX_FRAME_DT,
  createAccumulator,
  signLockedImpulse,
  stepSemiImplicit,
  energy,
  naturalPeriod,
  lengthForPeriod,
  pendulumAccel,
  softWallAccel,
  speedGovernorAccel,
  MAX_THETA,
  HARD_LIMIT_SLACK,
} from '../src/sim/pendulum.js';

import {
  solveLaunchVelocity,
  predictBallistic,
  solveLaunchSpeed,
  anchorForCatch,
  MAX_CATCH_THETA,
  MIN_LEAD_THETA,
  chooseWebLength,
} from '../src/sim/choreo.js';

import { createSwinger } from '../src/sim/index.js';
import { JOINT_NAMES } from '../src/sim/skeleton.js';
import { GRAVITY } from '../src/contract.js';

/* ------------------------------------------------------------------ *
 * Deterministic PRNG so failures are reproducible.                    *
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================== *
 * 1. Energy conservation                                              *
 * ================================================================== */

test('pendulum conserves energy within a few percent over 10s (damping off)', () => {
  // The soft amplitude barrier is deliberately dissipative, so it is disabled
  // here: this test is about the integrator, not about the wall.
  for (const theta0 of [0.2, 0.6, 1.0, 1.4]) {
    const p = new Pendulum({
      theta: theta0,
      omega: 0,
      length: 320,
      gravity: GRAVITY,
      damping: 0,
      maxTheta: Infinity,
    });
    const e0 = p.energy;
    let minE = e0;
    let maxE = e0;

    const steps = Math.round(10 / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      p.stepFixed(FIXED_DT);
      const e = p.energy;
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
    }

    const drift = Math.abs(p.energy - e0) / e0;
    const band = (maxE - minE) / e0;
    assert.ok(
      drift < 0.03,
      `theta0=${theta0}: energy drifted ${(drift * 100).toFixed(3)}% over 10s`
    );
    assert.ok(
      band < 0.03,
      `theta0=${theta0}: energy band ${(band * 100).toFixed(3)}% exceeds 3%`
    );
  }
});

test('damping strictly removes energy; zero damping does not', () => {
  const mk = (damping) =>
    new Pendulum({
      theta: 1.0,
      omega: 0,
      length: 320,
      gravity: GRAVITY,
      damping,
      maxTheta: Infinity,
    });
  const damped = mk(0.5);
  const free = mk(0);
  const e0 = damped.energy;
  for (let i = 0; i < 240 * 4; i++) {
    damped.stepFixed(FIXED_DT);
    free.stepFixed(FIXED_DT);
  }
  assert.ok(damped.energy < e0 * 0.5, 'damped pendulum should have lost most of its energy');
  assert.ok(free.energy > e0 * 0.97, 'undamped pendulum should have kept its energy');
});

test('amplitude is clamped so the bob never goes over the bar', () => {
  // Heavy but physically meaningful forcing: a 0.5 rad/s impulse at 20 Hz is
  // already ten times what the loudest track delivers. The soft wall must hold
  // the arc here, not merely avoid catastrophe.
  // Dissipation matching SWINGER_DEFAULTS: the amplitude limit is a property
  // of the configured system, not of the bare wall in isolation.
  const p = new Pendulum({
    theta: 0, omega: 0, length: 300, gravity: GRAVITY,
    damping: 0.5, quadDrag: 0.05,
  });
  let peak = 0;
  for (let i = 0; i < 4000; i++) {
    if (i % 12 === 0) p.pulse(0.5);
    p.stepFixed(FIXED_DT);
    peak = Math.max(peak, Math.abs(p.theta));
    assert.ok(Number.isFinite(p.omega), 'omega went non-finite under sustained impulse');
  }
  assert.ok(
    peak < MAX_THETA + 0.08,
    `soft wall bowed too far under heavy forcing: ${peak.toFixed(3)}`
  );

  // Now something absurd — an impulse EVERY sub-step, ~120 rad/s^2 of
  // injection, far beyond what the wall is sized to resist. The soft wall
  // loses this fight by design; the hard backstop is what must not fail.
  const q = new Pendulum({ theta: 0, omega: 0, length: 300, gravity: GRAVITY, damping: 0 });
  for (let i = 0; i < 4000; i++) {
    q.pulse(0.5);
    q.stepFixed(FIXED_DT);
    assert.ok(
      Math.abs(q.theta) <= MAX_THETA + HARD_LIMIT_SLACK + 1e-9,
      `theta escaped the hard clamp: ${q.theta}`
    );
    assert.ok(Number.isFinite(q.omega), 'omega went non-finite under saturation');
  }
});

/* ================================================================== *
 * 2. The sign-locked impulse invariant                                *
 * ================================================================== */

test('sign-locked impulse NEVER decreases |omega| — exhaustive random sweep', () => {
  const rnd = mulberry32(0xc0ffee);
  for (let i = 0; i < 200000; i++) {
    const theta = (rnd() - 0.5) * 4; // beyond the clamp on purpose
    const omega = (rnd() - 0.5) * 20;
    const impulse = rnd() * 2;
    const out = signLockedImpulse(theta, omega, impulse);
    assert.ok(Number.isFinite(out), `non-finite result at i=${i}`);
    assert.ok(
      Math.abs(out) >= Math.abs(omega) - 1e-12,
      `|omega| DECREASED: theta=${theta} omega=${omega} impulse=${impulse} -> ${out}`
    );
  }
});

test('sign-locked impulse handles the degenerate cases', () => {
  // Dead centre, dead still: any direction is legal, but it must move.
  assert.equal(signLockedImpulse(0, 0, 0.4), 0.4);
  // At rest at an extreme: push toward the bottom of the arc, not away.
  assert.ok(signLockedImpulse(1.2, 0, 0.4) < 0, 'positive theta at rest should push negative');
  assert.ok(signLockedImpulse(-1.2, 0, 0.4) > 0, 'negative theta at rest should push positive');
  // Negative impulse arguments are treated as magnitudes; the invariant holds.
  assert.equal(signLockedImpulse(0, 2, -0.5), 2.5);
  assert.equal(signLockedImpulse(0, -2, -0.5), -2.5);
});

test('sign-locked impulse adds energy at every phase and every tempo', () => {
  // The failure mode this design exists to prevent: a naive fixed-direction
  // impulse cancels the swing on roughly half of all beats. Assert that the
  // sign-locked version never does, across a grid of tempos and phases.
  const rnd = mulberry32(7);
  const L = 300;
  let naiveRegressions = 0;

  for (let trial = 0; trial < 400; trial++) {
    const bpm = 60 + rnd() * 140;
    const beat = 60 / bpm;
    const p = new Pendulum({ theta: 0.4, omega: 1.5, length: L, gravity: GRAVITY, damping: 0 });
    const naive = new Pendulum({
      theta: 0.4,
      omega: 1.5,
      length: L,
      gravity: GRAVITY,
      damping: 0,
    });

    let acc = 0;
    const steps = Math.round(8 / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      acc += FIXED_DT;
      if (acc >= beat) {
        acc -= beat;
        const before = Math.abs(p.omega);
        p.pulse(0.3);
        assert.ok(
          Math.abs(p.omega) >= before - 1e-12,
          `sign-locked beat reduced |omega| at bpm=${bpm}`
        );
        const nBefore = Math.abs(naive.omega);
        naive.omega += 0.3; // the naive, fixed-direction version
        if (Math.abs(naive.omega) < nBefore - 1e-9) naiveRegressions++;
      }
      p.stepFixed(FIXED_DT);
      naive.stepFixed(FIXED_DT);
    }
  }

  // Sanity: the naive version really does fight itself, which is what makes
  // the sign lock worth having rather than a no-op.
  assert.ok(
    naiveRegressions > 100,
    `expected the naive impulse to cancel the swing often; saw ${naiveRegressions}`
  );
});

/* ================================================================== *
 * 3. Fixed-timestep integration under erratic frame deltas            *
 * ================================================================== */

test('accumulator runs a whole number of fixed steps and carries the remainder', () => {
  const acc = createAccumulator(FIXED_DT);
  let count = 0;
  const total = 1.0;
  let fed = 0;
  const rnd = mulberry32(99);
  while (fed < total) {
    const dt = Math.min(0.001 + rnd() * 0.03, total - fed);
    fed += dt;
    acc.run(dt, () => count++);
  }
  const expected = Math.floor(total / FIXED_DT);
  assert.ok(
    Math.abs(count - expected) <= 1,
    `ran ${count} steps for 1s, expected ~${expected}`
  );
});

test('fixed-timestep integration is deterministic for identical delta sequences', () => {
  const rnd = mulberry32(1234);
  const deltas = Array.from({ length: 600 }, () => 0.002 + rnd() * 0.04);

  const run = () => {
    const p = new Pendulum({ theta: 0.9, omega: 0, length: 280, gravity: GRAVITY, damping: 0.4 });
    for (const dt of deltas) p.advance(dt);
    return { theta: p.theta, omega: p.omega };
  };

  const a = run();
  const b = run();
  assert.equal(a.theta, b.theta, 'theta diverged between identical runs');
  assert.equal(a.omega, b.omega, 'omega diverged between identical runs');
});

test('a 500ms frame hitch does not explode the integrator', () => {
  const p = new Pendulum({ theta: 1.2, omega: 2, length: 260, gravity: GRAVITY, damping: 0.3 });
  const deltas = [
    1 / 60, 1 / 60, 1 / 60,
    0.5, // the hitch
    1 / 60, 1 / 60,
    0.5, // and again
    1 / 120, 0.25, 1 / 60, 0.9, 1 / 60,
  ];
  for (const dt of deltas) {
    p.advance(dt);
    assert.ok(Number.isFinite(p.theta), 'theta went non-finite');
    assert.ok(Number.isFinite(p.omega), 'omega went non-finite');
    assert.ok(
      Math.abs(p.theta) <= MAX_THETA + 1e-9,
      `theta escaped clamp after hitch: ${p.theta}`
    );
    // Energy must never exceed what it started with, since damping is on and
    // no impulses are applied. A variable-dt integrator fails this outright.
    assert.ok(p.energy < energy(1.2, 2, 260, GRAVITY) * 1.05, 'hitch injected energy');
  }
});

test('single huge deltas are clamped rather than simulated', () => {
  const acc = createAccumulator(FIXED_DT, MAX_FRAME_DT);
  let n = 0;
  acc.run(30, () => n++); // a 30-second backgrounded tab
  assert.ok(n <= Math.ceil(MAX_FRAME_DT / FIXED_DT), `ran ${n} steps for a 30s delta`);
  // Non-finite and non-positive deltas are rejected outright.
  assert.equal(acc.run(NaN, () => n++), 0);
  assert.equal(acc.run(-1, () => n++), 0);
  assert.equal(acc.run(0, () => n++), 0);
});

/* ================================================================== *
 * 4. Choreographed release / inverse flight solve                     *
 * ================================================================== */

test('solveLaunchVelocity lands exactly on the target at exactly T', () => {
  const rnd = mulberry32(555);
  for (let i = 0; i < 5000; i++) {
    const from = { x: rnd() * 2000, y: 200 + rnd() * 700 };
    const to = { x: from.x + 100 + rnd() * 1400, y: 200 + rnd() * 700 };
    const T = 0.3 + rnd() * 2.2;
    const v = solveLaunchVelocity(from, to, T, GRAVITY);
    const landed = predictBallistic(from, v, T, GRAVITY);
    assert.ok(Math.abs(landed.x - to.x) < 1e-6, `x miss ${landed.x - to.x}`);
    assert.ok(Math.abs(landed.y - to.y) < 1e-6, `y miss ${landed.y - to.y}`);
  }
});

test('arrival time is within 30ms of the target across a spread of flight times', () => {
  // Bisect on time to find when the parabola actually reaches the target
  // altitude, and confirm it is the requested T.
  const rnd = mulberry32(4242);
  for (let i = 0; i < 400; i++) {
    const from = { x: 0, y: 300 + rnd() * 500 };
    const to = { x: 400 + rnd() * 1200, y: 300 + rnd() * 500 };
    const T = 0.35 + rnd() * 2.0;
    const v = solveLaunchVelocity(from, to, T, GRAVITY);

    // Find the arrival time by scanning at 1ms resolution for closest approach.
    let bestT = 0;
    let bestD = Infinity;
    for (let ms = 0; ms <= Math.ceil(T * 1000) + 200; ms++) {
      const t = ms / 1000;
      const p = predictBallistic(from, v, t, GRAVITY);
      const d = Math.hypot(p.x - to.x, p.y - to.y);
      if (d < bestD) {
        bestD = d;
        bestT = t;
      }
    }
    assert.ok(
      Math.abs(bestT - T) <= 0.03,
      `arrival ${bestT.toFixed(3)}s vs target ${T.toFixed(3)}s`
    );
  }
});

test('constrained speed solve hits the requested axis for a fixed launch direction', () => {
  const rnd = mulberry32(8181);
  let solved = 0;
  for (let i = 0; i < 3000; i++) {
    const from = { x: 0, y: 700 };
    const ang = -(0.15 + rnd() * 1.1); // up-and-forward
    const dir = { x: Math.cos(ang), y: Math.sin(ang) };
    const T = 0.4 + rnd() * 1.4;
    const target = { x: from.x + 300 + rnd() * 900, y: 400 + rnd() * 400 };
    const r = solveLaunchSpeed(from, dir, T, GRAVITY, target, {
      minSpeed: 0,
      maxSpeed: 1e9,
    });
    if (!r.conditioned) continue;
    solved++;
    const v = { x: dir.x * r.speed, y: dir.y * r.speed };
    const landed = predictBallistic(from, v, T, GRAVITY);
    const err = r.axis === 'y' ? Math.abs(landed.y - target.y) : Math.abs(landed.x - target.x);
    assert.ok(err < 1e-6, `axis ${r.axis} miss by ${err}`);
  }
  assert.ok(solved > 1000, `expected most cases to be solvable, got ${solved}`);
});

test('the sim reaches its swing point on time', () => {
  const gap = [];
  for (const flight of [0.4, 0.6, 0.9, 1.2, 1.6, 2.0]) {
    const s = createSwinger({ startY: 620 });
    const t0 = 3.0;
    const point = { t: t0, tNext: t0 + flight, strength: 0.9 };
    let now = 0;
    let attachedAt = null;
    let sawFlight = false;
    const dt = 1 / 120;

    while (now < t0 + flight + 1.0) {
      now += dt;
      // Keep offering the swing point until it has actually been consumed,
      // which is how a real caller walks a BeatMap's swingPoints array.
      const next = sawFlight ? null : point;
      s.update(dt, { now, energy: 0.2, nextSwing: next, beatPulse: false });
      if (s.pose.phase === 'flight') sawFlight = true;
      if (sawFlight && attachedAt === null && s.pose.phase !== 'flight') attachedAt = now;
    }

    assert.ok(sawFlight, `flight=${flight}: never released`);
    assert.ok(attachedAt !== null, `flight=${flight}: never re-attached`);
    const err = Math.abs(attachedAt - point.tNext);
    gap.push(err);
    assert.ok(
      err <= 0.03,
      `flight=${flight}: attached at ${attachedAt.toFixed(4)} vs tNext ${point.tNext} (off by ${(err * 1000).toFixed(1)}ms)`
    );
  }
});

test('chooseWebLength picks a length whose period is a musical subdivision', () => {
  for (const bpm of [60, 90, 100, 120, 128, 140, 174, 200]) {
    const beat = 60 / bpm;
    const L = chooseWebLength(beat, GRAVITY, {
      minLength: 180,
      maxLength: 620,
      preferred: 360,
    });
    assert.ok(L >= 180 && L <= 620, `bpm ${bpm}: length ${L} out of range`);
    const period = naturalPeriod(L, GRAVITY);
    const ratio = period / beat;
    const nearest = [1, 1.5, 2, 3, 4].reduce(
      (best, s) => (Math.abs(s - ratio) < Math.abs(best - ratio) ? s : best),
      1
    );
    assert.ok(
      Math.abs(ratio - nearest) < 0.02 || L === 180 || L === 620,
      `bpm ${bpm}: period/beat = ${ratio.toFixed(3)}, not near a subdivision`
    );
  }
});

test('lengthForPeriod and naturalPeriod are inverses', () => {
  for (const T of [0.5, 0.75, 1, 1.5, 2, 3]) {
    const L = lengthForPeriod(T, GRAVITY);
    assert.ok(Math.abs(naturalPeriod(L, GRAVITY) - T) < 1e-9);
  }
});

/* ================================================================== *
 * 5. Catch continuity                                                 *
 * ================================================================== */

/**
 * This replaces an earlier test asserting the rope is perpendicular to travel
 * for EVERY incoming velocity. That invariant is what caused the runaway
 * descent: anchor.y = hip.y - (|vx|/|v|)*L, so on a steep fall the
 * "perpendicular" anchor sits level with the character, the rope carries no
 * weight, and altitude ratchets downward every cycle.
 *
 * Perpendicularity is still asserted, but only where it is correct — when the
 * overhead clamp does not bind.
 */
test('anchorForCatch: rope geometry, overhead guarantee, and no energy gain', () => {
  const rnd = mulberry32(31337);
  for (let i = 0; i < 20000; i++) {
    const hip = { x: (rnd() - 0.5) * 4000, y: rnd() * 900 };
    const vel = { x: (rnd() - 0.2) * 1400, y: (rnd() - 0.5) * 1600 };
    const L = 180 + rnd() * 440;
    const sol = anchorForCatch(hip, vel, L);

    const rx = hip.x - sol.anchor.x;
    const ry = hip.y - sol.anchor.y;
    const rlen = Math.hypot(rx, ry);

    // 1. The rope is always exactly its own length.
    assert.ok(Math.abs(rlen - L) < 1e-6, `rope length wrong: ${rlen} vs ${L}`);

    // 2. THE LOAD-BEARING ONE: the anchor is always meaningfully overhead.
    //    cos(MAX_CATCH_THETA) = 0.5, so it clears the hip by half a rope
    //    length even on the steepest approach.
    const clearance = hip.y - sol.anchor.y;
    assert.ok(
      clearance >= L * Math.cos(MAX_CATCH_THETA) - 1e-6,
      `anchor only ${clearance.toFixed(1)} above hip on a ${L.toFixed(0)} rope`
    );

    // 3. The catch never ADDS energy. It may remove radial velocity, which a
    //    rope physically cannot carry, but speed can only drop.
    const speed = Math.hypot(vel.x, vel.y);
    assert.ok(
      Math.abs(sol.omega) * L <= speed + 1e-6,
      `catch gained speed: ${Math.abs(sol.omega) * L} > ${speed}`
    );

    // 4. Where no constraint altered the angle, the original guarantee holds
    //    exactly: perpendicular rope, zero radial loss, velocity reproduced.
    //
    //    Three things can alter it — the maxTheta cap, the minLead floor, and
    //    the lead-direction flip (the perpendicular anchor falls BEHIND a
    //    rising character, and an anchor behind you produces no travel). Rather
    //    than infer which bound, compare against the unmodified angle directly.
    const dir = vel.x >= 0 ? 1 : -1;
    const natural = Math.atan2((-vel.y / speed) * dir, (vel.x / speed) * dir);
    if (Math.abs(sol.theta - natural) < 1e-9) {
      const dot = (rx / rlen) * vel.x + (ry / rlen) * vel.y;
      assert.ok(Math.abs(dot) < 1e-6, `radial component ${dot} should be zero`);
      const vx = sol.omega * L * Math.cos(sol.theta);
      const vy = -sol.omega * L * Math.sin(sol.theta);
      assert.ok(Math.abs(vx - vel.x) < 1e-6, `vx mismatch ${vx} vs ${vel.x}`);
      assert.ok(Math.abs(vy - vel.y) < 1e-6, `vy mismatch ${vy} vs ${vel.y}`);
    }
  }
});

/** The bug this change exists to prevent, asserted directly. */
test('anchorForCatch: a steep fall still gets an anchor overhead', () => {
  const sol = anchorForCatch({ x: 0, y: 5000 }, { x: 40, y: 1800 }, 243);
  const clearance = 5000 - sol.anchor.y;
  assert.ok(clearance > 100, `anchor only ${clearance.toFixed(1)} above on a 243 rope`);
});

/** Altitude regulation must pull the catch upright when below cruise. */
test('anchorForCatch: being below cruise height straightens the catch', () => {
  const vel = { x: 700, y: 400 };
  const atCruise = anchorForCatch({ x: 0, y: 620 }, vel, 300, { cruiseY: 620 });
  const wayBelow = anchorForCatch({ x: 0, y: 2200 }, vel, 300, { cruiseY: 620 });
  assert.ok(
    Math.abs(wayBelow.theta) < Math.abs(atCruise.theta),
    `expected a more upright catch when low: ${wayBelow.theta} vs ${atCruise.theta}`
  );
});

test('phase transitions preserve position and velocity — no pop', () => {
  const s = createSwinger({ startY: 620 });
  const dt = 1 / 120;
  let now = 0;
  let prevPhase = s.pose.phase;
  let prev = {
    x: s.pose.hip.x,
    y: s.pose.hip.y,
    vx: s.pose.velocity.x,
    vy: s.pose.velocity.y,
    L: s.pose.webLength,
    th: s.pose.theta,
    om: s.pose.omega,
  };
  let transitions = 0;
  let peakOmega = 0;
  const omegaTrace = [];

  // Feed a steady stream of swing points so both seams are exercised many times.
  let t = 1.2;
  let point = { t, tNext: t + 0.9, strength: 0.8 };

  for (let i = 0; i < 120 * 60; i++) {
    now += dt;
    if (point && now > point.tNext + 0.25) {
      t = point.tNext + 0.7;
      point = { t, tNext: t + 0.7 + (i % 5) * 0.12, strength: 0.8 };
    }
    const next = point && now < point.t ? point : null;
    s.update(dt, { now, energy: 0.3, nextSwing: next, beatPulse: i % 60 === 0 });

    const p = s.pose;
    if (p.phase !== prevPhase) {
      transitions++;
      const speed = Math.hypot(prev.vx, prev.vy);
      // Position may move by at most one frame of travel, generously bounded.
      const moved = Math.hypot(p.hip.x - prev.x, p.hip.y - prev.y);
      assert.ok(
        moved <= speed * dt * 3 + 1,
        `${prevPhase}->${p.phase}: position jumped ${moved.toFixed(2)} units ` +
          `(one frame of travel is ${(speed * dt).toFixed(2)})`
      );
      // Velocity may change by at most one frame's worth of the accelerations
      // actually acting on the body. On the rope that is gravity PLUS the
      // centripetal term v^2/L, which at a fast swing dwarfs gravity — a
      // velocity vector rotating along the arc is not a discontinuity. Plus a
      // little slack for the web-yank ramp, which is deliberately non-zero
      // approaching release.
      const dv = Math.hypot(p.velocity.x - prev.vx, p.velocity.y - prev.vy);
      const onRope = prevPhase !== 'flight';
      const centripetal = onRope ? (speed * speed) / prev.L : 0;
      // The soft amplitude barrier is part of the model, so it belongs in the
      // bound. Continuity means "no acceleration was infinite", not "no force
      // other than gravity existed".
      // Every term the integrator actually applies belongs in the bound: the
      // soft amplitude wall and the speed governor are part of the model, not
      // discontinuities. Continuity means no acceleration was infinite.
      // The frame straddles the transition, so the accelerations acting during
      // it are whichever are largest on either side of the seam.
      const cfg = s.config;
      const ropeAccel = (st, phase) => {
        if (phase === 'flight') return 0;
        return (
          Math.abs(softWallAccel(st.th, st.om, MAX_THETA)) * st.L +
          Math.abs(speedGovernorAccel(st.om, cfg.omegaMax, cfg.governorGain)) * st.L
        );
      };
      const now = { th: p.theta, om: p.omega, L: p.webLength };
      const extra = Math.max(ropeAccel(prev, prevPhase), ropeAccel(now, p.phase));

      // A rope going taut annihilates the RADIAL component of the incoming
      // velocity. That is a real physical discontinuity, not a bug — it is the
      // snap you feel on a real line — so at the catch seam the radial
      // component is an allowed change.
      //
      // anchorForCatch keeps this small by choosing the anchor perpendicular
      // to travel wherever it can. It is only non-zero when the overhead clamp
      // binds, i.e. on a steep approach, which is exactly the case where the
      // alternative was an anchor level with the character and a runaway
      // descent. Bounding it rather than forbidding it is the correct
      // invariant.
      let catchLoss = 0;
      if (prevPhase === 'flight' && p.phase !== 'flight') {
        const nx = Math.sin(p.theta);
        const ny = Math.cos(p.theta);
        catchLoss = Math.abs(prev.vx * nx + prev.vy * ny);
      }

      const bound =
        (GRAVITY + centripetal + extra) * dt * 3 + speed * 0.06 + 1 + catchLoss;
      assert.ok(
        dv <= bound,
        `${prevPhase}->${p.phase}: velocity jumped ${dv.toFixed(2)} units/s ` +
          `(physically explicable bound was ${bound.toFixed(2)})`
      );
    }
    peakOmega = Math.max(peakOmega, Math.abs(p.omega));
    omegaTrace.push(Math.abs(p.omega));
    prevPhase = p.phase;
    prev = {
      x: p.hip.x, y: p.hip.y,
      vx: p.velocity.x, vy: p.velocity.y,
      L: p.webLength, th: p.theta, om: p.omega,
    };
  }

  assert.ok(transitions > 40, `expected many phase transitions, saw ${transitions}`);

  // The property that matters is that the swing does not COMPOUND. A single
  // fast catch is legitimate — the catch preserves the incoming velocity by
  // design, so the instantaneous peak is set by the flight, not by the rope.
  // What must not happen is that peak creeping up lap after lap.
  const third = Math.floor(omegaTrace.length / 3);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const early = mean(omegaTrace.slice(0, third));
  const late = mean(omegaTrace.slice(-third));
  assert.ok(
    late < early * 1.35 + 0.5,
    `angular speed compounded: first third mean ${early.toFixed(2)}, ` +
      `last third mean ${late.toFixed(2)} rad/s`
  );
  assert.ok(peakOmega < 14, `angular speed ran away to ${peakOmega.toFixed(2)} rad/s`);
});

test('the quadratic governor bounds angular speed under sustained impulses', () => {
  const s = createSwinger();
  let now = 0;
  let peak = 0;
  // Every single frame is a full-strength beat: far more energy than any real
  // track delivers.
  for (let i = 0; i < 60 * 120; i++) {
    now += 1 / 60;
    s.update(1 / 60, { now, energy: 1, nextSwing: null, beatPulse: true, beatStrength: 1 });
    peak = Math.max(peak, Math.abs(s.pose.omega));
  }
  assert.ok(Number.isFinite(peak), 'omega went non-finite under saturation');
  assert.ok(peak < 14, `governor failed to bound omega: peaked at ${peak.toFixed(2)} rad/s`);
});

/* ================================================================== *
 * 6. Whole-sim robustness                                             *
 * ================================================================== */

test('no NaN in any joint across a long randomised run', () => {
  const rnd = mulberry32(2024);
  const s = createSwinger();
  let now = 0;
  let point = null;
  let checks = 0;

  for (let i = 0; i < 40000; i++) {
    // Deliberately hostile frame pacing, including hitches and micro-frames.
    let dt = 0.004 + rnd() * 0.02;
    if (rnd() < 0.004) dt = 0.5;
    if (rnd() < 0.01) dt = 0.0005;
    now += dt;

    if (!point || now > point.tNext + 0.3) {
      const t = now + 0.3 + rnd() * 1.2;
      point = { t, tNext: t + 0.4 + rnd() * 1.8, strength: rnd() };
    }
    const next = rnd() < 0.9 && now < point.t ? point : null;

    s.update(dt, {
      now,
      energy: rnd(),
      nextSwing: next,
      beatPulse: rnd() < 0.08,
      beatStrength: rnd(),
    });

    const p = s.pose;
    for (const name of JOINT_NAMES) {
      const j = p.joints[name];
      assert.ok(j, `joint ${name} missing from the pose`);
      assert.ok(Number.isFinite(j.x) && Number.isFinite(j.y), `joint ${name} went NaN at i=${i}`);
      checks++;
    }
    assert.ok(Number.isFinite(p.theta) && Number.isFinite(p.omega), `theta/omega NaN at i=${i}`);
    assert.ok(Number.isFinite(p.hip.x) && Number.isFinite(p.hip.y), `hip NaN at i=${i}`);
    assert.ok(
      Number.isFinite(p.anchor.x) && Number.isFinite(p.anchor.y),
      `anchor NaN at i=${i}`
    );
    assert.ok(p.webLength > 0, `web length collapsed at i=${i}`);
    assert.ok(['swing', 'flight', 'anchor'].includes(p.phase), `bad phase ${p.phase}`);
  }
  assert.ok(checks > 500000);
});

test('the pose exposes exactly the 13 contract joints', () => {
  const s = createSwinger();
  s.update(1 / 60, { now: 0, energy: 0, nextSwing: null, beatPulse: false });
  const keys = Object.keys(s.pose.joints).sort();
  const expected = [
    'elbowL', 'elbowR', 'footL', 'footR', 'handL', 'handR', 'head',
    'hipC', 'kneeL', 'kneeR', 'neck', 'shoulderL', 'shoulderR',
  ].sort();
  assert.deepEqual(keys, expected);
});

test('the web arm stays on the web line while attached', () => {
  const s = createSwinger();
  let now = 0;
  for (let i = 0; i < 900; i++) {
    now += 1 / 60;
    s.update(1 / 60, { now, energy: 0.4, nextSwing: null, beatPulse: i % 30 === 0 });
    const p = s.pose;
    if (p.phase === 'flight') continue;
    const { shoulderR, handR } = p.joints;
    // shoulder -> hand must be parallel to shoulder -> anchor.
    const ax = p.anchor.x - shoulderR.x;
    const ay = p.anchor.y - shoulderR.y;
    const hx = handR.x - shoulderR.x;
    const hy = handR.y - shoulderR.y;
    const cross = ax * hy - ay * hx;
    const norm = Math.hypot(ax, ay) * Math.hypot(hx, hy);
    assert.ok(
      norm === 0 || Math.abs(cross) / norm < 1e-6,
      `web arm drifted off the web line at i=${i}`
    );
  }
});

test('reactive mode keeps swinging forever without a beat map', () => {
  const s = createSwinger();
  let now = 0;
  let phases = new Set();
  for (let i = 0; i < 60 * 60; i++) {
    now += 1 / 60;
    s.update(1 / 60, { now, energy: 0.5, nextSwing: null, beatPulse: i % 30 === 0 });
    phases.add(s.pose.phase);
    assert.ok(Number.isFinite(s.pose.hip.x));
  }
  assert.ok(phases.has('flight'), 'reactive mode never released');
  assert.ok(phases.has('swing'), 'reactive mode never swung');
  assert.ok(s.pose.hip.x > 1000, 'reactive mode made no forward progress');
});

test('pendulumAccel matches the documented equation', () => {
  const g = 2400;
  const L = 300;
  const d = 0.5;
  for (const [th, om] of [[0, 0], [0.5, 1], [-1.2, -2], [1.5, 0.3]]) {
    const expected = -(g / L) * Math.sin(th) - d * om;
    assert.ok(Math.abs(pendulumAccel(th, om, L, g, d) - expected) < 1e-12);
  }
});

test('stepSemiImplicit updates velocity before position (symplectic ordering)', () => {
  const s = { theta: 0.5, omega: 0 };
  const h = 0.01;
  const a = pendulumAccel(0.5, 0, 300, 2400, 0);
  stepSemiImplicit(s, h, 300, 2400, 0);
  const expectedOmega = a * h;
  assert.ok(Math.abs(s.omega - expectedOmega) < 1e-12);
  // Position uses the NEW velocity, not the old one.
  assert.ok(Math.abs(s.theta - (0.5 + expectedOmega * h)) < 1e-12);
});
