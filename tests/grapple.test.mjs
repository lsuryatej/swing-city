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

test('the telegraphed anchor is the one actually used', () => {
  // Emergency recovery is excluded, and that is the point rather than a
  // loophole: when he has fallen past cruise + emergencyDrop the sim fires
  // immediately at whatever it can reach, and it CLEARS plannedAnchor when it
  // does. So the ring vanishes instead of pointing somewhere the web never
  // goes. An abandoned count-in is honest; a redirected one is not.
  const s = createSwinger({ buildingsAheadOf: buildings() });
  const dt = 1 / 60;
  const beat = 0.5;
  let now = 0;
  let nextBeat = 0;
  let telegraphed = null;
  let matched = 0;
  let fired = 0;
  let abandoned = 0;
  for (let i = 0; i < 40 * 60; i++) {
    now += dt;
    const beatPulse = now >= nextBeat;
    if (beatPulse) nextBeat += beat;
    s.update(dt, { now, energy: 0.5, nextSwing: null, beatPulse });
    const p = s.pose;
    if (p.phase === 'freefall' && p.nextAnchor) {
      telegraphed = { x: p.nextAnchor.x, y: p.nextAnchor.y };
    }
    if (p.phase === 'fire' && telegraphed) {
      const emergency = p.hip.y > SWING_DEFAULTS.cruiseY + SWING_DEFAULTS.emergencyDrop;
      if (emergency) {
        abandoned++;
      } else {
        fired++;
        if (p.anchor.x === telegraphed.x && p.anchor.y === telegraphed.y) matched++;
      }
      telegraphed = null;
    }
  }
  assert.ok(fired > 2, `expected several non-emergency fires, saw ${fired}`);
  assert.equal(
    matched,
    fired,
    `telegraphed anchor was honoured only ${matched}/${fired} times ` +
      `(${abandoned} further swings were emergency recoveries, which is fine)`
  );
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
