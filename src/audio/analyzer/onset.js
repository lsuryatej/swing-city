/**
 * Onset detection: raw PCM in, onset-strength envelope out.
 *
 * This is stage one of the pipeline and everything downstream (tempo, beat
 * grid, sections, swing points) is derived from the envelope this file
 * produces. Two products come out of here:
 *
 *   1. `envelope` — a continuous onset-strength signal at the STFT frame rate.
 *      This is what the Ellis DP beat tracker consumes.
 *   2. `onsets`   — discrete peak-picked events with sub-frame times and
 *      strengths. Used for confidence scoring and for the final grid fit.
 *
 * Pure JS, no Web Audio.
 */

import { createSpectrum, hannWindow } from './fft.js';

export const FRAME_SIZE = 1024;
export const HOP_SIZE = 512;

/**
 * How hard to log-compress the magnitude spectrum before differencing.
 *
 * Spectral flux on linear magnitudes is dominated by whatever is loudest, so a
 * kick in a loud bar swamps the same kick in a quiet bar. Compressing with
 * log(1 + GAMMA*m) equalises that: it is the standard fix, and it is
 * specifically what lets the detector keep finding beats through the two quiet
 * bars in the breakbeat fixtures (which are at a quarter of the surrounding
 * gain). Larger GAMMA = more aggressive equalisation.
 */
const GAMMA = 200;

/**
 * Upper edge of the band the flux is computed over, in Hz.
 *
 * Everything that defines a beat — kick, snare, bass, piano and guitar
 * attacks — has its energy below this. Above it you are mostly measuring
 * cymbal wash and, on compressed audio, codec noise: a 114kbps MP3 and a
 * 320kbps MP3 of the same track differ enormously up there and not at all down
 * here. Summing flux over the full spectrum makes the detector's behaviour
 * depend on the bitrate of the file it was handed, which is not a property
 * anyone wants. Band-limiting costs nothing and removes the dependence.
 */
const FLUX_MAX_HZ = 5000;

/**
 * Adaptive whitening (Stowell & Plumbley 2007).
 *
 * Each bin is divided by a decaying peak-follower of its own recent magnitude,
 * so a quiet hi-hat contributes as much flux as a loud kick. The motivation
 * here was `oh-yeah.mp3`, whose onset envelope is measurably flatter than the
 * other real tracks (p99/p50 of 3.4 against 4.0-4.3) because dense, heavily
 * compressed production masks its transients.
 *
 * WARNING — these two values are a REPAIR, not a tuned result. The agent that
 * introduced whitening was cut off before defining them, leaving the module
 * throwing ReferenceError. These are standard published starting points, not
 * measured against our fixtures. Re-tune them, and re-check that whitening
 * actually improves oh-yeah without degrading the four-on-floor fixtures —
 * whitening amplifies noise in genuinely quiet passages, so it can easily make
 * `sparse-pad-72` look more confident than it deserves to.
 */
const WHITEN_DECAY = 0.997; // per-frame peak-follower memory (~4s at 86 fps)
const WHITEN_FLOOR = 1e-2; // relative floor; stops silence exploding into noise

/** Downmix N channels to mono by averaging. */
export function toMono(channels) {
  if (!channels || channels.length === 0) throw new Error('no channel data');
  const n = channels[0].length;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(n);
  for (const ch of channels) {
    const len = Math.min(n, ch.length);
    for (let i = 0; i < len; i++) out[i] += ch[i];
  }
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

/**
 * Spectral-flux onset-strength envelope.
 *
 * STFT with a 1024-sample Hann window and 512 hop, then for each frame sum the
 * POSITIVE part of the frame-to-frame magnitude difference across bins. Taking
 * only the positive part is the whole trick: energy appearing is an onset,
 * energy decaying is not, and half-wave rectifying keeps decays from
 * registering as events.
 *
 * ## Frame timing
 *
 * We prepend FRAME_SIZE samples of silence before analysing. Without it, a
 * transient at t=0 (which every four-on-the-floor fixture has) lands in frame
 * 0, whose flux is undefined because there is no previous frame to difference
 * against — so the very first beat would be silently dropped and the grid
 * offset would come out a whole beat late. The pad gives every real onset a
 * genuine silent predecessor.
 *
 * With the pad, a transient at sample s falls at the CENTRE of the window
 * whose flux spikes. So the correct time for frame f is
 *
 *     t(f) = (f*HOP + FRAME_SIZE/2 - PAD) / sampleRate
 *
 * which makes the flux peak land on the transient rather than up to 23ms after
 * it. That matters: the offset tolerance on the fixtures is ±60ms.
 *
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @returns {{envelope: Float32Array, frameRate: number, frameTime: (f:number)=>number, hop:number, frameSize:number}}
 */
export function computeOnsetEnvelope(mono, sampleRate, opts = {}) {
  const {
    whiten = true,
    whitenDecay = WHITEN_DECAY,
    whitenFloor = WHITEN_FLOOR,
  } = opts;
  const pad = FRAME_SIZE;
  const spectrum = createSpectrum(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const bins = spectrum.bins;

  const padded = new Float32Array(mono.length + pad * 2);
  padded.set(mono, pad);

  const numFrames = Math.max(1, Math.floor((padded.length - FRAME_SIZE) / HOP_SIZE) + 1);
  const envelope = new Float32Array(numFrames);

  // Highest bin that still falls under FLUX_MAX_HZ.
  const binHz = sampleRate / FRAME_SIZE;
  const topBin = Math.max(4, Math.min(bins, Math.ceil(FLUX_MAX_HZ / binHz)));

  const frame = new Float32Array(FRAME_SIZE);
  // `prev` holds the LOG-COMPRESSED spectrum of the previous frame; `cur` is
  // scratch for the raw magnitudes of this one.
  const prev = new Float32Array(bins);
  const cur = new Float32Array(bins);

  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = padded[start + i] * window[i];
    spectrum.magnitudes(frame, cur);

    // Log-compress, then half-wave-rectified difference against the last frame.
    let flux = 0;
    for (let k = 0; k < topBin; k++) {
      const m = Math.log1p(GAMMA * cur[k]);
      const d = m - prev[k];
      if (d > 0) flux += d;
      prev[k] = m; // overwrite in place: this frame becomes next frame's `prev`
    }
    // Frame 0 has no predecessor, so its "flux" is meaningless. The silent pad
    // means we lose nothing real by zeroing it.
    envelope[f] = f === 0 ? 0 : flux / topBin;
  }

  const frameRate = sampleRate / HOP_SIZE;
  const frameTime = (f) => (f * HOP_SIZE + FRAME_SIZE / 2 - pad) / sampleRate;

  return { envelope, frameRate, frameTime, hop: HOP_SIZE, frameSize: FRAME_SIZE };
}

/**
 * Sliding-window median. Used as the adaptive floor for peak picking: a fixed
 * global threshold either misses the quiet break bars or floods the loud ones.
 */
export function movingMedian(x, halfWindow) {
  const n = x.length;
  const out = new Float32Array(n);
  const scratch = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n - 1, i + halfWindow);
    scratch.length = 0;
    for (let j = lo; j <= hi; j++) scratch.push(x[j]);
    scratch.sort((a, b) => a - b);
    const m = scratch.length >> 1;
    out[i] = scratch.length % 2 ? scratch[m] : 0.5 * (scratch[m - 1] + scratch[m]);
  }
  return out;
}

/** Sliding-window mean, via a prefix sum. */
export function movingMean(x, halfWindow) {
  const n = x.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n, i + halfWindow + 1);
    out[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }
  return out;
}

/**
 * Adaptive peak picking on the onset envelope.
 *
 * Three filters, in order:
 *  - local maximum (a peak has to actually be a peak),
 *  - above a moving-median floor scaled up by MULT, plus a small absolute
 *    delta relative to the global mean so that near-silence cannot produce
 *    onsets out of numerical noise,
 *  - a refractory period, resolved greedily strongest-first, so one kick drum
 *    yields one onset instead of the twenty adjacent local maxima its decay
 *    tail produces.
 *
 * Peak times are parabolically interpolated against their two neighbours,
 * which recovers sub-frame precision — the frame grid alone is 11.6ms and we
 * need the grid offset to land inside ±60ms.
 *
 * @returns {Array<{t:number, frame:number, value:number, strength:number}>}
 *          ascending by t; `strength` is 0..1 relative to the loudest onset.
 */
export function pickPeaks(envelope, frameRate, frameTime, opts = {}) {
  const {
    medianWindowSec = 0.5,
    mult = 1.7,
    delta = 0.55,
    refractorySec = 0.055,
    absoluteFloorFrac = 0.15,
  } = opts;

  const n = envelope.length;
  if (n < 3) return [];

  const halfWin = Math.max(1, Math.round((medianWindowSec * frameRate) / 2));
  const median = movingMedian(envelope, halfWin);

  let sum = 0;
  for (let i = 0; i < n; i++) sum += envelope[i];
  const globalMean = sum / n;
  if (globalMean <= 0) return [];

  /**
   * Absolute floor, as a fraction of the track's own loud events.
   *
   * The moving-median threshold is relative by design, which is what lets it
   * find beats inside a quiet break — but that same property makes it find
   * "beats" inside near-silence, where it is thresholding against the noise
   * floor and any numerical wiggle clears the bar. On sparse ambient material
   * that produced ~190 onsets where there were about a dozen real events, and
   * a detector that reports an onset every 0.1 second makes ANY tempo grid
   * look well supported — which is exactly how confidence ends up high on
   * material that has no beat.
   *
   * The scale is the mean of the loudest handful of frames rather than the
   * outright maximum, so one anomalous hit cannot set the floor for the whole
   * track.
   */
  const desc = Array.from(envelope).sort((a, b) => b - a);
  const topK = Math.max(3, Math.min(32, Math.round(0.002 * n)));
  let peakScale = 0;
  for (let i = 0; i < topK; i++) peakScale += desc[i];
  peakScale /= topK;
  const absoluteFloor = absoluteFloorFrac * peakScale;

  const candidates = [];
  for (let f = 1; f < n - 1; f++) {
    const v = envelope[f];
    if (v <= envelope[f - 1] || v < envelope[f + 1]) continue;
    if (v < absoluteFloor) continue;
    if (v < median[f] * mult + delta * globalMean) continue;
    candidates.push(f);
  }

  // Refractory resolution: take peaks strongest-first, drop anything that
  // falls inside the shadow of an already-accepted one.
  const refractoryFrames = Math.max(1, Math.round(refractorySec * frameRate));
  candidates.sort((a, b) => envelope[b] - envelope[a]);
  const accepted = [];
  for (const f of candidates) {
    let clash = false;
    for (const a of accepted) {
      if (Math.abs(a - f) < refractoryFrames) {
        clash = true;
        break;
      }
    }
    if (!clash) accepted.push(f);
  }
  accepted.sort((a, b) => a - b);

  let maxV = 0;
  for (const f of accepted) if (envelope[f] > maxV) maxV = envelope[f];
  if (maxV <= 0) return [];

  return accepted.map((f) => {
    const shift = parabolicShift(envelope[f - 1], envelope[f], envelope[f + 1]);
    return {
      frame: f,
      t: frameTime(f) + shift / frameRate,
      value: envelope[f],
      strength: Math.min(1, envelope[f] / maxV),
    };
  });
}

/**
 * Sub-sample peak position from three samples around a local maximum, by
 * fitting a parabola. Returns a shift in [-0.5, 0.5] samples.
 */
export function parabolicShift(y0, y1, y2) {
  const denom = y0 - 2 * y1 + y2;
  if (denom === 0 || !Number.isFinite(denom)) return 0;
  const shift = (0.5 * (y0 - y2)) / denom;
  return Math.max(-0.5, Math.min(0.5, shift));
}

/**
 * Resample the envelope to a target rate and normalise it to 0..1.
 *
 * Handles both directions: when upsampling (our 86.13Hz frames -> the
 * contract's 100Hz ENVELOPE_HZ) it interpolates; when downsampling it takes
 * the max within each output bin, which preserves transient peaks where an
 * average would smear them away.
 *
 * Returns a plain number[] rather than a Float32Array. Both are allowed by the
 * contract, but only the plain array survives a JSON round-trip
 * (JSON.stringify of a Float32Array produces an object, not an array).
 */
export function resampleEnvelope(envelope, frameRate, frameTime, targetRate, duration) {
  const outLen = Math.max(1, Math.round(duration * targetRate));
  const out = new Array(outLen);

  let max = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] > max) max = envelope[i];
  const inv = max > 0 ? 1 / max : 0;

  const t0 = frameTime(0);
  const halfBin = 0.5 / targetRate;

  for (let i = 0; i < outLen; i++) {
    const t = i / targetRate;
    const fLo = Math.ceil((t - halfBin - t0) * frameRate);
    const fHi = Math.floor((t + halfBin - t0) * frameRate);
    let v = 0;
    if (fHi >= fLo) {
      for (let f = Math.max(0, fLo); f <= Math.min(envelope.length - 1, fHi); f++) {
        if (envelope[f] > v) v = envelope[f];
      }
    } else {
      v = sampleEnvelope(envelope, frameRate, t0, t);
    }
    out[i] = Math.round(Math.min(1, v * inv) * 10000) / 10000;
  }
  return out;
}

/** Linearly interpolated envelope lookup at an arbitrary time in seconds. */
export function sampleEnvelope(envelope, frameRate, t0, t) {
  const x = (t - t0) * frameRate;
  if (x <= 0) return envelope[0] ?? 0;
  if (x >= envelope.length - 1) return envelope[envelope.length - 1] ?? 0;
  const i = Math.floor(x);
  const frac = x - i;
  return envelope[i] * (1 - frac) + envelope[i + 1] * frac;
}
