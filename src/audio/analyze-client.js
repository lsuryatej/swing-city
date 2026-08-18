/**
 * Main-thread client for the analysis Worker.
 *
 * Analysis is ~800x realtime, so a 4-minute track resolves in well under a
 * second — but it is still synchronous CPU work, and on the main thread it
 * would stall the very first frames of the animation. Off-thread it costs
 * nothing visible.
 *
 * Falls back to running in-process if Workers are unavailable (some embedded
 * webviews, strict CSPs). The fallback blocks, which is worse but still
 * correct — better a brief stall than a site that does not work at all.
 */

/** @typedef {import('../contract.js').BeatMap} BeatMap */

let worker = null;
let seq = 0;
/** @type {Map<string, {resolve:Function, reject:Function, onProgress:Function}>} */
const pending = new Map();

function ensureWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./analyze.worker.js', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e) => {
      const msg = e.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      if (msg.type === 'progress') {
        entry.onProgress?.(msg.stage, msg.pct);
      } else if (msg.type === 'done') {
        pending.delete(msg.id);
        entry.resolve(msg.beatMap);
      } else if (msg.type === 'error') {
        pending.delete(msg.id);
        entry.reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      // A worker-level error has no id, so fail everything outstanding rather
      // than leaving promises hanging forever.
      for (const [, entry] of pending) entry.reject(new Error(e.message || 'worker failed'));
      pending.clear();
      worker = null;
    };
  } catch {
    worker = false; // sentinel: unavailable, use the in-process fallback
  }
  return worker;
}

/**
 * @param {Float32Array[]} channels Transferred, not copied — do not reuse.
 * @param {number} sampleRate
 * @param {(stage:string, pct:number)=>void} [onProgress]
 * @param {object} [options] e.g. { density: 'balanced' }
 * @returns {Promise<BeatMap>}
 */
export async function analyzeInWorker(channels, sampleRate, onProgress, options = {}) {
  const w = ensureWorker();

  if (!w) {
    const { analyze } = await import('./analyzer/index.js');
    // Yield once so the caller can paint a loading state before we block.
    await new Promise((r) => setTimeout(r, 0));
    return analyze(channels, sampleRate, onProgress, options);
  }

  const id = `a${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage(
      { type: 'analyze', id, channels, sampleRate, options },
      channels.map((c) => c.buffer)
    );
  });
}

export function disposeWorker() {
  if (worker) worker.terminate();
  worker = null;
  pending.clear();
}
