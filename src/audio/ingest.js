/**
 * Ingest — turns a source (dropped file or curated playlist entry) into a
 * decoded AudioBuffer plus a BeatMap, using the cache where possible.
 *
 * Deliberately the ONLY module that knows where audio comes from. Adding a
 * source later (a server-side ingest, tab capture) means adding a branch here
 * and touching nothing downstream.
 */

import * as cache from './cache.js';
import { extractCoverArt } from './artwork.js';
import { trackKey, fileKey } from './cache.js';

/** Extensions we'll attempt. Actual support is decided by decodeAudioData. */
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i;

export function isProbablyAudio(file) {
  return file.type.startsWith('audio/') || AUDIO_RE.test(file.name);
}

/**
 * A single shared AudioContext. Created lazily because constructing one before
 * a user gesture leaves it suspended on every browser and permanently muted on
 * some older iOS versions.
 */
let ctx = null;
export function audioContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return ctx;
}

/**
 * Must be called from inside a real user-gesture handler (the entry overlay).
 * Both the resume and a silent one-sample play are needed: iOS Safari will
 * report an AudioContext as 'running' yet stay silent until something has
 * actually been scheduled through it during the gesture.
 */
export async function unlock() {
  const ac = audioContext();
  if (ac.state === 'suspended') await ac.resume();
  const buf = ac.createBuffer(1, 1, ac.sampleRate);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
  src.start(0);
  return ac.state === 'running';
}

/**
 * @typedef {Object} LoadResult
 * @property {AudioBuffer} buffer
 * @property {import('../contract.js').BeatMap} beatMap
 * @property {{title:string, artist:string, id:string}} meta
 * @property {boolean} fromCache Whether analysis was skipped.
 */

/**
 * @param {File} file
 * @param {(stage:string, pct:number)=>void} onProgress
 * @param {(channels:Float32Array[], sampleRate:number, cb:Function)=>Promise<BeatMap>} analyze
 * @returns {Promise<LoadResult>}
 */
export async function loadFile(file, onProgress, analyze) {
  onProgress('reading', 0);
  const [key, bytes] = await Promise.all([fileKey(file), file.arrayBuffer()]);

  // Pull embedded cover art before decode consumes the buffer. Most real MP3s
  // carry an APIC frame, so a dropped file usually arrives with its album.
  const art = extractCoverArt(bytes)?.url ?? null;

  onProgress('decoding', 0.15);
  const buffer = await decode(bytes);

  let beatMap = await cache.get(key);
  if (beatMap) {
    onProgress('ready', 1);
    return { buffer, beatMap, meta: { ...metaFromFile(file, key), art }, fromCache: true };
  }

  onProgress('analysing', 0.3);
  beatMap = await analyze(monoAndCopy(buffer), buffer.sampleRate, (stage, pct) =>
    onProgress(stage, 0.3 + pct * 0.65)
  );
  await cache.put(key, beatMap);

  onProgress('ready', 1);
  return { buffer, beatMap, meta: { ...metaFromFile(file, key), art }, fromCache: false };
}

/**
 * @param {{id:string,url:string,title:string,artist:string,beatMapUrl?:string}} track
 */
export async function loadTrack(track, onProgress, analyze) {
  const key = trackKey(track.id);

  onProgress('fetching', 0);
  const res = await fetch(track.url);
  if (!res.ok) throw new Error(`Could not fetch ${track.title} (${res.status})`);
  const bytes = await res.arrayBuffer();

  onProgress('decoding', 0.2);
  const buffer = await decode(bytes);

  // Curated tracks ship a precomputed BeatMap, so this is normally a hit and
  // the analyser never runs.
  let beatMap = await cache.get(key, track.beatMapUrl);
  if (beatMap) {
    onProgress('ready', 1);
    return { buffer, beatMap, meta: track, fromCache: true };
  }

  onProgress('analysing', 0.35);
  beatMap = await analyze(monoAndCopy(buffer), buffer.sampleRate, (stage, pct) =>
    onProgress(stage, 0.35 + pct * 0.6)
  );
  await cache.put(key, beatMap);

  onProgress('ready', 1);
  return { buffer, beatMap, meta: track, fromCache: false };
}

/**
 * decodeAudioData is callback-based in older Safari and rejects with a bare
 * null rather than an Error, which produces a uselessly empty failure message
 * if you don't normalise it.
 */
function decode(bytes) {
  const ac = audioContext();
  return new Promise((resolve, reject) => {
    const fail = (e) =>
      reject(
        new Error(
          e?.message ||
            'Could not decode this file. Try MP3, M4A, or WAV.'
        )
      );
    const p = ac.decodeAudioData(bytes, resolve, fail);
    if (p && typeof p.then === 'function') p.then(resolve, fail);
  });
}

/**
 * Analysis is mono-only, and the channel arrays are transferred into the
 * worker (not copied), so they must not alias the live AudioBuffer we are
 * about to play from. Downmix into a fresh array and hand that over.
 */
function monoAndCopy(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const chans = Math.min(buffer.numberOfChannels, 2);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (chans > 1) for (let i = 0; i < n; i++) out[i] /= chans;
  return [out];
}

function metaFromFile(file, id) {
  // Best-effort "Artist - Title.mp3" split. ID3 parsing isn't worth a
  // dependency here; the filename is right often enough and the UI degrades
  // gracefully when it isn't.
  const base = file.name.replace(AUDIO_RE, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m
    ? { id, artist: m[1].trim(), title: m[2].trim() }
    : { id, artist: 'Unknown', title: base };
}
