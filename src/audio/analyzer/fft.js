/**
 * Thin adapter around `fft.js` (MIT, Fedor Indutny) — a well-tested radix-4
 * FFT that runs unmodified in Node and in a Web Worker.
 *
 * Why a library rather than a hand-rolled transform: the FFT is the one part
 * of this pipeline that is completely solved. We keep an adapter layer only so
 * the rest of the analyser talks in terms of "give me the magnitude spectrum
 * of this windowed frame" and never has to know about interleaved complex
 * arrays or which library is underneath.
 *
 * Still ZERO Web Audio dependency, which is the constraint that matters: the
 * analyser has to run under `node --test` against WAV fixtures (no
 * AudioContext) and inside a Worker (where OfflineAudioContext / AnalyserNode
 * are not reliably available across browsers).
 */

import FFT from 'fft.js';

/**
 * Build a reusable real-input spectrum analyser of a fixed size.
 *
 * `fft.js` wants power-of-two sizes and interleaved complex output
 * ([re0, im0, re1, im1, ...]). Its `realTransform` fills only the first half
 * of the spectrum, which is exactly the non-redundant part we want for real
 * input — so we never call `completeSpectrum` and skip that work entirely.
 *
 * @param {number} size Frame size, a power of two.
 */
export function createSpectrum(size) {
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two, got ${size}`);
  }
  const fft = new FFT(size);
  const out = fft.createComplexArray();
  const bins = size / 2 + 1;
  // Scale so a full-scale sinusoid reads ~1.0 regardless of frame size. That
  // keeps the log-compression constant in onset.js frame-size independent.
  const scale = 2 / size;

  /**
   * Magnitude spectrum of one ALREADY-WINDOWED real frame.
   * @param {Float32Array} frame length `size`
   * @param {Float32Array} mag   length `size/2 + 1`, written in place
   */
  function magnitudes(frame, mag) {
    fft.realTransform(out, frame);
    for (let k = 0; k < bins; k++) {
      const re = out[2 * k];
      const im = out[2 * k + 1];
      mag[k] = Math.sqrt(re * re + im * im) * scale;
    }
    return mag;
  }

  return { size, bins, magnitudes };
}

/**
 * Periodic Hann window. Periodic (divide by n) rather than symmetric
 * (divide by n-1) because this is overlap analysis, not filter design — the
 * periodic form is what makes 50%-overlap frames sum to a constant.
 */
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}
