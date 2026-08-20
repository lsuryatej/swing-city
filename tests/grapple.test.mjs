/**
 * Grapple tests — the SHIPPING swing model.
 *
 * NB: tests/sim.test.mjs exercises src/sim/index.js, which is the earlier
 * pendulum swinger and is what the sandbox still drives. The site runs
 * src/sim/grapple.js. They are different models with different phase names
 * ('flight' vs 'freefall'), so a green sandbox proves nothing about this file.
 *
 * Headless: nothing here touches a canvas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwinger, SWING_DEFAULTS } from '../src/sim/grapple.js';
import { WORLD_HEIGHT } from '../src/contract.js';

/** A skyline of roofs, so anchor selection takes the real path rather than
 *  the empty-sky fallback. */
function buildings() {
  const roofs = [];
  for (let x = -2000; x < 40000; x += 260) {
    roofs.push({ x, y: 300 + ((x / 260) % 5) * 40 });
  }
  return (fromX, minAhead, maxAhead) =>
    roofs.filter((b) => b.x > fromX + minAhead && b.x < fromX + maxAhead);
}

/** Drive the sim at a fixed tempo, collecting a sample per frame. */
function run(seconds, bpm, sample) {
  const s = createSwinger({ buildingsAheadOf: buildings() });
  const dt = 1 / 60;
  const beat = 60 / bpm;
  let now = 0;
  let nextBeat = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    now += dt;
    const beatPulse = now >= nextBeat;
    if (beatPulse) nextBeat += beat;
    s.update(dt, { now, energy: 0.5, nextSwing: null, beatPulse });
    sample(s.pose, now, beatPulse);
  }
}

test('the next anchor is committed before the web is fired', () => {
  let sawTelegraph = false;
  run(24, 120, (pose) => {
    if (pose.phase === 'freefall' && pose.nextAnchor) sawTelegraph = true;
  });
  assert.ok(
    sawTelegraph,
    'pose.nextAnchor was never populated during freefall, so the renderer has ' +
      'nothing to telegraph and the count-in cannot draw'
  );
});

test('a visible count-in ring is never contradicted by the web', () => {
  // THE INVARIANT IS WHAT A VIEWER SEES, not what the code happens to do.
  //
  // The first version of this test excluded emergency fires, on the reasoning
  // that emergency recovery legitimately abandons the plan. That reasoning is
  // fine and the test passed — while 61-78% of count-ins at low energy were
  // pointing at one roof as the web left for another, because the abandonment
  // happened on the SAME FRAME as the fire. The test asserted the invariant
  // the implementation had rather than the one the feature exists to provide.
  //
  // So: track the ring's live state including its withdrawal, and assert that
  // whenever a ring was on screen going into a fire, the web went there. No
  // exclusions. If the sim needs to bail out it must drop the ring first.
  const cases = [
    [95, 0.15], [95, 0.85],
    [120, 0.15], [120, 0.85],
    [140, 0.15], [140, 0.85],
  ];

  for (const [bpm, energy] of cases) {
    const s = createSwinger({ buildingsAheadOf: buildings() });
    const dt = 1 / 60;
    const beat = 60 / bpm;
    let now = 0;
    let nextBeat = 0;
    let prevPhase = 'freefall';
    let ring = null;
    let shown = 0;
    let broken = 0;

    for (let i = 0; i < 40 * 60; i++) {
      now += dt;
      const beatPulse = now >= nextBeat;
      if (beatPulse) nextBeat += beat;
      s.update(dt, { now, energy, nextSwing: null, beatPulse });
      const p = s.pose;

      if (p.phase === 'freefall') {
        ring = p.nextAnchor ? { x: p.nextAnchor.x, y: p.nextAnchor.y } : null;
      }
      if (p.phase === 'fire' && prevPhase === 'freefall') {
        if (ring) {
          shown++;
          if (p.anchor.x !== ring.x || p.anchor.y !== ring.y) broken++;
        }
        ring = null;
      }
      prevPhase = p.phase;
    }

    assert.equal(
      broken,
      0,
      `${bpm} BPM at energy ${energy}: ${broken} of ${shown} count-ins pointed ` +
        'at a roof the web did not go to'
    );
  }
});

test('nextAnchor is cleared once the web is away', () => {
  run(24, 120, (pose) => {
    if (pose.phase !== 'freefall') {
      assert.equal(
        pose.nextAnchor,
        null,
        `nextAnchor leaked into phase "${pose.phase}" — the ring would draw ` +
          'on a target that is already being swung from'
      );
    }
  });
});

test('the commit lands early enough to be a count-in, not a flash', () => {
  // At least a beat of lead time, or there is nothing to count in.
  let leads = [];
  let commitAt = null;
  run(40, 120, (pose, now) => {
    if (pose.phase === 'freefall' && pose.nextAnchor && commitAt === null) commitAt = now;
    if (pose.phase === 'fire' && commitAt !== null) {
      leads.push(now - commitAt);
      commitAt = null;
    }
  });
  assert.ok(leads.length > 2, `expected several cycles, saw ${leads.length}`);
  const worst = Math.min(...leads);
  assert.ok(worst >= 60 / 120, `shortest lead was ${worst.toFixed(2)}s, under one beat`);
});

test('anchorCommitAt is a fraction of the freefall floor', () => {
  assert.ok(SWING_DEFAULTS.anchorCommitAt > 0 && SWING_DEFAULTS.anchorCommitAt < 1);
});

/**
 * Mean peak hip.y (the highest point reached, i.e. the SMALLEST y) per swing
 * cycle, at a fixed BPM and a fixed audio energy held constant for the whole
 * run. A cycle is one fire-to-next-fire span.
 *
 * 40 seconds, not longer: the synthetic skyline in `buildings()` only tiles
 * out to x=40000, and cruiseSpeedX is 640 units/s, so a run past ~62s starts
 * running him off the end of the world and chooseAnchor falls back to the
 * fixed-altitude case for the rest of the run — measured, this silently
 * flattens the energy effect because anchor height stops varying. 40s stays
 * inside the tiled range with headroom.
 */
function meanPeakY(bpm, energy, seconds = 40) {
  const s = createSwinger({ buildingsAheadOf: buildings() });
  const dt = 1 / 60;
  const beat = 60 / bpm;
  let now = 0;
  let nextBeat = 0;
  let sawFireEdge = false;
  let peakY = Infinity;
  const peaks = [];

  for (let i = 0; i < Math.round(seconds / dt); i++) {
    now += dt;
    const beatPulse = now >= nextBeat;
    if (beatPulse) nextBeat += beat;
    s.update(dt, { now, energy, nextSwing: null, beatPulse });
    const p = s.pose;

    if (p.phase === 'fire' && !sawFireEdge) {
      if (peakY !== Infinity) peaks.push(peakY);
      peakY = Infinity;
      sawFireEdge = true;
    } else if (p.phase !== 'fire') {
      sawFireEdge = false;
    }
    peakY = Math.min(peakY, p.hip.y);
  }

  return peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : NaN;
}

test('swing arc height scales with music energy', () => {
  // Locks in the fix documented at the top of chooseWebLength() and
  // ropeReelFloor's doc comment: ropeTarget used to be clamped against a
  // constant (maxRope) that `raw` almost always exceeded, so energy drove the
  // tangential pump but never the rope, and loud/quiet passages produced
  // statistically identical arcs. `arcDrive()` now scales both the rope
  // target and the anchor-band search with energy, so this should visibly
  // differ.
  //
  // Two raw hip.y values don't ratio meaningfully on their own (y=0 is the
  // top of the world, not a physical floor under the swing), so both are
  // converted to "arc height" — WORLD_HEIGHT minus peak y, i.e. height above
  // the bottom of the world. That's the file's own zero: grapple.js's
  // geometry note sizes every anchor/rope number against the ~1080-tall
  // screen.
  //
  // 120 BPM, matching the tempo the rest of this file already tests at.
  // Measured (2026-08-20, this working tree): 470.6 -> 675.3 hi/lo at 95 BPM
  // (1.44x), 449.0 -> 770.0 at 120 BPM (1.72x), 391.5 -> 764.9 at 140 BPM
  // (1.95x). The pre-fix baseline (git HEAD's grapple.js, same measurement)
  // never cleared 1.4x at any of those three tempos (1.36x / 1.22x / 1.20x).
  // 120 BPM is used here because it has the widest margin over baseline of
  // the three, so the threshold below is not brittle.
  const lowY = meanPeakY(120, 0.15);
  const highY = meanPeakY(120, 0.85);
  const lowArc = WORLD_HEIGHT - lowY;
  const highArc = WORLD_HEIGHT - highY;
  const ratio = highArc / lowArc;

  assert.ok(
    ratio >= 1.5,
    `expected a loud passage (energy 0.85) to swing at least 1.5x as high ` +
      `as a quiet one (energy 0.15), measured ${ratio.toFixed(2)}x ` +
      `(lowArc=${lowArc.toFixed(1)}, highArc=${highArc.toFixed(1)})`
  );
});
