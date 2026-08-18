/**
 * Analysis worker — the ONLY file in the audio-analysis subtree allowed to
 * touch worker globals. Everything below it is plain, testable JS.
 *
 * Protocol (see src/contract.js):
 *   in:  { type: 'analyze', channels: Float32Array[], sampleRate: number, id: string }
 *   out: { type: 'progress', id, stage: string, pct: number }
 *        { type: 'done',     id, beatMap: BeatMap }
 *        { type: 'error',    id, message: string }
 *
 * Channel buffers are transferred in, so this worker owns them once they
 * arrive and the caller must not reuse them.
 */

import { analyze } from './analyzer/index.js';

/** Progress is throttled: the analysis reports far more often than any UI needs. */
const PROGRESS_MIN_INTERVAL_MS = 50;

export function handleAnalyzeMessage(data, post) {
  const id = data?.id;
  try {
    if (!data || data.type !== 'analyze') return;
    const { channels, sampleRate, options } = data;
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new Error('analyze: channels must be a non-empty array of Float32Array');
    }

    let lastReport = 0;
    let lastPct = -1;
    const onProgress = (stage, pct) => {
      const now = Date.now();
      // Always let the terminal update through, otherwise the bar can stall
      // just short of complete.
      if (pct < 1 && now - lastReport < PROGRESS_MIN_INTERVAL_MS && pct - lastPct < 0.2) return;
      lastReport = now;
      lastPct = pct;
      post({ type: 'progress', id, stage, pct });
    };

    const beatMap = analyze(channels, sampleRate, onProgress, options ?? {});
    post({ type: 'done', id, beatMap });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

// Only wire up to the worker scope when we are actually in one. Guarding this
// keeps the module importable from Node for tests without pulling in globals
// that do not exist there.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event) => {
    handleAnalyzeMessage(event.data, (msg) => self.postMessage(msg));
  };
}
