/**
 * BeatMap assembly: turn a tracked beat grid plus the onset envelope into the
 * artifact described by src/contract.js.
 *
 * Everything here is derivation and shaping — no DSP beyond reading the
 * envelope and the raw samples. Pure functions so each piece is testable on
 * its own.
 */

import { MIN_SWING_GAP, MAX_SWING_GAP } from '../../contract.js';
import { sampleEnvelope } from './onset.js';

/**
 * Per-beat strength, normalised 0..1 against the track's own dynamic range.
 *
 * Two details that matter:
 *  - We take the LOCAL MAX of the envelope in a small window around the beat,
 *    not the value exactly at it. A few milliseconds of grid error should not
 *    turn a kick into a weak beat, and the contract wants a four-on-the-floor
 *    kick reading ~1.0.
 *  - The normalisation range is a high percentile rather than the outright
 *    maximum, so one anomalously loud hit does not push every other beat down
 *    towards zero.
 */
export function beatStrengths(beatTimes, envelope, frameRate, frameTime, windowSec = 0.045) {
  const t0 = frameTime(0);
  const raw = beatTimes.map((t) => {
    let best = 0;
    for (let d = -windowSec; d <= windowSec; d += 1 / frameRate / 2) {
      const v = sampleEnvelope(envelope, frameRate, t0, t + d);
      if (v > best) best = v;
    }
    return best;
  });

  const sorted = [...raw].sort((a, b) => a - b);
  const lo = percentile(sorted, 0.05);
  const hi = percentile(sorted, 0.95);
  const span = hi - lo;
  if (span <= 1e-9) return raw.map(() => (hi > 0 ? 1 : 0));
  return raw.map((v) => clamp01((v - lo) / span));
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const i = clamp(Math.round(p * (sortedAsc.length - 1)), 0, sortedAsc.length - 1);
  return sortedAsc[i];
}

/**
 * Which of the four beat positions is beat 1?
 *
 * Assumes 4/4 (the contract does too) and picks the phase whose beats carry
 * the most energy. Bass drums and chord changes land on the downbeat far more
 * often than not, so summing strength over each candidate phase and taking the
 * largest is a cheap heuristic that is right most of the time and harmless
 * when it is not.
 */
export function pickDownbeatPhase(strengths, meter = 4) {
  const sums = new Array(meter).fill(0);
  for (let i = 0; i < strengths.length; i++) sums[i % meter] += strengths[i];
  let best = 0;
  for (let p = 1; p < meter; p++) if (sums[p] > sums[best]) best = p;
  return best;
}

/** Build the contract's Beat[] from times + strengths. */
export function buildBeats(beatTimes, strengths, meter = 4) {
  const phase = pickDownbeatPhase(strengths, meter);
  return beatTimes.map((t, i) => ({
    t,
    strength: strengths[i],
    index: i,
    downbeat: i % meter === phase,
  }));
}

/**
 * Coarse structural segmentation by broadband energy.
 *
 * Windows of ~2s of RMS over the raw samples, normalised against the loudest
 * window, then adjacent windows within `mergeTolerance` of each other are
 * merged into one section. This is not music structure analysis — it finds
 * where the track gets louder and quieter, which is enough for the renderer,
 * and the contract explicitly says the label is a hint.
 */
export function buildSections(mono, sampleRate, duration, opts = {}) {
  const {
    windowSec = 2,
    mergeTolerance = 0.15,
    // A short section only survives if it is dramatically different from its
    // neighbours — a real breakdown, not a two-second dip in a chorus.
    shortMergeTolerance = 0.35,
    maxSections = 8,
  } = opts;

  // Minimum section length. 8s is right for a pop track; short fixtures need
  // proportionally shorter sections or the whole track collapses to one.
  const minSectionSec = Math.min(8, Math.max(2.5, duration / 8));

  const windowSamples = Math.max(1, Math.round(windowSec * sampleRate));
  const count = Math.max(1, Math.ceil(mono.length / windowSamples));

  const energies = new Float64Array(count);
  for (let w = 0; w < count; w++) {
    const start = w * windowSamples;
    const end = Math.min(mono.length, start + windowSamples);
    let sq = 0;
    for (let i = start; i < end; i++) sq += mono[i] * mono[i];
    energies[w] = end > start ? Math.sqrt(sq / (end - start)) : 0;
  }

  let max = 0;
  for (const e of energies) if (e > max) max = e;
  const norm = max > 0 ? 1 / max : 0;

  // Start with one section per window, then merge agglomeratively.
  let runs = [];
  for (let w = 0; w < count; w++) {
    runs.push({
      start: (w * windowSamples) / sampleRate,
      end: Math.min(duration, ((w + 1) * windowSamples) / sampleRate),
      energy: energies[w] * norm,
    });
  }

  // Repeatedly merge the most similar adjacent pair. A sliver next to a
  // near-identical neighbour is not a section boundary, it is quantisation
  // noise from the analysis window — merging worst-first collapses those
  // without ever destroying a genuine contrast.
  const lengthOf = (r) => r.end - r.start;
  while (runs.length > 1) {
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i + 1 < runs.length; i++) {
      const d = Math.abs(runs[i].energy - runs[i + 1].energy);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI < 0) break;

    const a = runs[bestI];
    const b = runs[bestI + 1];
    const tooShort = lengthOf(a) < minSectionSec || lengthOf(b) < minSectionSec;
    const overCap = runs.length > maxSections;

    const shouldMerge =
      bestD < mergeTolerance ||
      (tooShort && bestD < shortMergeTolerance) ||
      overCap;
    if (!shouldMerge) break;

    const la = lengthOf(a);
    const lb = lengthOf(b);
    runs.splice(bestI, 2, {
      start: a.start,
      end: b.end,
      energy: (a.energy * la + b.energy * lb) / (la + lb),
    });
  }

  let mean = 0;
  for (const r of runs) mean += r.energy;
  mean /= runs.length || 1;

  return runs.map((r, i) => ({
    start: r.start,
    end: r.end,
    energy: clamp01(r.energy),
    label: labelSection(r, i, runs, mean),
  }));
}

/**
 * Heuristic section labels. Position in the track plus energy relative to the
 * track mean and to the neighbouring section. Free-form by contract.
 */
function labelSection(run, i, runs, mean) {
  const first = i === 0;
  const last = i === runs.length - 1;
  const prev = i > 0 ? runs[i - 1].energy : null;
  const quiet = run.energy < mean * 0.8;
  const loud = run.energy > mean * 1.1;

  if (first && quiet) return 'intro';
  if (last && quiet) return 'outro';
  if (quiet) return 'break';
  if (loud && prev !== null && run.energy > prev + 0.12) return 'drop';
  if (prev !== null && run.energy > prev + 0.04) return 'build';
  return loud ? 'drop' : 'body';
}

/**
 * Choose web-release moments from the beat grid.
 *
 * The obvious implementation — sort beats by strength, take the loudest that
 * respect the gap limits — produces a rhythmically lumpy result: it clusters
 * releases around whichever bars happen to be loudest and leaves the rest of
 * the track sparse. Since these drive the character's swing choreography, an
 * even musical feel matters more than raw peak strength.
 *
 * So this is a dynamic program over the whole track instead of a greedy pass.
 * Each selected beat scores its own strength plus a bonus for being a
 * downbeat, and each TRANSITION scores a bonus for spanning a whole number of
 * bars (or half-bars), which is what makes the resulting rhythm feel
 * deliberate rather than arbitrary. Maximising the total naturally fills the
 * track end to end, because every additional point adds positive score.
 *
 * MIN_SWING_GAP / MAX_SWING_GAP are enforced structurally: they define the
 * transition window, so no illegal pair can ever be considered.
 */
export function selectSwingPoints(beats, period, opts = {}) {
  const {
    minGap = MIN_SWING_GAP,
    maxGap = MAX_SWING_GAP,
    downbeatBonus = 0.3,
    barBonus = 0.1,
    sectionBonus = 0.35,
    meter = 4,
    sections = [],
  } = opts;

  const n = beats.length;
  if (n === 0) return [];

  /**
   * THE COST OF A SWING. This single number is what makes the selection
   * actually select.
   *
   * Without it the objective is a sum of non-negative rewards, so the optimum
   * is trivially "take as many points as the gap constraint allows" — the DP
   * degenerates into uniform decimation at exactly MIN_SWING_GAP, the strength
   * term contributes nothing, and swings get placed on silent beats in the
   * intro. Charging each selected beat a baseline makes a weak beat NET
   * NEGATIVE: it is worth swinging on a beat only if that beat is livelier
   * than the track's typical beat.
   *
   * The baseline is the median beat strength, so it adapts to the track rather
   * than to an absolute loudness. MAX_SWING_GAP still forces a point in during
   * a genuinely dead passage — the character must never hang motionless — but
   * quiet stretches now get the minimum the contract allows while drops get
   * as many as they can carry.
   */
  const strengths = beats.map((b) => b.strength).sort((a, b) => a - b);
  const swingCost = percentile(strengths, 0.5);

  /** Beats that sit on a section boundary are natural places to move. */
  const boundaries = sections.map((s) => s.start);
  const nearBoundary = (t) => boundaries.some((b) => Math.abs(b - t) < 0.5 * period);

  const value = (j) =>
    beats[j].strength -
    swingCost +
    (beats[j].downbeat ? downbeatBonus : 0) +
    (nearBoundary(beats[j].t) ? sectionBonus : 0);

  // A mild pull toward whole-bar spacing. Deliberately much smaller than the
  // strength term — enough to break ties toward musical phrasing, not enough
  // to impose a uniform rhythm of its own.
  //
  // Whole bars score full; half-bars score less but still score. Rewarding
  // ONLY whole bars made the density control discontinuous: every setting
  // collapsed to either one-swing-per-bar or one-per-two-bars, because a
  // 6-beat gap earned nothing and the DP always preferred 4 or 8. Allowing
  // half-bar phrasing puts the intermediate spacings back on the table and
  // makes the density knob behave monotonically.
  const halfBar = meter / 2;
  const transitionBonus = (i, j) => {
    const gapBeats = j - i;
    if (gapBeats <= 0) return 0;
    if (gapBeats % meter === 0) return barBonus;
    if (Number.isInteger(halfBar) && gapBeats % halfBar === 0) return barBonus * 0.5;
    return 0;
  };

  const best = new Float64Array(n).fill(-Infinity);
  const prev = new Int32Array(n).fill(-1);

  // A chain may open on any beat reachable from the track's first beat.
  const openUntil = beats[0].t + maxGap;

  for (let j = 0; j < n; j++) {
    if (beats[j].t <= openUntil) best[j] = value(j);
    for (let i = j - 1; i >= 0; i--) {
      const gap = beats[j].t - beats[i].t;
      if (gap < minGap) continue;
      if (gap > maxGap) break;
      if (best[i] === -Infinity) continue;
      const cand = best[i] + value(j) + transitionBonus(i, j);
      if (cand > best[j]) {
        best[j] = cand;
        prev[j] = i;
      }
    }
  }

  // The chain has to reach the end of the track. With weak beats now scoring
  // negative, a plain global argmax would happily stop before a quiet outro
  // and leave the last stretch with no swing points at all — so restrict the
  // terminal to beats within one maximum gap of the final beat.
  const lastT = beats[n - 1].t;
  let tail = -1;
  for (let j = 0; j < n; j++) {
    if (best[j] === -Infinity) continue;
    if (lastT - beats[j].t > maxGap) continue;
    if (tail === -1 || best[j] > best[tail]) tail = j;
  }
  if (tail === -1) {
    for (let j = 0; j < n; j++) {
      if (best[j] !== -Infinity && (tail === -1 || best[j] > best[tail])) tail = j;
    }
  }
  if (tail === -1) return [];

  const chain = [];
  for (let j = tail; j !== -1; j = prev[j]) chain.push(j);
  chain.reverse();

  return chain.map((j, k) => {
    const nextIdx = chain[k + 1];
    // The final point has no successor. Extrapolate one flight of the same
    // duration as the previous hop so the physics still has a target to solve
    // for rather than a null it has to special-case.
    const tNext =
      nextIdx !== undefined
        ? beats[nextIdx].t
        : beats[j].t + (chain.length > 1 ? beats[j].t - beats[chain[k - 1]].t : minGap);
    return { t: beats[j].t, tNext, strength: beats[j].strength };
  });
}

export const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
