/**
 * Precomputes a BeatMap for every track in public/audio/manifest.json and
 * writes it to public/audio/beatmaps/<id>.json.
 *
 * Curated tracks then cost a fetch and a decode at runtime but no analysis,
 * so the site is playing within a second of the click instead of after a
 * two-second stall.
 *
 * Decoding uses ffmpeg rather than a node Web Audio shim: it is already on
 * most dev machines, handles every format we might be handed, and keeps this
 * script dependency-free.
 *
 * Usage:
 *   npm run build:beatmaps            # build missing / changed
 *   npm run build:beatmaps -- --force # rebuild everything
 *   npm run build:beatmaps -- --report # print detected tempo per track, no write
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MANIFEST = join(PUBLIC, 'audio', 'manifest.json');
const OUT_DIR = join(PUBLIC, 'audio', 'beatmaps');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const REPORT = args.includes('--report');

const SAMPLE_RATE = 44100;

/** Decode any audio file to mono Float32 PCM via ffmpeg. */
function decodeToMono(path) {
  return new Promise((res, rej) => {
    const ff = spawn('ffmpeg', [
      '-v', 'error',
      '-i', path,
      '-f', 'f32le',        // raw 32-bit float little-endian
      '-ac', '1',           // mono downmix
      '-ar', String(SAMPLE_RATE),
      '-',
    ]);

    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c));
    ff.on('error', () =>
      rej(new Error('ffmpeg not found. Install it: brew install ffmpeg'))
    );
    ff.on('close', (code) => {
      if (code !== 0) return rej(new Error(`ffmpeg failed on ${path}: ${err.trim()}`));
      const buf = Buffer.concat(chunks);
      // Buffer may not be 4-byte aligned at the very end; floor it.
      const n = Math.floor(buf.length / 4);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
      res(out);
    });
  });
}

async function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`No manifest at ${MANIFEST}`);
    process.exit(1);
  }

  let analyze;
  try {
    ({ analyze } = await import('../src/audio/analyzer/index.js'));
  } catch (e) {
    console.error(
      'Could not load the analyser from src/audio/analyzer/index.js.\n' +
        'It may not be built yet.\n  ' +
        e.message
    );
    process.exit(1);
  }

  const { tracks } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!tracks.length) {
    console.log('Manifest is empty. Add tracks to public/audio/manifest.json.');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const rows = [];
  let built = 0;
  let skipped = 0;

  for (const track of tracks) {
    const audioPath = join(PUBLIC, track.url.replace(/^\//, ''));
    const outPath = join(OUT_DIR, `${track.id}.json`);

    if (!existsSync(audioPath)) {
      console.error(`  MISSING  ${track.id} -> ${track.url}`);
      continue;
    }

    if (!FORCE && !REPORT && existsSync(outPath)) {
      // Rebuild only if the audio is newer than its beatmap.
      if (statSync(outPath).mtimeMs >= statSync(audioPath).mtimeMs) {
        skipped++;
        continue;
      }
    }

    process.stdout.write(`  ${track.id} ... `);
    const t0 = Date.now();

    const samples = await decodeToMono(audioPath);
    const beatMap = await analyze([samples], SAMPLE_RATE, () => {});

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${beatMap.bpm.toFixed(1)} BPM  conf ${beatMap.bpmConfidence.toFixed(2)}  ` +
        `${beatMap.swingPoints.length} swings  (${secs}s)`
    );

    rows.push({ id: track.id, ...pick(beatMap) });

    if (!REPORT) {
      // Float32Array does not survive JSON; store the envelope as a plain
      // array and let the client revive it (see src/audio/cache.js).
      writeFileSync(
        outPath,
        JSON.stringify({ ...beatMap, onsetEnvelope: Array.from(beatMap.onsetEnvelope) })
      );
      built++;
    }
  }

  console.log('');
  if (REPORT) {
    console.table(rows);
  } else {
    console.log(`built ${built}, skipped ${skipped} (up to date)`);
  }

  const weak = rows.filter((r) => r.confidence < 0.55);
  if (weak.length) {
    console.log(
      `\n${weak.length} track(s) analysed with low confidence and will run in ` +
        `reactive mode rather than choreographed:\n  ` +
        weak.map((w) => w.id).join('\n  ')
    );
  }
}

function pick(bm) {
  return {
    bpm: Number(bm.bpm.toFixed(1)),
    confidence: Number(bm.bpmConfidence.toFixed(2)),
    offset: Number(bm.offset.toFixed(3)),
    beats: bm.beats.length,
    swings: bm.swingPoints.length,
    duration: Number(bm.duration.toFixed(1)),
  };
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
