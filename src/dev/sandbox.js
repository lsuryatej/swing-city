/**
 * DEV SANDBOX — runs the simulation and renderer against a synthetic
 * metronome. Zero audio dependency: nothing here imports src/audio, and the
 * whole thing works with the audio half absent or half-finished.
 *
 * The metronome stands in for a BeatMap. It emits beats at the chosen BPM and
 * promotes every Nth beat to a SwingPoint, using the same MIN_SWING_GAP /
 * MAX_SWING_GAP rules from the contract that the real choreographer will, so
 * what you see here is what the real beat map will drive.
 */

import { createSwinger } from '../sim/index.js';
import { createRenderer } from '../render/canvas.js';
import { MIN_SWING_GAP, MAX_SWING_GAP, GRAVITY } from '../contract.js';

const canvas = document.getElementById('stage');
const hud = document.getElementById('hud');
const bpmSlider = document.getElementById('bpm');
const bpmLabel = document.getElementById('bpmLabel');

const prefersReduced =
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const swinger = createSwinger({
  gravity: GRAVITY,
  minWebLength: 180,
  maxWebLength: 620,
  reducedMotion: prefersReduced,
});

const renderer = createRenderer(canvas, {
  reducedMotion: prefersReduced,
  parallax: !prefersReduced,
  onTwos: true,
  debug: false,
});

window.addEventListener('resize', () => renderer.resize());

/* ------------------------------------------------------------------ *
 * Synthetic metronome                                                 *
 * ------------------------------------------------------------------ */

const metro = {
  bpm: 124,
  clock: 0,
  nextBeatT: 0,
  beatIndex: 0,
  /** Upcoming SwingPoints, ascending. Kept two deep. */
  queue: [],
  lastPulse: false,
  lastStrength: 1,
};

/** Beats per swing: the fewest whole beats that clears MIN_SWING_GAP, capped
 *  so we never exceed MAX_SWING_GAP and leave the character hanging. */
function beatsPerSwing(beat) {
  let n = Math.max(1, Math.ceil(MIN_SWING_GAP / beat));
  while (n * beat > MAX_SWING_GAP && n > 1) n--;
  return n;
}

function pumpMetronome(dt) {
  const beat = 60 / metro.bpm;
  metro.clock += dt;
  metro.lastPulse = false;

  while (metro.clock >= metro.nextBeatT) {
    metro.beatIndex++;
    // A four-on-the-floor emphasis pattern, so beat strength varies the way a
    // real onset envelope would.
    const inBar = metro.beatIndex % 4;
    metro.lastStrength = inBar === 0 ? 1 : inBar === 2 ? 0.7 : 0.35;
    metro.lastPulse = true;
    metro.nextBeatT += beat;
  }

  const n = beatsPerSwing(beat);
  const stride = n * beat;

  // Drop points the playhead has already run past. A stale point is worse than
  // no point: the swinger sees a release time in the past and has no room left
  // to wait for a good launch angle.
  while (metro.queue.length && metro.queue[0].tNext <= metro.clock) metro.queue.shift();

  // Keep two queued ahead of the playhead, snapped to the beat grid.
  while (metro.queue.length < 2) {
    const from = metro.queue.length
      ? metro.queue[metro.queue.length - 1].tNext
      : metro.nextBeatT;
    const t = Math.max(from, metro.clock + 0.05);
    metro.queue.push({ t, tNext: t + stride, strength: 0.9 });
  }
  return { beat, stride };
}

/* ------------------------------------------------------------------ *
 * Main loop                                                           *
 * ------------------------------------------------------------------ */

let choreographed = true;
let running = true;
let last = performance.now();
let fps = 60;
let hudAccum = 0;
let released = false;

function frame(nowMs) {
  requestAnimationFrame(frame);
  const rawDt = (nowMs - last) / 1000;
  last = nowMs;
  if (!running) return;

  // The renderer gets the real delta; the simulation clamps internally.
  const dt = Math.min(Math.max(rawDt, 0), 0.25);
  fps += (1 / Math.max(rawDt, 1e-4) - fps) * 0.08;

  pumpMetronome(dt);
  swinger.setBeatInterval(60 / metro.bpm);

  // Offer the head of the queue until the swinger actually consumes it, then
  // advance. This is exactly how a real caller walks BeatMap.swingPoints.
  let nextSwing = null;
  if (choreographed && metro.queue.length) {
    nextSwing = metro.queue[0];
    if (swinger.pose.phase === 'flight') {
      if (!released) {
        released = true;
        metro.queue.shift();
      }
      nextSwing = null;
    } else {
      released = false;
    }
  }

  swinger.update(dt, {
    now: metro.clock,
    energy: metro.lastPulse ? metro.lastStrength : 0.12,
    nextSwing,
    beatPulse: metro.lastPulse,
    beatStrength: metro.lastStrength,
  });

  renderer.render({ pose: swinger.pose, dt });

  hudAccum += dt;
  if (hudAccum > 0.12) {
    hudAccum = 0;
    drawHud();
  }
}

function drawHud() {
  const p = swinger.pose;
  const d = swinger.debug;
  hud.innerHTML =
    `<b>fps</b> ${fps.toFixed(0)}` +
    `<br><b>phase</b> <span class="v">${p.phase}</span>` +
    `<br><b>theta</b> ${p.theta.toFixed(3)} rad` +
    `<br><b>omega</b> ${p.omega.toFixed(3)} rad/s` +
    `<br><b>web</b> ${p.webLength.toFixed(0)} u` +
    `<br><b>bpm</b> ${metro.bpm}` +
    `<br><b>mode</b> ${choreographed ? 'choreographed' : 'reactive'}` +
    `<br><b>arrival err</b> ${(d.arrivalError * 1000).toFixed(1)} ms` +
    `<br><b>speed</b> ${Math.hypot(p.velocity.x, p.velocity.y).toFixed(0)} u/s` +
    `<br><span class="dim">twos ${renderer.options.onTwos ? 'on' : 'off'} · ` +
    `parallax ${renderer.options.parallax ? 'on' : 'off'} · ` +
    `debug ${renderer.options.debug ? 'on' : 'off'}</span>`;
}

/* ------------------------------------------------------------------ *
 * Controls                                                            *
 * ------------------------------------------------------------------ */

bpmSlider.addEventListener('input', () => {
  metro.bpm = Number(bpmSlider.value);
  bpmLabel.textContent = `${metro.bpm} bpm`;
});
metro.bpm = Number(bpmSlider.value);
bpmLabel.textContent = `${metro.bpm} bpm`;

window.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      // Manual impulse. Sign-locked like every other injection, so holding it
      // down can only ever add energy — it can never stall the swing.
      swinger.pulse(0.55);
      break;
    case 'KeyT':
      renderer.setOption('onTwos', !renderer.options.onTwos);
      break;
    case 'KeyP':
      renderer.setOption('parallax', !renderer.options.parallax);
      break;
    case 'KeyD':
      renderer.setOption('debug', !renderer.options.debug);
      break;
    case 'KeyC':
      choreographed = !choreographed;
      break;
    case 'KeyR':
      swinger.reset();
      metro.queue.length = 0;
      break;
    case 'KeyH':
      hud.classList.toggle('hidden');
      break;
    case 'Escape':
      running = !running;
      break;
  }
  drawHud();
});

// Exposed for poking at from the devtools console — this is a dev harness, and
// being able to read the live state without a breakpoint is most of its value.
window.swingCity = { swinger, renderer, metro, get choreographed() { return choreographed; } };

renderer.resize();
drawHud();
requestAnimationFrame(frame);
