/**
 * Tempo estimation and grid scoring.
 *
 * Two jobs live here, both consumed by the beat-tracking backend:
 *
 *  1. `estimateTempoACF` — a global tempo estimate from the autocorrelation of
 *     the onset envelope, weighted by a log-Gaussian perceptual prior. This is
 *     the seed the Ellis DP tracker needs, and the prior is the octave-error
 *     guard (see below).
 *  2. `fitGrid` / `gridFitScore` / `computeConfidence` — turning a tracked beat
 *     sequence into a precise (bpm, offset) pair and an honest confidence.
 *
 * Pure functions, no state, no Web Audio.
 */

export const MIN_BPM = 60;
export const MAX_BPM = 200;

/** Centre of the perceptual tempo prior, in BPM. */
export const PRIOR_CENTRE_BPM = 120;

/** Width of the prior, in octaves (log2 BPM). librosa's default is 1.0. */
export const PRIOR_STD_OCTAVES = 1.0;

/** Zero-mean, unit-variance version of a signal. */
export function standardize(x) {
  const n = x.length;
  if (n === 0) return new Float32Array(0);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / Math.max(1, n - 1)) || 1e-9;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (x[i] - mean) / std;
  return out;
}

/**
 * Unbiased autocorrelation of `x` over a range of lags.
 *
 * Normalising each lag by the number of overlapping samples (N - lag) rather
 * than by N is what stops the ACF sagging linearly with lag. Without it, slow
 * tempo candidates are systematically under-scored, which pushes the estimate
 * toward octave-doubling — the exact failure mode we are trying to avoid.
 */
export function autocorrelate(x, minLag, maxLag) {
  const n = x.length;
  const out = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let acc = 0;
    const stop = n - lag;
    for (let i = 0; i < stop; i++) acc += x[i] * x[i + lag];
    out[lag] = acc / stop;
  }
  return out;
}

/**
 * The perceptual tempo prior, in log space.
 *
 * Human tempo perception is roughly log-normal around 120 BPM: given an
 * ambiguous pulse, listeners tap near there. A pure autocorrelation cannot
 * distinguish a tempo from its own half or double — the ACF has peaks at every
 * multiple of the true beat period, and which one is tallest depends on
 * accidents of the arrangement (hi-hats on the offbeats lift the double;
 * a strong backbeat lifts the half).
 *
 * THIS IS THE OCTAVE-ERROR GUARD. Because 64 and 256 BPM sit a full octave
 * either side of 128, the prior penalises them by the same amount it rewards
 * 128, and it does so on a principled perceptual basis rather than a hand-tuned
 * threshold. The search runs over the whole 60..200 BPM range at once, so a
 * candidate is always being scored against its own half and double wherever
 * those also fall in range.
 */
export function logTempoPrior(bpm, centre = PRIOR_CENTRE_BPM, std = PRIOR_STD_OCTAVES) {
  const z = (Math.log2(bpm) - Math.log2(centre)) / std;
  return -0.5 * z * z;
}

/** Linear interpolation into an integer-lag ACF at a fractional lag. */
function acfAt(acf, lag, minLag, maxLag) {
  if (lag < minLag || lag > maxLag) return 0;
  const i = Math.floor(lag);
  const frac = lag - i;
  const a = acf[i] ?? 0;
  const b = acf[Math.min(maxLag, i + 1)] ?? a;
  return Math.max(0, a * (1 - frac) + b * frac);
}

/**
 * Metrical ratios a tempo estimate can plausibly slip onto. Generating these
 * explicitly around every ACF peak means the octave decision is always made by
 * comparing real, fully-evaluated alternatives rather than hoping one peak
 * happened to be tallest.
 */
const METRICAL_RATIOS = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3];

/**
 * Global tempo search: prior-weighted autocorrelation of the onset envelope,
 * evaluated on a fine LOG-SPACED lattice.
 *
 * Log spacing rather than integer lags is deliberate. Integer lags give wildly
 * uneven tempo resolution — at 86 frames/sec, one lag step is 0.7 BPM down at
 * 60 BPM but 5.9 BPM up at 174 BPM — so a linear-in-lag search is far too
 * coarse at exactly the fast tempi where accuracy is hardest. A log lattice is
 * uniform in musical terms: every step is the same fraction of a tempo.
 *
 * The ACF is compressed with log1p(1e6 * r) before the prior is added. Raw ACF
 * values differ between candidates by large multiplicative factors, and without
 * flattening them the prior could never outvote a spuriously tall harmonic.
 * Negative correlations clamp to zero — anticorrelation is never evidence of a
 * tempo.
 *
 * Returns a RANKED CANDIDATE SET, not a single answer. The caller runs the beat
 * tracker at each candidate and picks whichever grid actually explains the
 * onsets best; see the octave-guard note in ellis.js for why that second stage
 * is necessary.
 */
export function tempoCandidates(envelope, frameRate, opts = {}) {
  const {
    minBpm = MIN_BPM,
    maxBpm = MAX_BPM,
    priorCentre = PRIOR_CENTRE_BPM,
    priorStd = PRIOR_STD_OCTAVES,
    latticeSteps = 400,
    maxCandidates = 12,
    peaks = 4,
  } = opts;

  const minLag = Math.max(1, (frameRate * 60) / maxBpm);
  const maxLag = Math.max(minLag + 1, (frameRate * 60) / minBpm);
  const iMinLag = Math.max(1, Math.floor(minLag));
  const iMaxLag = Math.ceil(maxLag);

  const x = standardize(envelope);
  const acf = autocorrelate(x, iMinLag, iMaxLag);

  let maxAcf = 0;
  for (let l = iMinLag; l <= iMaxLag; l++) if (acf[l] > maxAcf) maxAcf = acf[l];

  // Evaluate the whole range on the log lattice.
  const lattice = [];
  const ratio = Math.log2(maxBpm / minBpm);
  for (let i = 0; i < latticeSteps; i++) {
    const bpm = minBpm * Math.pow(2, (ratio * i) / (latticeSteps - 1));
    const lag = (frameRate * 60) / bpm;
    const r = acfAt(acf, lag, iMinLag, iMaxLag);
    lattice.push({
      bpm,
      lag,
      acf: r,
      acfNorm: maxAcf > 0 ? r / maxAcf : 0,
      score: Math.log1p(1e6 * r) + logTempoPrior(bpm, priorCentre, priorStd),
    });
  }

  // Non-maximum suppression: take the top few peaks, each at least 6% away in
  // tempo from an already-taken one, so we get distinct candidates rather than
  // several samples off the same peak.
  const byScore = [...lattice].sort((a, b) => b.score - a.score);
  const seeds = [];
  for (const c of byScore) {
    if (seeds.length >= peaks) break;
    if (seeds.some((s) => Math.abs(Math.log2(c.bpm / s.bpm)) < Math.log2(1.06))) continue;
    seeds.push(c);
  }

  // Expand each seed across the metrical ratios, then dedupe.
  const out = [];
  const seen = new Set();
  const push = (bpm, seed) => {
    if (bpm < minBpm || bpm > maxBpm) return;
    const key = Math.round((frameRate * 60) / bpm); // the DP quantises to whole frames anyway
    if (seen.has(key)) return;
    seen.add(key);
    const lag = (frameRate * 60) / bpm;
    const r = acfAt(acf, lag, iMinLag, iMaxLag);
    out.push({
      bpm,
      lag,
      acf: r,
      acfNorm: maxAcf > 0 ? r / maxAcf : 0,
      logPrior: logTempoPrior(bpm, priorCentre, priorStd),
      score: Math.log1p(1e6 * r) + logTempoPrior(bpm, priorCentre, priorStd),
      fromSeed: seed.bpm,
    });
  };

  for (const seed of seeds) {
    for (const ratioMul of METRICAL_RATIOS) push(seed.bpm * ratioMul, seed);
  }
  out.sort((a, b) => b.score - a.score);
  const candidates = out.slice(0, maxCandidates);

  const best = seeds[0] ?? lattice[0];
  return {
    candidates,
    acf,
    maxAcf,
    minLag: iMinLag,
    maxLag: iMaxLag,
    seedBpm: best?.bpm ?? PRIOR_CENTRE_BPM,
    contrast: best ? peakContrast(acf, Math.round(best.lag), iMinLag, iMaxLag, 0.15) : 1,
  };
}

/**
 * How tall the winning ACF peak is relative to the rest of the search range,
 * ignoring a band around the peak itself. ~1 means "no peak at all, the ACF is
 * flat" — which is the honest answer for ambient material with no pulse.
 */
export function peakContrast(acf, lag, minLag, maxLag, excludeFrac) {
  const lo = lag * (1 - excludeFrac);
  const hi = lag * (1 + excludeFrac);
  let sum = 0;
  let count = 0;
  for (let l = minLag; l <= maxLag; l++) {
    if (l >= lo && l <= hi) continue;
    sum += Math.max(0, acf[l]);
    count++;
  }
  if (count === 0) return 1;
  const baseline = sum / count;
  const peak = Math.max(0, acf[lag]);
  if (baseline <= 1e-12) return peak > 0 ? 4 : 1;
  return peak / baseline;
}

/**
 * Explicit half/double comparison, kept as a diagnostic on top of the prior.
 *
 * The prior already decides the octave — this just records BY HOW MUCH, so a
 * near-tie between a tempo and its double can be surfaced as low confidence
 * rather than passed off as certainty. Returns the winning score minus the
 * best of its half/double neighbours; large is confident, near zero is a
 * coin-flip between octaves.
 */
export function octaveComparison(scores, lag, minLag, maxLag) {
  const at = (l) => {
    const r = Math.round(l);
    return r >= minLag && r <= maxLag && Number.isFinite(scores[r]) ? scores[r] : -Infinity;
  };
  const rival = Math.max(at(lag / 2), at(lag * 2));
  if (!Number.isFinite(rival)) return Infinity; // no octave rival is in range
  return scores[lag] - rival;
}

/**
 * Weighted least-squares fit of a uniform grid to a set of beat times.
 *
 * The DP tracker returns beat FRAMES, quantised to the 11.6ms hop. That is far
 * too coarse for the ±1.5 BPM the fixtures demand — a half-frame error per beat
 * is ~2 BPM at 174. Regressing time against beat ordinal over the whole track
 * averages that quantisation down to almost nothing, and it is robust to the
 * tracker dropping or adding an occasional beat because indices are reassigned
 * from the fitted period on each pass.
 *
 * @param {Array<{t:number, w:number}>} points beat observations
 * @param {number} seedPeriod initial period estimate, seconds
 * @returns {{period:number, offset:number, residual:number, used:number}}
 */
export function fitGrid(points, seedPeriod) {
  if (points.length < 2) {
    return { period: seedPeriod, offset: points[0]?.t ?? 0, residual: Infinity, used: points.length };
  }

  let period = seedPeriod;
  let offset = points[0].t;
  let residual = Infinity;
  let used = 0;

  for (let pass = 0; pass < 4; pass++) {
    // Assign each observation to its nearest grid index under the current fit.
    const ks = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      ks[i] = Math.round((points[i].t - offset) / period);
    }

    let sw = 0;
    let swk = 0;
    let swt = 0;
    let swkk = 0;
    let swkt = 0;
    for (let i = 0; i < points.length; i++) {
      const w = points[i].w;
      const k = ks[i];
      const t = points[i].t;
      sw += w;
      swk += w * k;
      swt += w * t;
      swkk += w * k * k;
      swkt += w * k * t;
    }
    const denom = sw * swkk - swk * swk;
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) break;

    const b = (sw * swkt - swk * swt) / denom;
    const a = (swt - b * swk) / sw;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) break;

    period = b;
    offset = a;

    let err = 0;
    for (let i = 0; i < points.length; i++) {
      const d = points[i].t - (a + b * ks[i]);
      err += points[i].w * d * d;
    }
    residual = Math.sqrt(err / sw);
    used = points.length;
  }

  return { period, offset, residual, used };
}

/**
 * How well a beat grid explains the detected onsets.
 *
 * This is a strength-weighted F-measure of two complementary quantities, and
 * the pairing is deliberate — each half catches one direction of octave error:
 *
 *  - `support`: of all the grid positions, what fraction have an onset on them?
 *    Halving the period (doubling the tempo) leaves every other grid position
 *    empty, so support collapses.
 *  - `coverage`: of all the onset energy, what fraction sits on a grid position?
 *    Doubling the period (halving the tempo) leaves half the onsets unexplained,
 *    so coverage collapses.
 *
 * Their harmonic mean is therefore high only for a grid that is both fully
 * supported and fully explanatory.
 *
 * ## Why support saturates
 *
 * Support is weighted by onset strength, so a grid at HALF the true tempo
 * scores well on it: by landing only on the loudest hits it gets a higher
 * average on-grid strength than the correct grid, which also has to account
 * for the quieter backbeats. Left uncorrected that hands the half-tempo
 * candidate a win — and it did, on the breakbeat fixture, where kicks and
 * snares alternate and the snares read weaker.
 *
 * Saturating support fixes it without giving up the measure. Beyond
 * SUPPORT_SATURATION the grid is simply "well supported" and gets no further
 * credit for being loud, so the comparison falls through to coverage, which is
 * where half tempo genuinely loses (it leaves every other onset unexplained).
 * The musical claim behind the constant: if the average beat carries even half
 * the strength of the track's loudest hits, that grid is real. Demanding more
 * would punish correct grids on any track with unaccented beats — which is
 * most music.
 */
const SUPPORT_SATURATION = 0.55;

export function gridFitScore(gridTimes, onsets, period) {
  if (gridTimes.length === 0 || onsets.length === 0) {
    return { support: 0, coverage: 0, f: 0 };
  }
  const tol = Math.min(0.12 * period, 0.07);

  let supportSum = 0;
  let oi = 0;
  const matched = new Uint8Array(onsets.length);
  for (const g of gridTimes) {
    while (oi < onsets.length && onsets[oi].t < g - tol) oi++;
    let best = 0;
    for (let j = oi; j < onsets.length && onsets[j].t <= g + tol; j++) {
      if (onsets[j].strength > best) best = onsets[j].strength;
      matched[j] = 1;
    }
    supportSum += best;
  }
  const support = supportSum / gridTimes.length;

  let total = 0;
  let hit = 0;
  for (let i = 0; i < onsets.length; i++) {
    total += onsets[i].strength;
    if (matched[i]) hit += onsets[i].strength;
  }
  const coverage = total > 0 ? hit / total : 0;

  const supportTerm = clamp01(support / SUPPORT_SATURATION);
  const f =
    supportTerm + coverage > 0
      ? (2 * supportTerm * coverage) / (supportTerm + coverage)
      : 0;
  return { support, supportTerm, coverage, f };
}

/** Clamp to 0..1. */
export const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/**
 * bpmConfidence, per the contract: the number the renderer gates on before it
 * commits to choreographing rather than just reacting.
 *
 * It answers exactly one question — HOW WELL DOES THIS GRID EXPLAIN THE ONSETS
 * WE ACTUALLY HEARD — via two complementary measurements:
 *
 *  - `hitRate`: of the onset energy in the track, how much of it lands on a
 *    beat? Weighted by strength SQUARED, which is the important detail. Real
 *    music is full of ghost notes, hi-hat sixteenths and off-grid ornaments;
 *    counting them linearly caps this measure around 0.6 even on a track with
 *    a perfectly obvious kick pattern. Squaring makes the measure about the
 *    onsets a listener would call beats, without needing an arbitrary
 *    "is it strong enough" cutoff.
 *
 *  - `support`: what fraction of grid positions have any onset on them at all.
 *    This is the guard against a confident wrong answer. A grid at double the
 *    true tempo has every other position empty, so support halves; and sparse
 *    ambient material has far fewer onsets than any 60-200 BPM grid has slots,
 *    so support collapses no matter which tempo is chosen — which is exactly
 *    the case CONFIDENCE_FLOOR exists to catch.
 *
 * They combine multiplicatively rather than as a weighted sum, so that a
 * catastrophic support score cannot be rescued by a good hit rate.
 */
export function gridExplanation(gridTimes, onsets, period) {
  if (gridTimes.length === 0 || onsets.length === 0) {
    return { hitRate: 0, support: 0, confidence: 0 };
  }
  const tol = Math.min(0.1 * period, 0.06);

  const matched = new Uint8Array(onsets.length);
  let supported = 0;
  let oi = 0;
  for (const g of gridTimes) {
    while (oi < onsets.length && onsets[oi].t < g - tol) oi++;
    let hit = false;
    for (let j = oi; j < onsets.length && onsets[j].t <= g + tol; j++) {
      matched[j] = 1;
      hit = true;
    }
    if (hit) supported++;
  }
  const support = supported / gridTimes.length;

  let total = 0;
  let onGrid = 0;
  for (let i = 0; i < onsets.length; i++) {
    const w = onsets[i].strength * onsets[i].strength;
    total += w;
    if (matched[i]) onGrid += w;
  }
  const hitRate = total > 0 ? onGrid / total : 0;

  // Support saturates: real tracks have unaccented beats and quiet intros, so
  // demanding an onset on literally every grid position would punish honest
  // grids. Three quarters of positions covered is already conclusive.
  const supportTerm = 0.25 + 0.75 * clamp01(support / 0.75);
  return { hitRate, support, confidence: clamp01(hitRate * supportTerm) };
}
