/**
 * Public entry point for offline audio analysis.
 *
 *   analyze(channels, sampleRate, onProgress) -> BeatMap
 *
 * Raw PCM in, the contract's BeatMap out. No Web Audio API anywhere in this
 * subtree: the pipeline has to run under `node --test` against WAV fixtures and
 * inside a Web Worker, and OfflineAudioContext / AnalyserNode are available in
 * neither reliably. The only external dependency is fft.js (MIT).
 *
 * Stages:
 *   1. downmix to mono
 *   2. spectral-flux onset envelope + adaptive peak picking   (onset.js)
 *   3. Ellis 2007 DP beat tracking, behind a swappable seam   (backends/)
 *   4. beats, sections, swing points                          (beatmap.js)
 */

import { ENVELOPE_HZ, swingGaps, DEFAULT_DENSITY } from '../../contract.js';
import {
  toMono,
  computeOnsetEnvelope,
  pickPeaks,
  resampleEnvelope,
  HOP_SIZE,
} from './onset.js';
import { createBeatTracker, DEFAULT_BACKEND } from './backends/index.js';
import { beatStrengths, buildBeats, buildSections, selectSwingPoints } from './beatmap.js';

export const SCHEMA_VERSION = 1;

/**
 * How much to damp the strength of beats the tracker extrapolated rather than
 * observed. Low enough that the swing-point DP treats them as a last resort,
 * non-zero because a quiet intro still has a pulse worth moving to.
 */
const EXTRAPOLATED_BEAT_DAMPING = 0.35;

/**
 * Canonical rate every analysis runs at, regardless of the source. See the
 * comment in analyze() for why this exists.
 */
export const ANALYSIS_SAMPLE_RATE = 44100;

/**
 * Linear-interpolation resample.
 *
 * Crude by audio-playback standards — a proper job would low-pass first to
 * stop content above the new Nyquist aliasing down. It is fine here because
 * the only consumer is a spectral-flux envelope band-limited to 5kHz, well
 * below this rate's 11kHz Nyquist, and because onset detection cares about
 * where energy *changes*, not about its exact spectral content. Using a real
 * polyphase filter would cost noticeably more and change nothing downstream.
 */
export function resampleTo(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = src | 0;
    const i1 = i0 + 1 < input.length ? i0 + 1 : i0;
    const f = src - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/**
 * @param {Float32Array[]} channels    de-interleaved PCM, one array per channel
 * @param {number} sampleRate
 * @param {(stage: string, pct: number) => void} [onProgress]
 * @param {object} [options]
 * @param {string} [options.backend] beat-tracker backend id, default 'ellis'
 * @returns {import('../../contract.js').BeatMap}
 */
export function analyze(channels, sampleRate, onProgress, options = {}) {
  const report = (stage, pct) => {
    if (typeof onProgress === 'function') onProgress(stage, pct);
  };

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`invalid sampleRate: ${sampleRate}`);
  }

  report('decode', 0.02);
  const sourceMono = toMono(channels);
  if (sourceMono.length === 0) throw new Error('empty audio buffer');
  const duration = sourceMono.length / sampleRate;

  // Analysis runs at a CANONICAL rate, never the source rate.
  //
  // Browsers decode at the device AudioContext rate (48kHz on most macOS
  // hardware), while the build-time tool decodes via ffmpeg at 44.1kHz. Same
  // file, two rates, two different beat maps — which would mean a precomputed
  // map never quite matches what the browser would have produced, and results
  // are not reproducible between the CLI and the site. Normalising first makes
  // the analyser a pure function of the audio.
  //
  // 44.1kHz specifically, and NOT something lower.
  //
  // It is tempting to downsample to 22.05kHz for speed, since the flux is
  // band-limited to 5kHz anyway (see FLUX_MAX_HZ) and Nyquist would still be
  // double that. That is wrong, and it cost a debugging round: the onset
  // envelope's frame rate is sampleRate / HOP_SIZE, so halving the rate also
  // halves the envelope's TIME resolution — 86 frames/sec down to 43. Offset
  // recovery is asserted to ±60ms and tempo to ±1.5 BPM; both degrade
  // immediately. Analysis is already ~800x realtime, so there is nothing to buy.
  const mono = resampleTo(sourceMono, sampleRate, ANALYSIS_SAMPLE_RATE);
  const rate = ANALYSIS_SAMPLE_RATE;

  report('onsets', 0.08);
  const { envelope, frameRate, frameTime } = computeOnsetEnvelope(mono, rate);

  report('onsets', 0.45);
  const onsets = pickPeaks(envelope, frameRate, frameTime);

  report('tempo', 0.55);
  const tracker = createBeatTracker(options.backend ?? DEFAULT_BACKEND, options.backendOptions);
  const tracked = tracker.track(envelope, rate, HOP_SIZE, {
    frameTime,
    onsets,
    duration,
  });

  report('beats', 0.78);
  const period = 60 / tracked.bpm;
  const rawStrengths = beatStrengths(tracked.beats, envelope, frameRate, frameTime);

  // Beats the tracker extrapolated through an intro or outro rather than
  // observing directly are damped, so the choreographer treats them as the
  // scaffolding they are. They still exist — the character needs something to
  // swing on during a long quiet intro — but it should not swing hard on them.
  const support = tracked.beatSupport;
  const strengths = support
    ? rawStrengths.map((s, i) => (support[i] ? s : s * EXTRAPOLATED_BEAT_DAMPING))
    : rawStrengths;
  const beats = buildBeats(tracked.beats, strengths);

  report('sections', 0.86);
  const sections = buildSections(mono, rate, duration);

  report('swing', 0.93);
  // Gaps are derived from the detected tempo so the swing rhythm stays locked
  // to musical phrasing rather than to wall-clock seconds. See swingGaps().
  const meter = 4;
  const { minGap, maxGap } = swingGaps(tracked.bpm, meter, options.density ?? DEFAULT_DENSITY);
  const swingPoints = selectSwingPoints(beats, period, {
    sections,
    meter,
    minGap,
    maxGap,
  });

  report('envelope', 0.97);
  const onsetEnvelope = resampleEnvelope(envelope, frameRate, frameTime, ENVELOPE_HZ, duration);

  report('done', 1);

  return {
    version: SCHEMA_VERSION,
    duration,
    sampleRate: rate,
    bpm: tracked.bpm,
    bpmConfidence: tracked.confidence,
    offset: tracked.offset,
    beats,
    sections,
    swingPoints,
    onsetEnvelope,
  };
}

/**
 * Same pipeline, but also returns the intermediate products. Useful for tests
 * and for tuning; not part of the contract and not used by the renderer.
 */
export function analyzeVerbose(channels, sampleRate, options = {}) {
  const mono = toMono(channels);
  const duration = mono.length / sampleRate;
  const { envelope, frameRate, frameTime } = computeOnsetEnvelope(mono, sampleRate);
  const onsets = pickPeaks(envelope, frameRate, frameTime);
  const tracker = createBeatTracker(options.backend ?? DEFAULT_BACKEND, options.backendOptions);
  const tracked = tracker.track(envelope, sampleRate, HOP_SIZE, { frameTime, onsets, duration });
  const beatMap = analyze(channels, sampleRate, undefined, options);
  return { beatMap, envelope, frameRate, frameTime, onsets, tracked };
}

export { createBeatTracker } from './backends/index.js';
