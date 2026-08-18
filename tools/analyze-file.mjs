/**
 * Analyse an arbitrary audio file and print a human-readable report.
 *
 * The synthetic fixtures prove the analyser is *correct*. This proves it is
 * *musical* — that the beats it finds are the ones a listener would tap to,
 * and that the chosen swing points feel like the moments the track wants.
 *
 * Usage:
 *   node tools/analyze-file.mjs path/to/track.mp3
 *   node tools/analyze-file.mjs path/to/track.mp3 --clicks out.wav
 *
 * --clicks renders the track with a click on every detected beat and a louder
 * click on every chosen swing point. Listening to that is the only real test:
 * if the clicks sit in the pocket, the grid is right; if they drift or sit
 * between beats, it is wrong regardless of what the numbers say.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { basename, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SR = 44100;

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const clicksAt = args.indexOf('--clicks');
const clicksOut = clicksAt >= 0 ? args[clicksAt + 1] : null;
const densityAt = args.indexOf('--density');
const density = densityAt >= 0 ? args[densityAt + 1] : 'balanced';

if (!path || !existsSync(path)) {
  console.error('Usage: node tools/analyze-file.mjs <audio-file> [--clicks out.wav]');
  process.exit(1);
}

function decodeToMono(p) {
  return new Promise((res, rej) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', p, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-']);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c));
    ff.on('error', () => rej(new Error('ffmpeg not found. brew install ffmpeg')));
    ff.on('close', (code) => {
      if (code !== 0) return rej(new Error(err.trim()));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
      res(out);
    });
  });
}

function encodeWav(samples) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return b;
}

/**
 * Short bright click so it cuts through a dense mix.
 *
 * Beat ticks and swing releases get different pitches and lengths. Judging
 * "is the character in the air long enough" is much easier when the release
 * marker is audibly a different event from the pulse, rather than just a
 * louder version of it.
 */
function click(buf, at, gain, freq = 2600, decay = 180) {
  const n = Math.floor(0.06 * SR);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(at * SR) + i;
    if (idx < 0 || idx >= buf.length) break;
    const t = i / SR;
    buf[idx] += Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * decay) * gain;
  }
}

function histogram(values, buckets = 20) {
  const max = Math.max(...values, 1e-9);
  return values
    .map((v) => Math.round((v / max) * buckets))
    .map((h) => '#'.repeat(h).padEnd(buckets, '.'));
}

const { analyze } = await import(join(ROOT, 'src/audio/analyzer/index.js'));

console.log(`\nAnalysing ${basename(path)} ...`);
const samples = await decodeToMono(path);
const t0 = Date.now();
const bm = await analyze(
  [samples],
  SR,
  (stage, pct) => {
    process.stdout.write(`\r  ${stage} ${Math.round(pct * 100)}%   `);
  },
  { density }
);
process.stdout.write('\r' + ' '.repeat(40) + '\r');

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
const realtimeX = (bm.duration / ((Date.now() - t0) / 1000)).toFixed(0);

console.log(`
  duration     ${bm.duration.toFixed(1)}s
  tempo        ${bm.bpm.toFixed(2)} BPM
  confidence   ${bm.bpmConfidence.toFixed(3)}${bm.bpmConfidence < 0.55 ? '   <-- LOW: falls back to reactive mode' : ''}
  grid offset  ${(bm.offset * 1000).toFixed(0)} ms
  beats        ${bm.beats.length}
  downbeats    ${bm.beats.filter((b) => b.downbeat).length}
  sections     ${bm.sections.length}
  swing points ${bm.swingPoints.length}  (one every ${(bm.duration / Math.max(1, bm.swingPoints.length)).toFixed(2)}s avg)
  analysis     ${elapsed}s  (${realtimeX}x realtime)
`);

// Sanity check the octave. If the detected tempo is out by a factor of two the
// grid still "fits", so the numbers look fine and only this ratio betrays it.
const spb = 60 / bm.bpm;
const gaps = bm.beats.slice(1).map((b, i) => b.t - bm.beats[i].t);
const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
const jitter = Math.sqrt(gaps.reduce((a, g) => a + (g - meanGap) ** 2, 0) / gaps.length);
console.log(`  grid spacing ${meanGap.toFixed(4)}s (expected ${spb.toFixed(4)}s), jitter ${(jitter * 1000).toFixed(1)}ms`);

console.log('\n  sections');
for (const s of bm.sections) {
  console.log(
    `    ${s.start.toFixed(1).padStart(6)}s - ${s.end.toFixed(1).padStart(6)}s  ` +
      `energy ${s.energy.toFixed(2)}  ${s.label}`
  );
}

console.log('\n  swing point spacing (first 24)');
const sp = bm.swingPoints.slice(0, 24);
const spacings = sp.slice(1).map((p, i) => p.t - sp[i].t);
histogram(spacings).forEach((bar, i) =>
  console.log(`    ${sp[i].t.toFixed(2).padStart(7)}s  ${bar}  ${spacings[i].toFixed(2)}s  str ${sp[i].strength.toFixed(2)}`)
);

if (clicksOut) {
  const out = Float32Array.from(samples, (s) => s * 0.5);
  // Beat grid: quiet, high, very short. Just a reference pulse.
  for (const b of bm.beats) click(out, b.t, b.downbeat ? 0.16 : 0.09, 3200, 320);
  // Swing releases: loud, low, ringing. The thing being judged.
  for (const p of bm.swingPoints) click(out, p.t, 0.8, 900, 40);
  writeFileSync(clicksOut, encodeWav(out));
  console.log(`\n  wrote click track -> ${clicksOut}`);
  console.log('  Listen to it. Clicks in the pocket = correct grid.\n');
} else {
  console.log('');
}
