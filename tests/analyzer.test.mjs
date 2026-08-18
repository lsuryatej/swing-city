/**
 * Offline analyser tests, run against the synthetic WAV fixtures in
 * tests/audio/ and their ground-truth sidecars.
 *
 * The analyser is deliberately free of any Web Audio dependency, which is what
 * makes this file possible: we read the WAVs ourselves and hand raw PCM
 * straight to analyze(). No AudioContext, no jsdom, no dependencies.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, analyzeVerbose } from '../src/audio/analyzer/index.js';
import { createBeatTracker, availableBackends } from '../src/audio/analyzer/backends/index.js';
import {
  CONFIDENCE_FLOOR,
  MIN_SWING_GAP,
  MAX_SWING_GAP,
  ENVELOPE_HZ,
} from '../src/contract.js';

const AUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), 'audio');

// ---------------------------------------------------------------------------
// Minimal WAV reader — 16-bit PCM, canonical 44-byte header.
// ---------------------------------------------------------------------------

/**
 * Parse a canonical PCM WAV into de-interleaved Float32 channels.
 * Walks the chunk list rather than assuming a fixed 44-byte header, so an
 * extra LIST/fact chunk would not silently shift the data.
 */
function readWav(path) {
  const buf = readFileSync(path);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', `${path}: not a RIFF file`);
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE', `${path}: not a WAVE file`);

  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body);
      assert.equal(format, 1, `${path}: only uncompressed PCM is supported`);
      channelCount = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buf.length - body);
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }

  assert.ok(dataStart >= 0, `${path}: no data chunk`);
  assert.equal(bitsPerSample, 16, `${path}: expected 16-bit PCM`);

  const frames = Math.floor(dataLength / (2 * channelCount));
  const channels = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const off = dataStart + (i * channelCount + c) * 2;
      channels[c][i] = buf.readInt16LE(off) / 32768;
    }
  }
  return { channels, sampleRate, frames, duration: frames / sampleRate };
}

function loadFixture(name) {
  const wav = readWav(join(AUDIO_DIR, `${name}.wav`));
  const truth = JSON.parse(readFileSync(join(AUDIO_DIR, `${name}.truth.json`), 'utf8'));
  return { name, ...wav, truth };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The five fixtures with a real, trackable pulse. */
const RHYTHMIC = [
  'four-on-floor-128',
  'four-on-floor-90',
  'four-on-floor-174',
  'breakbeat-140-offset',
  'breakbeat-100-offset',
];

/** Weak transients, no percussive grid. Allowed to report low confidence. */
const SPARSE = 'sparse-pad-72';

const ALL = [...RHYTHMIC, SPARSE];

/** Analysed once and shared: each analysis is real DSP over tens of seconds. */
const results = new Map();

before(() => {
  for (const name of ALL) {
    const fixture = loadFixture(name);
    const verbose = analyzeVerbose([fixture.channels[0]], fixture.sampleRate);
    results.set(name, { fixture, ...verbose });
  }
});

const get = (name) => {
  const r = results.get(name);
  assert.ok(r, `fixture ${name} was not analysed`);
  return r;
};

// ---------------------------------------------------------------------------

describe('WAV fixtures', () => {
  test('all fixtures load as 44.1kHz mono 16-bit PCM', () => {
    for (const name of ALL) {
      const { fixture } = get(name);
      assert.equal(fixture.sampleRate, 44100, `${name}: sample rate`);
      assert.equal(fixture.channels.length, 1, `${name}: channel count`);
      assert.ok(fixture.frames > 0, `${name}: has samples`);
      assert.equal(fixture.sampleRate, fixture.truth.sampleRate, `${name}: matches truth`);
    }
  });
});

describe('tempo estimation', () => {
  for (const name of RHYTHMIC) {
    test(`${name}: BPM within ±1.5 of truth`, () => {
      const { beatMap, fixture } = get(name);
      const truth = fixture.truth.bpm;
      assert.ok(
        Math.abs(beatMap.bpm - truth) <= 1.5,
        `${name}: expected ${truth} ±1.5, got ${beatMap.bpm.toFixed(3)}`
      );
    });

    // The single most common failure mode in tempo estimation, called out
    // separately so a regression reports as an octave error rather than as a
    // generic "BPM wrong".
    test(`${name}: no octave error (not half, not double)`, () => {
      const { beatMap, fixture } = get(name);
      const truth = fixture.truth.bpm;
      assert.ok(
        Math.abs(beatMap.bpm - truth / 2) > 2,
        `${name}: octave-halved — reported ${beatMap.bpm.toFixed(2)} against truth ${truth}`
      );
      assert.ok(
        Math.abs(beatMap.bpm - truth * 2) > 2,
        `${name}: octave-doubled — reported ${beatMap.bpm.toFixed(2)} against truth ${truth}`
      );
      // Also guard the neighbouring musical ratios that a prior can slide onto.
      assert.ok(
        Math.abs(beatMap.bpm - (truth * 2) / 3) > 2,
        `${name}: landed on 2/3 tempo — ${beatMap.bpm.toFixed(2)} against truth ${truth}`
      );
      assert.ok(
        Math.abs(beatMap.bpm - truth * 1.5) > 2,
        `${name}: landed on 3/2 tempo — ${beatMap.bpm.toFixed(2)} against truth ${truth}`
      );
    });
  }

  test('sparse-pad-72 does not crash and stays inside the search range', () => {
    const { beatMap } = get(SPARSE);
    assert.ok(Number.isFinite(beatMap.bpm), 'bpm is finite');
    assert.ok(beatMap.bpm >= 60 && beatMap.bpm <= 200, `bpm in range, got ${beatMap.bpm}`);
  });
});

describe('grid offset', () => {
  for (const name of ['breakbeat-140-offset', 'breakbeat-100-offset']) {
    test(`${name}: offset within ±60ms of truth`, () => {
      const { beatMap, fixture } = get(name);
      const truth = fixture.truth.offset;
      assert.ok(
        Math.abs(beatMap.offset - truth) <= 0.06,
        `${name}: expected ${truth}s ±60ms, got ${beatMap.offset.toFixed(4)}s`
      );
    });
  }

  test('four-on-floor fixtures start their grid at the top of the track', () => {
    for (const name of RHYTHMIC.filter((n) => n.startsWith('four-on-floor'))) {
      const { beatMap } = get(name);
      assert.ok(
        Math.abs(beatMap.offset - 0) <= 0.06,
        `${name}: expected offset ~0, got ${beatMap.offset.toFixed(4)}`
      );
    }
  });

  test('beats are ascending and start at the offset', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      assert.ok(beatMap.beats.length > 1, `${name}: has a grid`);
      assert.ok(
        Math.abs(beatMap.beats[0].t - beatMap.offset) < 1e-6,
        `${name}: first beat is the offset`
      );
      for (let i = 1; i < beatMap.beats.length; i++) {
        assert.ok(
          beatMap.beats[i].t > beatMap.beats[i - 1].t,
          `${name}: beat ${i} ascends`
        );
        assert.equal(beatMap.beats[i].index, i, `${name}: beat ${i} index`);
      }
    }
  });
});

describe('bpmConfidence', () => {
  for (const name of RHYTHMIC.filter((n) => n.startsWith('four-on-floor'))) {
    test(`${name}: confidence comfortably above CONFIDENCE_FLOOR`, () => {
      const { beatMap } = get(name);
      assert.ok(
        beatMap.bpmConfidence > CONFIDENCE_FLOOR,
        `${name}: expected > ${CONFIDENCE_FLOOR}, got ${beatMap.bpmConfidence.toFixed(3)}`
      );
    });
  }

  test('sparse-pad-72: confidence below CONFIDENCE_FLOOR', () => {
    const { beatMap } = get(SPARSE);
    assert.ok(
      beatMap.bpmConfidence < CONFIDENCE_FLOOR,
      `expected < ${CONFIDENCE_FLOOR} on material with no percussive grid, ` +
        `got ${beatMap.bpmConfidence.toFixed(3)}`
    );
  });

  test('confidence is a real number in 0..1 everywhere', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      const c = beatMap.bpmConfidence;
      assert.ok(Number.isFinite(c), `${name}: confidence is finite`);
      assert.ok(c >= 0 && c <= 1, `${name}: confidence in 0..1, got ${c}`);
    }
  });
});

describe('beats', () => {
  test('strengths are normalised 0..1', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      for (const b of beatMap.beats) {
        assert.ok(
          Number.isFinite(b.strength) && b.strength >= 0 && b.strength <= 1,
          `${name}: beat at ${b.t} has strength ${b.strength}`
        );
      }
    }
  });

  test('four-on-floor kicks read as strong beats', () => {
    const { beatMap } = get('four-on-floor-128');
    const mean = beatMap.beats.reduce((a, b) => a + b.strength, 0) / beatMap.beats.length;
    assert.ok(mean > 0.5, `every beat is a kick, expected mean strength > 0.5, got ${mean.toFixed(3)}`);
  });

  test('downbeats fall every 4th beat', () => {
    for (const name of RHYTHMIC) {
      const { beatMap } = get(name);
      const downbeats = beatMap.beats.filter((b) => b.downbeat).map((b) => b.index);
      assert.ok(downbeats.length > 0, `${name}: has downbeats`);
      for (let i = 1; i < downbeats.length; i++) {
        assert.equal(downbeats[i] - downbeats[i - 1], 4, `${name}: downbeat spacing`);
      }
    }
  });

  test('breakbeat downbeats align with the ground-truth downbeats', () => {
    // The bass note and both kicks land on beat 1 of each bar, so the phase
    // pick should agree with the generator.
    for (const name of ['breakbeat-140-offset', 'breakbeat-100-offset']) {
      const { beatMap, fixture } = get(name);
      const truthDownbeats = fixture.truth.beats.filter((b) => b.downbeat).map((b) => b.t);
      const ours = beatMap.beats.filter((b) => b.downbeat).map((b) => b.t);
      assert.ok(ours.length > 4, `${name}: enough downbeats to compare`);
      const period = 60 / beatMap.bpm;
      let hits = 0;
      for (const t of ours) {
        if (truthDownbeats.some((tt) => Math.abs(tt - t) < 0.25 * period)) hits++;
      }
      assert.ok(
        hits / ours.length > 0.8,
        `${name}: expected >80% of downbeats on true bar lines, got ${((hits / ours.length) * 100).toFixed(0)}%`
      );
    }
  });
});

describe('sections', () => {
  test('ascending, non-overlapping, energy in 0..1', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      assert.ok(beatMap.sections.length > 0, `${name}: has sections`);
      let prevEnd = -Infinity;
      for (const s of beatMap.sections) {
        assert.ok(s.end > s.start, `${name}: section has positive length`);
        assert.ok(s.start >= prevEnd - 1e-9, `${name}: sections do not overlap`);
        assert.ok(s.energy >= 0 && s.energy <= 1, `${name}: energy in 0..1, got ${s.energy}`);
        assert.equal(typeof s.label, 'string', `${name}: label is a string`);
        prevEnd = s.end;
      }
      assert.ok(
        beatMap.sections[beatMap.sections.length - 1].end <= beatMap.duration + 1e-6,
        `${name}: last section ends within the track`
      );
    }
  });

  test('breakbeat quiet bars surface as a lower-energy section', () => {
    // The generator drops bars 8-9 to a quarter gain. We do not require the
    // boundary to be exact, only that the segmentation notices the dip.
    const { beatMap } = get('breakbeat-140-offset');
    const energies = beatMap.sections.map((s) => s.energy);
    assert.ok(
      Math.max(...energies) - Math.min(...energies) > 0.15,
      `expected a visible energy contrast across sections, got ${JSON.stringify(energies.map((e) => +e.toFixed(2)))}`
    );
  });
});

describe('swing points', () => {
  test('respect MIN_SWING_GAP and MAX_SWING_GAP and are strictly ascending', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      const pts = beatMap.swingPoints;
      assert.ok(pts.length > 1, `${name}: expected multiple swing points, got ${pts.length}`);
      for (let i = 1; i < pts.length; i++) {
        const gap = pts[i].t - pts[i - 1].t;
        assert.ok(gap > 0, `${name}: swing points strictly ascending at ${i}`);
        assert.ok(
          gap >= MIN_SWING_GAP - 1e-9,
          `${name}: gap ${gap.toFixed(3)}s at ${i} is below MIN_SWING_GAP ${MIN_SWING_GAP}`
        );
        assert.ok(
          gap <= MAX_SWING_GAP + 1e-9,
          `${name}: gap ${gap.toFixed(3)}s at ${i} exceeds MAX_SWING_GAP ${MAX_SWING_GAP}`
        );
      }
    }
  });

  test('every tNext matches the following point t', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      const pts = beatMap.swingPoints;
      for (let i = 0; i < pts.length - 1; i++) {
        assert.equal(
          pts[i].tNext,
          pts[i + 1].t,
          `${name}: swingPoints[${i}].tNext should equal swingPoints[${i + 1}].t`
        );
      }
      // The contract gives the last point no successor to point at; it still
      // has to name a reachable future time so the physics can solve a flight.
      const last = pts[pts.length - 1];
      assert.ok(Number.isFinite(last.tNext), `${name}: last tNext is finite`);
      assert.ok(last.tNext > last.t, `${name}: last tNext is in the future`);
    }
  });

  test('strengths are inherited from real beats', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      const beatAt = new Map(beatMap.beats.map((b) => [b.t, b.strength]));
      for (const p of beatMap.swingPoints) {
        assert.ok(beatAt.has(p.t), `${name}: swing point at ${p.t} is on the beat grid`);
        assert.equal(p.strength, beatAt.get(p.t), `${name}: strength matches its beat`);
        assert.ok(p.strength >= 0 && p.strength <= 1, `${name}: strength in 0..1`);
      }
    }
  });

  test('cover the track rather than clustering in the loud part', () => {
    const { beatMap } = get('breakbeat-140-offset');
    const pts = beatMap.swingPoints;
    // First point near the start of the music, last near the end.
    assert.ok(
      pts[0].t - beatMap.offset <= MAX_SWING_GAP,
      `first swing point should arrive within MAX_SWING_GAP of the first beat`
    );
    assert.ok(
      beatMap.duration - pts[pts.length - 1].t <= MAX_SWING_GAP + 1,
      `last swing point should be near the end of the track`
    );
  });
});

describe('BeatMap shape and transport', () => {
  test('matches the contract shape', () => {
    for (const name of ALL) {
      const { beatMap, fixture } = get(name);
      assert.equal(beatMap.version, 1, `${name}: version`);
      assert.equal(beatMap.sampleRate, fixture.sampleRate, `${name}: sampleRate`);
      assert.ok(
        Math.abs(beatMap.duration - fixture.duration) < 1e-6,
        `${name}: duration`
      );
      for (const key of [
        'version', 'duration', 'sampleRate', 'bpm', 'bpmConfidence',
        'offset', 'beats', 'sections', 'swingPoints', 'onsetEnvelope',
      ]) {
        assert.ok(key in beatMap, `${name}: BeatMap has ${key}`);
      }
    }
  });

  test('onsetEnvelope is at ENVELOPE_HZ and normalised 0..1', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      const env = beatMap.onsetEnvelope;
      const expected = Math.round(beatMap.duration * ENVELOPE_HZ);
      assert.ok(
        Math.abs(env.length - expected) <= 1,
        `${name}: expected ~${expected} envelope samples, got ${env.length}`
      );
      let max = 0;
      for (const v of env) {
        assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${name}: envelope value ${v} in 0..1`);
        if (v > max) max = v;
      }
      assert.ok(max > 0.5, `${name}: envelope should reach near 1 somewhere, peaked at ${max}`);
    }
  });

  test('is structuredClone-able (it crosses a worker boundary)', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      const clone = structuredClone(beatMap);
      assert.deepEqual(clone, beatMap, `${name}: survives structuredClone unchanged`);
    }
  });

  test('round-trips through JSON (it goes into IndexedDB)', () => {
    for (const name of ALL) {
      const { beatMap } = get(name);
      const round = JSON.parse(JSON.stringify(beatMap));
      assert.deepEqual(round, beatMap, `${name}: survives a JSON round-trip unchanged`);
    }
  });
});

describe('beat tracker backend seam', () => {
  test('ellis is the default and is available', () => {
    assert.ok(availableBackends().includes('ellis'));
    assert.equal(createBeatTracker().name, 'ellis');
    assert.equal(createBeatTracker('ellis').name, 'ellis');
  });

  test('an unknown backend fails loudly rather than silently falling back', () => {
    assert.throws(() => createBeatTracker('essentia'), /unknown beat tracker backend/);
  });

  test('the backend contract is honoured', () => {
    const { tracked } = get('four-on-floor-128');
    assert.ok(Number.isFinite(tracked.bpm));
    assert.ok(Number.isFinite(tracked.confidence));
    assert.ok(Number.isFinite(tracked.offset));
    assert.ok(Array.isArray(tracked.beats));
    assert.ok(tracked.beats.every((t) => Number.isFinite(t)));
  });
});

describe('robustness', () => {
  test('rejects an empty buffer rather than producing a bogus BeatMap', () => {
    assert.throws(() => analyze([new Float32Array(0)], 44100), /empty audio buffer/);
  });

  test('rejects an invalid sample rate', () => {
    assert.throws(() => analyze([new Float32Array(1024)], 0), /invalid sampleRate/);
  });

  test('survives pure silence', () => {
    const silence = new Float32Array(44100 * 3);
    const beatMap = analyze([silence], 44100);
    assert.ok(Number.isFinite(beatMap.bpm), 'bpm is finite on silence');
    assert.ok(
      beatMap.bpmConfidence < CONFIDENCE_FLOOR,
      `silence must not be confident, got ${beatMap.bpmConfidence}`
    );
  });

  test('survives white noise without claiming a confident grid', () => {
    const n = 44100 * 4;
    const noise = new Float32Array(n);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (seed / 0x3fffffff - 1) * 0.4;
    }
    const beatMap = analyze([noise], 44100);
    assert.ok(Number.isFinite(beatMap.bpm));
    assert.ok(
      beatMap.bpmConfidence < CONFIDENCE_FLOOR,
      `white noise has no beat, got confidence ${beatMap.bpmConfidence.toFixed(3)}`
    );
  });

  test('downmixes multi-channel input', () => {
    const { fixture } = get('four-on-floor-128');
    const mono = fixture.channels[0];
    const stereo = analyze([mono, Float32Array.from(mono)], fixture.sampleRate);
    const single = get('four-on-floor-128').beatMap;
    assert.ok(
      Math.abs(stereo.bpm - single.bpm) < 0.5,
      'duplicating a channel should not move the tempo'
    );
  });

  test('progress callback reports monotonically to 1', () => {
    const { fixture } = get('four-on-floor-90');
    const seen = [];
    analyze([fixture.channels[0]], fixture.sampleRate, (stage, pct) => {
      seen.push({ stage, pct });
    });
    assert.ok(seen.length > 2, 'reported progress');
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].pct >= seen[i - 1].pct, 'progress never goes backwards');
      assert.equal(typeof seen[i].stage, 'string', 'stage is a string');
    }
    assert.equal(seen[seen.length - 1].pct, 1, 'ends at 1');
  });
});

describe('performance', () => {
  test('a 30s track analyses in under 3 seconds', () => {
    // four-on-floor-90 is the longest fixture at ~42s; scale the budget to the
    // stated 30s / 3s rate so the assertion means the same thing.
    const fixture = loadFixture('four-on-floor-90');
    assert.ok(fixture.duration > 30, `expected a >30s fixture, got ${fixture.duration.toFixed(1)}s`);
    const budget = 3 * (fixture.duration / 30);

    const t0 = process.hrtime.bigint();
    analyze([fixture.channels[0]], fixture.sampleRate);
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;

    assert.ok(
      elapsed < budget,
      `analysing ${fixture.duration.toFixed(1)}s took ${elapsed.toFixed(2)}s, budget ${budget.toFixed(2)}s`
    );
  });
});
