/**
 * Generates synthetic WAV test tracks with KNOWN ground-truth tempo and beat
 * positions, plus a sidecar .truth.json for each.
 *
 * This exists so the beat analyser can be tested against an oracle instead of
 * by ear. If the detector says 128.0 BPM on `four-on-floor-128.wav`, it is
 * right; if it says 64 or 256 it has octave-doubled, which is the single most
 * common failure mode in tempo estimation and must be caught by a test.
 *
 * Usage: node tools/make-test-audio.mjs
 * Output: tests/audio/*.wav + *.truth.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'audio');
const SR = 44100;

// ---- synthesis primitives -------------------------------------------------

/** Kick: pitch-swept sine, 120Hz -> 45Hz, exponential amplitude decay. */
function kick(buf, at, gain = 1) {
  const dur = 0.28;
  const n = Math.floor(dur * SR);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const idx = at + i;
    if (idx >= buf.length) break;
    const t = i / SR;
    const env = Math.exp(-t * 14);
    const freq = 45 + 75 * Math.exp(-t * 30);
    phase += (2 * Math.PI * freq) / SR;
    buf[idx] += Math.sin(phase) * env * gain * 0.9;
  }
}

/** Snare: filtered noise + a 190Hz body tone. */
function snare(buf, at, gain = 1) {
  const dur = 0.18;
  const n = Math.floor(dur * SR);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const idx = at + i;
    if (idx >= buf.length) break;
    const t = i / SR;
    const env = Math.exp(-t * 22);
    const white = Math.random() * 2 - 1;
    last = white * 0.6 + last * 0.4; // cheap lowpass so it isn't pure hiss
    const body = Math.sin(2 * Math.PI * 190 * t) * 0.4;
    buf[idx] += (last + body) * env * gain * 0.5;
  }
}

/** Hat: short bright noise burst. */
function hat(buf, at, gain = 1) {
  const dur = 0.05;
  const n = Math.floor(dur * SR);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const idx = at + i;
    if (idx >= buf.length) break;
    const t = i / SR;
    const env = Math.exp(-t * 70);
    const white = Math.random() * 2 - 1;
    const hp = white - prev; // one-pole highpass -> bright
    prev = white;
    buf[idx] += hp * env * gain * 0.25;
  }
}

/** Sustained bass note, to give the low band something non-percussive. */
function bassNote(buf, at, dur, freq, gain = 1) {
  const n = Math.floor(dur * SR);
  for (let i = 0; i < n; i++) {
    const idx = at + i;
    if (idx >= buf.length) break;
    const t = i / SR;
    const env = Math.min(1, t * 60) * Math.exp(-t * 1.5);
    buf[idx] +=
      (Math.sin(2 * Math.PI * freq * t) * 0.7 +
        Math.sin(4 * Math.PI * freq * t) * 0.2) *
      env * gain * 0.3;
  }
}

// ---- WAV encoding ---------------------------------------------------------

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// ---- track builders -------------------------------------------------------

const S = (sec) => Math.floor(sec * SR);

/** Dead-simple four-on-the-floor. The easiest possible case. */
function fourOnFloor({ bpm, bars = 16 }) {
  const spb = 60 / bpm;
  const dur = bars * 4 * spb;
  const buf = new Float32Array(S(dur));
  const beats = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = b * spb;
    kick(buf, S(t), 1);
    beats.push({ t, strength: 1, index: b, downbeat: b % 4 === 0 });
    if (b % 4 === 2) snare(buf, S(t), 0.9);
    hat(buf, S(t + spb / 2), 0.6);
  }
  return { buf, truth: { bpm, offset: 0, beats, duration: dur } };
}

/** Offset start + syncopation + a quiet break. Closer to real music. */
function breakbeat({ bpm, bars = 16, offset = 0.37 }) {
  const spb = 60 / bpm;
  const dur = offset + bars * 4 * spb + 1;
  const buf = new Float32Array(S(dur));
  const beats = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = offset + b * spb;
    const bar = Math.floor(b / 4);
    const inBreak = bar >= 8 && bar < 10; // two quiet bars
    const gain = inBreak ? 0.25 : 1;
    const isDown = b % 4 === 0;
    if (isDown || b % 4 === 2) kick(buf, S(t), gain);
    if (b % 4 === 1 || b % 4 === 3) snare(buf, S(t), gain * 0.85);
    hat(buf, S(t + spb / 2), gain * 0.5);
    if (!inBreak && b % 8 === 5) kick(buf, S(t + spb * 0.5), 0.7); // syncopation
    if (isDown) bassNote(buf, S(t), spb * 3.5, 55 * (bar % 4 === 3 ? 1.19 : 1), gain);
    beats.push({
      t,
      strength: inBreak ? 0.3 : isDown ? 1 : 0.6,
      index: b,
      downbeat: isDown,
    });
  }
  return { buf, truth: { bpm, offset, beats, duration: dur } };
}

/** Ambient-ish: weak transients, sustained tones. The hard case — the
 *  detector is allowed to report low confidence here, but must not crash
 *  or confidently report a wrong grid. */
function sparsePad({ bpm, bars = 8 }) {
  const spb = 60 / bpm;
  const dur = bars * 4 * spb;
  const buf = new Float32Array(S(dur));
  const beats = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = b * spb;
    if (b % 8 === 0) kick(buf, S(t), 0.45);
    if (b % 4 === 0) bassNote(buf, S(t), spb * 4, 48 + (b % 16), 0.9);
    beats.push({ t, strength: b % 8 === 0 ? 0.5 : 0.15, index: b, downbeat: b % 4 === 0 });
  }
  return { buf, truth: { bpm, offset: 0, beats, duration: dur } };
}

// ---- main -----------------------------------------------------------------

const TRACKS = [
  ['four-on-floor-128', fourOnFloor({ bpm: 128 })],
  ['four-on-floor-90', fourOnFloor({ bpm: 90 })],
  ['four-on-floor-174', fourOnFloor({ bpm: 174 })],
  ['breakbeat-140-offset', breakbeat({ bpm: 140 })],
  ['breakbeat-100-offset', breakbeat({ bpm: 100, offset: 0.81 })],
  ['sparse-pad-72', sparsePad({ bpm: 72 })],
];

mkdirSync(OUT, { recursive: true });

for (const [name, { buf, truth }] of TRACKS) {
  // soft-clip guard so summed hits never wrap
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i]);
  writeFileSync(join(OUT, `${name}.wav`), encodeWav(buf, SR));
  writeFileSync(
    join(OUT, `${name}.truth.json`),
    JSON.stringify({ name, sampleRate: SR, ...truth }, null, 2)
  );
  console.log(
    `${name}.wav  ${truth.duration.toFixed(1)}s  ${truth.bpm} BPM  ${truth.beats.length} beats`
  );
}
console.log(`\nwrote ${TRACKS.length} tracks to tests/audio/`);
