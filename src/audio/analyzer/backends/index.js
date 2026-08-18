/**
 * Swappable beat-tracking backends.
 *
 * The tempo/beat stage sits behind this seam so a heavier tracker can be
 * dropped in later without touching the rest of the pipeline. Everything a
 * backend needs arrives as plain numbers, and everything it returns is plain
 * numbers, so a backend can be pure JS, WASM, or a network call.
 *
 * ## The interface
 *
 *   createBeatTracker(name) -> {
 *     name: string,
 *     track(onsetEnvelope, sampleRate, hopSize, context?) -> {
 *       bpm: number,
 *       confidence: number,      // 0..1, compared against CONFIDENCE_FLOOR
 *       offset: number,          // seconds to the first beat of the grid
 *       beats: number[],         // beat times in seconds, ascending
 *       diagnostics?: object     // backend-specific, never load-bearing
 *     }
 *   }
 *
 * ## Backends
 *
 * - `ellis` (default, bundled): the Ellis 2007 DP tracker. ~200 lines, no
 *   runtime dependencies beyond fft.js. This is what ships.
 *
 * - `essentia` (not implemented): essentia.js exposes RhythmExtractor2013,
 *   which is stronger on live/acoustic material with real tempo drift. It is
 *   deliberately NOT the default: it is 2-6MB of WASM against a total JS budget
 *   of roughly 25KB, and for the 4/4 electronic and hip-hop material this site
 *   actually gets fed, the Ellis tracker is expected to be indistinguishable.
 *   If measurement on real tracks says otherwise, implement it here as a
 *   lazy-loaded module and change the default — nothing else has to move.
 */

import { createEllisTracker } from './ellis.js';

/** Backend name -> factory. */
const BACKENDS = {
  ellis: createEllisTracker,
};

export const DEFAULT_BACKEND = 'ellis';

/**
 * @param {string} [name] backend id, defaults to 'ellis'
 * @param {object} [options] passed through to the backend factory
 */
export function createBeatTracker(name = DEFAULT_BACKEND, options = {}) {
  const factory = BACKENDS[name];
  if (!factory) {
    throw new Error(
      `unknown beat tracker backend "${name}" (available: ${Object.keys(BACKENDS).join(', ')})`
    );
  }
  return factory(options);
}

/** Names of the backends compiled into this bundle. */
export function availableBackends() {
  return Object.keys(BACKENDS);
}
