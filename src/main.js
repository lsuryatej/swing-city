/**
 * The integration layer: audio -> beat map -> choreography -> render.
 *
 * Everything else in this project is a component that works alone. This is
 * where they meet, and it is the whole idea:
 *
 *     player.now()  ->  next SwingPoint from the BeatMap
 *                   ->  swinger.update()   (inverse-solves the release)
 *                   ->  renderer.render()
 */

import { CONFIDENCE_FLOOR } from './contract.js';
import { audioContext, unlock, loadFile, loadTrack, isProbablyAudio } from './audio/ingest.js';
import { createPlayer } from './audio/playback.js';
import { analyzeInWorker } from './audio/analyze-client.js';
import { loadPlaylist } from './playlist.js';
import { createSwinger } from './sim/grapple.js';
import { createRenderer } from './render/canvas.js';

import { DEFAULT_DENSITY } from './contract.js';
const SWING_DENSITY = DEFAULT_DENSITY;

/** How far ahead the choreographer is told about the next release. Beyond
 *  this the sim ignores it, so there is no benefit to a longer horizon. */
const LOOKAHEAD = 4.0;

const el = (id) => document.getElementById(id);

const dom = {
  stage: el('stage'),
  overlay: el('overlay'),
  enter: el('enter'),
  status: el('status'),
  bar: el('bar'),
  panel: el('panel'),
  title: el('title'),
  artist: el('artist'),
  tracks: el('tracks'),
  playPause: el('play-pause'),
  prev: el('prev'),
  next: el('next'),
  seek: el('seek'),
  drop: el('drop'),
  mode: el('mode'),
  art: el('art'),
  elapsed: el('elapsed'),
  total: el('total'),
  ppIcon: el('pp-icon'),
  bpm: el('bpm'),
};

/** SVG path data for the play/pause glyph — one <path> that swaps shape. */
const ICON_PLAY = 'M8 5l11 7-11 7z';
const ICON_PAUSE = 'M9 5v14M16 5v14';

const mmss = (t) => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/**
 * Show a cover if we have one, otherwise fall back to the generated gradient.
 *
 * Curated tracks get art from the manifest; dropped files get it from their
 * ID3 APIC frame. Either way a missing cover is normal, not an error — the
 * gradient is a designed state, not a broken image.
 */
function setArtwork(url) {
  if (url) {
    dom.art.style.backgroundImage = `url("${url}")`;
    dom.art.style.backgroundSize = 'cover';
    dom.art.style.backgroundPosition = 'center';
    dom.art.classList.add('has-art');
  } else {
    dom.art.style.backgroundImage = '';
    dom.art.classList.remove('has-art');
  }
}

/** Keeps the button glyph, the aria-label and the spinning artwork in sync. */
function setPlayingUI(playing) {
  dom.ppIcon?.setAttribute('d', playing ? ICON_PAUSE : ICON_PLAY);
  dom.playPause?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  dom.panel.classList.toggle('playing', playing);
}

const state = {
  player: null,
  swinger: null,
  renderer: null,
  beatMap: null,
  playlist: [],
  index: -1,
  /** Pointer into beatMap.swingPoints, advanced monotonically. */
  swingCursor: 0,
  /** Pointer into beatMap.beats, for the reactive fallback pulse. */
  beatCursor: 0,
  choreographed: true,
  lastFrame: 0,
  running: false,
  loading: false,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Honour the OS setting. The sandbox has always done this; the actual site
 * never did, which was a real gap and became an urgent one once the beat
 * accents went in — those are the parts someone with vestibular sensitivity
 * most needs a way out of.
 *
 * Read live rather than once: people change this setting because something on
 * screen is already bothering them, and a page that only checks at boot makes
 * them reload to escape.
 */
const reducedMotionQuery =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

async function boot() {
  state.renderer = createRenderer(dom.stage, {
    reducedMotion: !!reducedMotionQuery?.matches,
  });
  reducedMotionQuery?.addEventListener?.('change', (e) => {
    state.renderer.setOption('reducedMotion', e.matches);
  });
  // The grapple targets real roofs, so it needs the city's building lookup.
  // Without this it falls back to anchors in empty sky, which is what made the
  // pendulum build feel abstract.
  state.swinger = createSwinger({
    buildingsAheadOf: state.renderer.city.buildingsAheadOf,
  });
  state.renderer.resize();

  window.addEventListener('resize', () => state.renderer.resize());

  // Render immediately, before any audio exists, so the city is behind the
  // entry overlay rather than a black screen.
  state.lastFrame = performance.now();
  state.running = true;
  requestAnimationFrame(frame);

  state.playlist = await loadPlaylist();
  renderTrackList();

  // Dev handle for poking at live state from the console. Stripped in prod.
  if (import.meta.env?.DEV) window.__swing = state;

  dom.enter.addEventListener('click', onEnter, { once: true });
  wireDropTarget();
  wireTransport();
}

async function onEnter() {
  dom.enter.disabled = true;
  try {
    await unlock();
  } catch (e) {
    setStatus(`Audio blocked: ${e.message}`);
    dom.enter.disabled = false;
    return;
  }

  state.player = createPlayer();
  state.player.onEnded(() => selectIndex(state.index + 1));

  dom.overlay.classList.add('hidden');
  dom.panel.classList.remove('hidden');

  if (state.playlist.length) selectIndex(0);
  else setStatus('Drop an audio file to begin');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function setStatus(text, pct = null) {
  dom.status.textContent = text;
  dom.bar.style.width = pct === null ? '0%' : `${Math.round(pct * 100)}%`;
  dom.bar.style.opacity = pct === null ? '0' : '1';
}

const onProgress = (stage, pct) => setStatus(stage, pct);

async function selectIndex(i) {
  if (!state.playlist.length) return;
  const idx = ((i % state.playlist.length) + state.playlist.length) % state.playlist.length;
  state.index = idx;
  await load(() => loadTrack(state.playlist[idx], onProgress, analyzeFor));
  renderTrackList();
}

async function loadDroppedFile(file) {
  state.index = -1;
  await load(() => loadFile(file, onProgress, analyzeFor));
  renderTrackList();
}

const analyzeFor = (channels, sampleRate, cb) =>
  analyzeInWorker(channels, sampleRate, cb, { density: SWING_DENSITY });

async function load(fn) {
  if (state.loading) return;
  state.loading = true;
  state.player?.stop();

  try {
    const { buffer, beatMap, meta, fromCache } = await fn();

    state.beatMap = beatMap;
    state.swingCursor = 0;
    state.beatCursor = 0;
    state.choreographed = beatMap.bpmConfidence >= CONFIDENCE_FLOOR;

    setArtwork(meta.art);
    dom.title.textContent = meta.title;
    dom.artist.textContent = meta.artist;
    // The mode readout folded into the time line when the panel became a
    // single-row pill. Optional-chained because the element no longer exists
    // in the markup — writing to it unguarded threw and aborted the rest of
    // load(), which is why the play button stayed stuck on "play".
    dom.mode?.classList.toggle('warn', !state.choreographed);
    dom.bpm.textContent = state.choreographed
      ? `${beatMap.bpm.toFixed(0)} BPM`
      : `${beatMap.bpm.toFixed(0)} BPM · reactive`;
    dom.bpm.classList.toggle('warn', !state.choreographed);

    state.player.load(buffer);
    state.player.play(0);
    setStatus('');
    dom.total.textContent = mmss(buffer.duration);
    setPlayingUI(true);
    // Selecting from the list should close it, the way a picker does.
    dom.panel.classList.remove('open');
  } catch (e) {
    setStatus(e.message);
    console.error(e);
  } finally {
    state.loading = false;
  }
}

// ---------------------------------------------------------------------------
// The frame loop
// ---------------------------------------------------------------------------

function frame(t) {
  if (!state.running) return;
  requestAnimationFrame(frame);

  // Clamp dt so a background tab or a GC pause cannot teleport the sim. The
  // integrator has its own fixed-step accumulator, but feeding it a 3-second
  // delta would still burn thousands of steps in one frame.
  const dt = Math.min((t - state.lastFrame) / 1000, 0.1);
  state.lastFrame = t;

  const player = state.player;
  const bm = state.beatMap;

  let input;
  if (player && bm && player.playing) {
    const now = player.now();
    const { energy } = player.sample();

    input = {
      now,
      energy,
      nextSwing: state.choreographed ? nextSwingAt(bm, now) : null,
      // Always supply the beat pulse. The swing model fires on beats, not on
      // the sparse swing points — see the comment in grapple.js fixedStep.
      beatPulse: beatPulseAt(bm, now),
    };
  } else {
    // Idle: no audio yet, or paused. Keep the sim alive on a slow neutral
    // rhythm so the city is never a still image behind the overlay.
    input = { now: t / 1000, energy: 0.12, nextSwing: null, beatPulse: false };
  }

  state.swinger.update(dt, input);
  // The renderer used to receive only { pose, dt, energy }. energy is a
  // SMOOTHED signal, so every visual accent it drove was merely correlated
  // with the beat rather than locked to it — which is why the choreography was
  // audible but not visible. beatPulse is the grid itself.
  state.renderer.render({
    pose: state.swinger.pose,
    dt,
    energy: input.energy,
    beatPulse: input.beatPulse,
  });

  if (player?.playing) updateSeek(player);
}

/**
 * The next release the character should be flying toward.
 *
 * The cursor only ever moves forward, so this is O(1) amortised rather than a
 * search every frame. A seek backwards resets it (see wireTransport).
 */
function nextSwingAt(bm, now) {
  const pts = bm.swingPoints;
  while (state.swingCursor < pts.length && pts[state.swingCursor].t < now - 0.05) {
    state.swingCursor++;
  }
  const p = pts[state.swingCursor];
  if (!p) return null;
  return p.t - now <= LOOKAHEAD ? p : null;
}

/** Reactive fallback: true on the single frame a beat crosses. */
function beatPulseAt(bm, now) {
  const beats = bm.beats;
  let pulsed = false;
  while (state.beatCursor < beats.length && beats[state.beatCursor].t <= now) {
    state.beatCursor++;
    pulsed = true;
  }
  return pulsed;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function renderTrackList() {
  dom.tracks.innerHTML = '';
  state.playlist.forEach((t, i) => {
    const li = document.createElement('li');
    li.textContent = t.title;
    li.className = i === state.index ? 'active' : '';
    li.addEventListener('click', () => selectIndex(i));
    dom.tracks.appendChild(li);
  });
}

/** True while the user is dragging the seek thumb. */
let scrubbing = false;

function updateSeek(player) {
  const d = player.duration || 1;
  const now = player.now();
  // Do not fight the user's finger: writing the playhead back into the input
  // every frame yanks the thumb out from under a drag.
  if (!scrubbing) dom.seek.value = String((now / d) * 1000);
  dom.elapsed.textContent = mmss(now);
}

function wireTransport() {
  dom.playPause.addEventListener('click', () => {
    const p = state.player;
    if (!p) return;
    if (p.playing) {
      p.pause();
      setPlayingUI(false);
    } else {
      p.play();
      setPlayingUI(true);
    }
  });

  // Artwork doubles as the playlist toggle; the list is hidden by default so
  // the player stays a single quiet row over the animation.
  dom.art.addEventListener('click', () => dom.panel.classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (!dom.panel.contains(e.target)) dom.panel.classList.remove('open');
  });

  dom.prev.addEventListener('click', () => selectIndex(state.index - 1));
  dom.next.addEventListener('click', () => selectIndex(state.index + 1));

  dom.seek.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  const endScrub = () => {
    scrubbing = false;
  };
  dom.seek.addEventListener('pointerup', endScrub);
  dom.seek.addEventListener('pointercancel', endScrub);
  window.addEventListener('pointerup', endScrub);

  dom.seek.addEventListener('input', () => {
    const p = state.player;
    if (!p) return;
    p.seek((Number(dom.seek.value) / 1000) * p.duration);
    // Cursors are monotonic, so a seek must rewind them.
    state.swingCursor = 0;
    state.beatCursor = 0;
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && state.player) {
      e.preventDefault();
      dom.playPause.click();
    }
  });
}

function wireDropTarget() {
  const show = (on) => dom.drop.classList.toggle('over', on);

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    show(true);
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) show(false);
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    show(false);
    const file = [...(e.dataTransfer?.files ?? [])].find(isProbablyAudio);
    if (!file) return setStatus('That does not look like an audio file');
    if (!state.player) await onEnter();
    loadDroppedFile(file);
  });
}

boot();
