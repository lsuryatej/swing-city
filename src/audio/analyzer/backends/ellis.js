/**
 * Ellis (2007) dynamic-programming beat tracker.
 *
 * Daniel P. W. Ellis, "Beat Tracking by Dynamic Programming",
 * Journal of New Music Research 36(1), 2007.
 *
 * This is the method librosa's `beat_track` implements. Written from the
 * published algorithm; no GPL/AGPL source was copied.
 *
 * ## Why DP instead of picking peaks off a fixed grid
 *
 * The naive approach — estimate a tempo, lay down a grid, snap to the nearest
 * onset — fails in exactly the places real music gets interesting. It has no
 * way to ride through a passage where the onsets go quiet (the two-bar break
 * in the breakbeat fixtures drops to a quarter gain), and it is pulled off the
 * beat by syncopation, because a syncopated hit is a genuine onset that simply
 * is not a beat.
 *
 * The DP fixes both by scoring a WHOLE beat sequence at once:
 *
 *     C(t) = O(t) + max over τ in [t-2P, t-P/2] of  { α·F(t-τ, P) + C(τ) }
 *     F(Δ, P) = -( ln(Δ / P) )²
 *
 * O(t) is the onset strength — the reward for putting a beat where something
 * happened. F is the transition penalty: a log-squared cost for any inter-beat
 * interval that is not the target period P, symmetric in log space so that
 * being 10% fast costs the same as being 10% slow. α (`tightness`) sets how
 * much the tracker is willing to trade rhythmic regularity for landing on a
 * loud onset.
 *
 * The consequences are the two behaviours we need. Through the quiet break,
 * O(t) is small everywhere, so the transition term dominates and the tracker
 * coasts at a steady period — it keeps the beat through bars it can barely
 * hear. Against syncopation, a single off-grid hit is not worth the transition
 * penalty of two irregular intervals, so the optimal path steps over it.
 *
 * Because the recursion only ever looks backwards, one forward pass plus a
 * backtrace gives the globally optimal sequence, not a greedy approximation.
 */

import {
  tempoCandidates,
  fitGrid,
  gridFitScore,
  gridExplanation,
  logTempoPrior,
} from '../tempo.js';
import { sampleEnvelope } from '../onset.js';

/**
 * Transition-penalty weight α. Higher = more insistent on a steady period,
 * lower = more willing to chase loud onsets. librosa ships 100; Ellis's paper
 * uses a smaller number against a differently normalised onset function.
 * Tuned against the fixtures — see the report.
 */
export const DEFAULT_TIGHTNESS = 100;

/**
 * Create an Ellis DP beat tracker.
 *
 * @param {object} [options]
 * @param {number} [options.tightness] transition-penalty weight α
 * @param {number} [options.minBpm]
 * @param {number} [options.maxBpm]
 */
export function createEllisTracker(options = {}) {
  const {
    tightness = DEFAULT_TIGHTNESS,
    minBpm = 60,
    maxBpm = 200,
    trim = true,
  } = options;

  /**
   * @param {Float32Array} onsetEnvelope onset strength, one value per STFT hop
   * @param {number} sampleRate          of the analysed audio
   * @param {number} hopSize             STFT hop in samples
   * @param {object} [context]
   * @param {(f:number)=>number} [context.frameTime] frame index -> seconds.
   *        Defaults to the naive f*hop/sr; the analyser passes the real one,
   *        which accounts for the window centre and the analysis pre-pad.
   * @param {Array<{t:number,strength:number}>} [context.onsets] peak-picked
   *        onsets, used to refine the grid fit and to score confidence.
   * @param {number} [context.duration] track length in seconds.
   * @returns {{bpm:number, confidence:number, offset:number, beats:number[],
   *            diagnostics:object}}
   */
  function track(onsetEnvelope, sampleRate, hopSize, context = {}) {
    const frameRate = sampleRate / hopSize;
    const frameTime = context.frameTime ?? ((f) => (f * hopSize) / sampleRate);
    const onsets = context.onsets ?? [];
    const duration = context.duration ?? onsetEnvelope.length / frameRate;

    // --- 1. Tempo candidates from the prior-weighted ACF -------------------
    const search = tempoCandidates(onsetEnvelope, frameRate, { minBpm, maxBpm });

    // --- 2. Track at EVERY candidate, then pick by what the grid explains --
    //
    // This is the octave guard, and it is a two-stage one.
    //
    // The perceptual prior alone is not sufficient, and the fixtures prove it:
    // in a breakbeat where kicks and snares alternate, the autocorrelation at
    // two beats (kick to kick) is genuinely taller than at one beat (kick to
    // snare), and it beats the prior's objection. Conversely a track with
    // hi-hats on the offbeats has a genuinely tall peak at half the beat
    // period. Autocorrelation simply cannot tell a tempo from its own
    // multiples — that ambiguity is a property of the signal, not of the
    // estimator.
    //
    // What DOES disambiguate is running the tracker at each candidate and
    // asking which resulting grid actually accounts for the onsets. Half tempo
    // leaves every other onset unexplained; double tempo leaves every other
    // grid position empty. The support/coverage F-measure penalises both, the
    // prior breaks the remaining ties, and the ACF height keeps genuinely
    // unsupported tempi out. We have ~800x realtime of headroom, so paying for
    // a dozen DP passes to get this right is cheap.
    const localScoreCache = new Map();
    let best = null;
    const evaluated = [];

    for (const cand of search.candidates) {
      const framesPerBeat = Math.max(2, Math.round((frameRate * 60) / cand.bpm));
      if (!localScoreCache.has(framesPerBeat)) {
        localScoreCache.set(framesPerBeat, beatLocalScore(onsetEnvelope, framesPerBeat));
      }
      const localScore = localScoreCache.get(framesPerBeat);

      let beatFrames = dpBeatTrack(localScore, framesPerBeat, tightness);
      if (trim) beatFrames = trimBeats(beatFrames, localScore);
      if (beatFrames.length < 4) continue;

      const seedPeriod = 60 / cand.bpm;
      const points = refineBeatTimes(
        beatFrames, frameTime, onsets, onsetEnvelope, frameRate, seedPeriod
      );
      const fit = fitGrid(points, medianDiff(points.map((p) => p.t)) || seedPeriod);
      if (!(fit.period > 0)) continue;

      const bpm = 60 / fit.period;
      if (bpm < minBpm * 0.9 || bpm > maxBpm * 1.1) continue;

      const tracked = enforceAscending(points.map((p) => p.t));
      const grid = extendGrid(tracked, fit.period, duration);
      const score = gridFitScore(grid.times, onsets, fit.period);

      // Explanation is the primary term; the prior breaks ties between
      // octaves that explain the onsets comparably well; the ACF term stops a
      // tempo with no autocorrelation support at all from winning on a
      // technicality.
      const selection =
        score.f *
        Math.exp(SELECTION_PRIOR_WEIGHT * logTempoPrior(bpm)) *
        (0.4 + 0.6 * cand.acfNorm);

      const result = { bpm, fit, grid, score, cand, beatFrames, selection };
      evaluated.push({
        bpm, gridF: score.f, support: score.support,
        coverage: score.coverage, acfNorm: cand.acfNorm, selection,
      });
      if (!best || selection > best.selection) best = result;
    }

    if (!best) return degenerate(search, duration, onsets, frameRate);

    const period = best.fit.period;
    const beats = best.grid.times;

    // The contract's `offset` is "seconds to the first beat of the grid", and
    // because the grid now spans the whole track from t=0 that is necessarily
    // the phase — a value in [0, period). It is NOT where the music comes in:
    // a track with a 14-second ambient intro still has beats through the
    // intro, they just carry very low strength.
    const offset = beats.length ? beats[0] : 0;

    const explanation = gridExplanation(beats, onsets, period);

    evaluated.sort((a, b) => b.selection - a.selection);

    return {
      bpm: best.bpm,
      confidence: explanation.confidence,
      offset,
      beats,
      beatSupport: best.grid.support,
      diagnostics: {
        backend: 'ellis',
        seedBpm: search.seedBpm,
        acfContrast: search.contrast,
        hitRate: explanation.hitRate,
        support: explanation.support,
        gridF: best.score.f,
        gridSupport: best.score.support,
        gridCoverage: best.score.coverage,
        trackedBeats: best.beatFrames.length,
        extrapolatedBeats: beats.length - best.beatFrames.length,
        fitResidual: best.fit.residual,
        tightness,
        candidates: evaluated.slice(0, 6),
      },
    };
  }

  return { name: 'ellis', track };
}

/**
 * How much the perceptual prior is allowed to weigh against grid explanation
 * when choosing between candidates. 0 disables the prior entirely; 1 gives it
 * full log-domain weight.
 */
const SELECTION_PRIOR_WEIGHT = 1.0;

// ---------------------------------------------------------------------------
// Ellis stages
// ---------------------------------------------------------------------------

/**
 * O(t) for the DP: the onset envelope standardised, then convolved with a
 * narrow Gaussian whose width scales with the beat period (σ = P/32).
 *
 * The smoothing is small on purpose. It exists so that a beat landing one
 * frame either side of a transient still collects most of its reward, which
 * stops the DP from making tiny irregular adjustments just to sit exactly on a
 * sample-quantised peak. Widen it and genuinely distinct onsets start to merge.
 */
export function beatLocalScore(envelope, framesPerBeat) {
  const n = envelope.length;
  if (n === 0) return new Float32Array(0);

  // Scale by the standard deviation but do NOT subtract the mean. This looks
  // like a detail and is not: with the mean removed, every frame that is not
  // an onset contributes NEGATIVE score, so the DP is rewarded for using as
  // few beats as possible and drifts toward half tempo. Keeping the score
  // non-negative means a beat can only ever add to the total, and the
  // transition penalty alone decides the spacing.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += envelope[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = envelope[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / Math.max(1, n - 1)) || 1e-9;

  const radius = framesPerBeat;
  const sigma = framesPerBeat / 32;
  const kernel = new Float64Array(2 * radius + 1);
  let kSum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-0.5 * (i / sigma) * (i / sigma));
    kernel[i + radius] = v;
    kSum += v;
  }
  // Effectively zero beyond ~4σ; skip those taps entirely.
  const eff = Math.min(radius, Math.ceil(4 * sigma));

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let d = -eff; d <= eff; d++) {
      const j = i + d;
      if (j < 0 || j >= n) continue;
      acc += ((envelope[j] - mean) / std) * kernel[d + radius];
    }
    out[i] = acc / kSum;
  }
  return out;
}

/**
 * The forward DP pass and backtrace.
 *
 * For every frame we ask: if a beat lands here, which earlier beat is the best
 * predecessor? The candidate window is [t-2P, t-P/2] — the tracker may stretch
 * to a double or squeeze to a half interval, but no further, which is what
 * bounds the search and keeps the whole thing linear in track length.
 *
 * `cumScore` is the best total score of any beat sequence ENDING at this frame;
 * `backlink` is the predecessor that achieved it. A backlink of -1 marks the
 * head of a sequence.
 */
export function dpBeatTrack(localScore, framesPerBeat, tightness) {
  const n = localScore.length;
  if (n === 0) return [];

  const minGap = Math.max(1, Math.round(framesPerBeat / 2));
  const maxGap = Math.max(minGap + 1, 2 * framesPerBeat);

  // Precompute the transition penalty for every allowed interval.
  const penalty = new Float64Array(maxGap + 1);
  for (let d = minGap; d <= maxGap; d++) {
    const lr = Math.log(d / framesPerBeat);
    penalty[d] = -tightness * lr * lr;
  }

  let maxLocal = 0;
  for (let i = 0; i < n; i++) if (localScore[i] > maxLocal) maxLocal = localScore[i];
  // A sequence may only BEGIN on a frame that has real energy — otherwise the
  // tracker starts a grid inside leading silence and locks the phase to noise.
  const startFloor = 0.01 * maxLocal;

  const cumScore = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const reached = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    // Best predecessor within the allowed interval window.
    let best = -Infinity;
    let bestPrev = -1;
    const hi = i - minGap;
    for (let p = Math.max(0, i - maxGap); p <= hi; p++) {
      if (!reached[p]) continue;
      const s = cumScore[p] + penalty[i - p];
      if (s > best) {
        best = s;
        bestPrev = p;
      }
    }

    // Starting a fresh sequence here scores 0 (no accumulated history, no
    // transition to pay for) and is only allowed where something is audible.
    //
    // Crucially, EVERY frame gets to make this choice independently. An
    // earlier version latched onto the first eligible frame and never
    // reconsidered, which pinned the whole grid to whatever happened to make
    // the first sound — and since the transition penalty then forbids any
    // large correction, the entire track came out locked to the offbeat.
    // Letting each frame either extend the best chain or open a new one, and
    // letting the backtrace pick the winner globally, is what makes this a
    // dynamic program rather than a greedy pass.
    const startScore = localScore[i] >= startFloor && localScore[i] > 0 ? 0 : -Infinity;

    if (bestPrev >= 0 && best >= startScore) {
      cumScore[i] = localScore[i] + best;
      backlink[i] = bestPrev;
      reached[i] = 1;
    } else if (startScore === 0) {
      cumScore[i] = localScore[i];
      backlink[i] = -1;
      reached[i] = 1;
    } else {
      cumScore[i] = 0;
      backlink[i] = -1;
      reached[i] = 0;
    }
  }

  const tail = lastBeat(cumScore);
  if (tail < 0) return [];

  const beats = [];
  for (let i = tail; i >= 0; i = backlink[i]) {
    beats.push(i);
    if (backlink[i] === -1) break;
  }
  beats.reverse();
  return beats;
}

/**
 * Where does the optimal sequence end?
 *
 * cumScore rises roughly monotonically (every beat adds reward), so its tail is
 * always the largest — but the true last beat is a LOCAL maximum of cumScore,
 * not the final frame. We take the last local maximum that clears half the
 * median of all local maxima, which skips any trailing frames the tracker
 * limped through after the music stopped.
 */
export function lastBeat(cumScore) {
  const n = cumScore.length;
  const maxima = [];
  for (let i = 1; i < n - 1; i++) {
    if (cumScore[i] > cumScore[i - 1] && cumScore[i] >= cumScore[i + 1]) maxima.push(i);
  }
  if (maxima.length === 0) {
    let best = -1;
    let bv = 0;
    for (let i = 0; i < n; i++) if (cumScore[i] > bv) (bv = cumScore[i]), (best = i);
    return best;
  }
  const vals = maxima.map((i) => cumScore[i]).sort((a, b) => a - b);
  const m = vals.length >> 1;
  const median = vals.length % 2 ? vals[m] : 0.5 * (vals[m - 1] + vals[m]);
  const threshold = 0.5 * median;
  for (let i = maxima.length - 1; i >= 0; i--) {
    if (cumScore[maxima[i]] > threshold) return maxima[i];
  }
  return maxima[maxima.length - 1];
}

/**
 * Drop weak beats from the head and tail of the sequence.
 *
 * The DP will happily extend a beat or two into silence at either end, because
 * the transition reward alone is enough to justify it. Those phantom beats are
 * poison for the reported offset, so trim anything below half the RMS local
 * score of the sequence — but only from the ends, never from the middle, where
 * a quiet beat is a real beat we tracked through a break.
 */
export function trimBeats(beats, localScore) {
  if (beats.length === 0) return beats;
  let sq = 0;
  for (const b of beats) sq += localScore[b] * localScore[b];
  const threshold = 0.5 * Math.sqrt(sq / beats.length);

  let start = 0;
  while (start < beats.length && localScore[beats[start]] <= threshold) start++;
  let end = beats.length - 1;
  while (end > start && localScore[beats[end]] <= threshold) end--;
  const trimmed = beats.slice(start, end + 1);
  return trimmed.length >= 2 ? trimmed : beats;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

/**
 * Turn tracked beat frames into weighted time observations for the grid fit.
 *
 * Where a tracked beat coincides with a peak-picked onset we take the onset's
 * parabolically-interpolated time and weight it by its strength — those are our
 * most precise observations. Where it does not (an unaccented beat, or a beat
 * inside the quiet break) we keep the frame time but weight it down, so it
 * still anchors the phase without dragging the slope around.
 */
function refineBeatTimes(beatFrames, frameTime, onsets, envelope, frameRate, period) {
  const tol = Math.min(0.12 * period, 0.06);
  const t0 = frameTime(0);
  const points = [];
  let oi = 0;

  for (const f of beatFrames) {
    const t = frameTime(f);
    while (oi < onsets.length && onsets[oi].t < t - tol) oi++;
    let bestOnset = null;
    for (let j = oi; j < onsets.length && onsets[j].t <= t + tol; j++) {
      if (!bestOnset || onsets[j].strength > bestOnset.strength) bestOnset = onsets[j];
    }
    if (bestOnset) {
      points.push({ t: bestOnset.t, w: 0.2 + bestOnset.strength });
    } else {
      const e = sampleEnvelope(envelope, frameRate, t0, t);
      points.push({ t, w: 0.05 + 0.1 * Math.min(1, e) });
    }
  }
  return points;
}

function medianDiff(times) {
  if (times.length < 2) return 0;
  const d = [];
  for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? d[m] : 0.5 * (d[m - 1] + d[m]);
}

/**
 * Onset snapping can in principle move two adjacent beats past each other.
 * The contract requires an ascending grid, so enforce it here rather than
 * letting a pathological input produce a non-monotonic BeatMap.
 */
function enforceAscending(times) {
  const out = [];
  for (const t of times) {
    if (out.length === 0 || t > out[out.length - 1]) out.push(t);
  }
  return out;
}

/**
 * Extend the tracked beats to cover the whole track, from t=0 to the end.
 *
 * The DP only tracks where there is evidence, so on a track with a fourteen
 * second ambient intro it simply starts fourteen seconds in. Reporting that as
 * the grid is wrong twice over: the contract's `offset` is a phase and must be
 * less than one beat period, and more importantly the character would hang
 * motionless through the entire intro because there are no beats to swing on.
 *
 * So we continue the fitted period backwards to the top of the track and
 * forwards to the end. Extrapolated beats are flagged with a low `support`
 * value, which the caller turns into low `strength` — they exist so the
 * choreographer has something to work with, but it should prefer beats the
 * tracker actually saw.
 *
 * @returns {{times:number[], support:number[]}}
 */
export function extendGrid(trackedTimes, period, duration) {
  if (trackedTimes.length === 0 || !(period > 0)) {
    return { times: trackedTimes.slice(), support: trackedTimes.map(() => 1) };
  }

  const pre = [];
  for (let t = trackedTimes[0] - period; t >= -1e-9; t -= period) pre.push(Math.max(0, t));
  pre.reverse();

  const post = [];
  const last = trackedTimes[trackedTimes.length - 1];
  for (let t = last + period; t <= duration + 1e-9; t += period) post.push(t);

  const times = [...pre, ...trackedTimes, ...post];
  const support = [
    ...pre.map(() => 0),
    ...trackedTimes.map(() => 1),
    ...post.map(() => 0),
  ];
  return { times: enforceAscending(times), support };
}

/**
 * Nothing trackable at any candidate tempo. Emit a bare grid at the best ACF
 * tempo so downstream code has a well-formed BeatMap, and let the confidence
 * say plainly that it is a guess.
 */
function degenerate(search, duration, onsets) {
  const bpm = search.seedBpm || 120;
  const period = 60 / bpm;
  const beats = [];
  for (let t = 0; t <= duration + 1e-9; t += period) beats.push(t);
  const explanation = gridExplanation(beats, onsets, period);
  return {
    bpm,
    confidence: Math.min(0.3, explanation.confidence),
    offset: 0,
    beats,
    beatSupport: beats.map(() => 0),
    diagnostics: {
      backend: 'ellis',
      degenerate: true,
      seedBpm: bpm,
      hitRate: explanation.hitRate,
      support: explanation.support,
      trackedBeats: 0,
    },
  };
}
