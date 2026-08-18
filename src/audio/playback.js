/**
 * Playback + live spectral texture.
 *
 * Plays from an AudioBufferSourceNode rather than an <audio> element. We have
 * already decoded the whole buffer for offline analysis, so there is nothing
 * to gain from streaming, and there is something important to gain from a
 * buffer source: sample-accurate position.
 *
 * An <audio> element's currentTime is updated on a coarse, throttled schedule
 * and jitters by tens of milliseconds. The choreographer inverse-solves web
 * releases to land within ~30ms of a beat, so element-level timing jitter
 * would be plainly visible as the character arriving late or early. Deriving
 * position from ctx.currentTime is exact.
 *
 * The tradeoff is that a source node cannot be paused or seeked. Both are
 * emulated: stop the node and start a fresh one at the new offset. Source
 * nodes are single-use and cheap, so this is the intended pattern, not a hack.
 */

import { audioContext } from './ingest.js';

/** Bass band for live texture, in Hz. Structure comes from the BeatMap; this
 *  is only for continuous visual response (glow, particles, sky wash). */
const BASS_LO = 20;
const BASS_HI = 150;

export function createPlayer() {
  const ctx = audioContext();

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;

  const gain = ctx.createGain();
  gain.gain.value = 0.9;

  gain.connect(analyser);
  analyser.connect(ctx.destination);

  const bins = new Uint8Array(analyser.frequencyBinCount);

  /** @type {AudioBufferSourceNode|null} */
  let node = null;
  /** @type {AudioBuffer|null} */
  let buffer = null;

  // Position bookkeeping. `startedAt` is a ctx.currentTime stamp; `offset` is
  // where in the track that stamp corresponds to.
  let startedAt = 0;
  let offset = 0;
  let playing = false;
  let onEnded = null;

  // Smoothed texture values, updated once per frame by sample().
  let energy = 0;
  let level = 0;

  const binHz = ctx.sampleRate / analyser.fftSize;
  const bassFrom = Math.max(1, Math.floor(BASS_LO / binHz));
  const bassTo = Math.min(bins.length - 1, Math.ceil(BASS_HI / binHz));

  function spawn(at) {
    stopNode();
    // Bind the handler to THIS node, not to the mutable `node` variable.
    //
    // Seeking stops the old source and starts a new one, and the old node's
    // onended fires afterwards. Reading the shared `node` there meant it
    // inspected the NEW node's cancelled flag, saw false, and reported
    // end-of-track — so every scrub advanced the playlist instead of moving
    // within the song. Capturing `n` makes each handler answer only for its
    // own node.
    const n = ctx.createBufferSource();
    n.buffer = buffer;
    n.connect(gain);
    n.onended = () => {
      if (n._cancelled) return; // stopped deliberately by us
      if (node !== n) return; // already superseded
      playing = false;
      onEnded?.();
    };
    n.start(0, at);
    node = n;
    startedAt = ctx.currentTime;
    offset = at;
    playing = true;
  }

  function stopNode() {
    if (!node) return;
    node._cancelled = true;
    try {
      node.stop();
    } catch {
      // already stopped; harmless
    }
    node.disconnect();
    node = null;
  }

  return {
    /** @param {AudioBuffer} buf */
    load(buf) {
      stopNode();
      buffer = buf;
      offset = 0;
      playing = false;
    },

    play(at = null) {
      if (!buffer) return;
      spawn(at ?? offset);
    },

    pause() {
      if (!playing) return;
      offset = this.now();
      stopNode();
      playing = false;
    },

    seek(t) {
      if (!buffer) return;
      const clamped = Math.max(0, Math.min(buffer.duration - 0.01, t));
      if (playing) spawn(clamped);
      else offset = clamped;
    },

    stop() {
      stopNode();
      offset = 0;
      playing = false;
    },

    /** Playback position in seconds. Sample-accurate. */
    now() {
      if (!playing) return offset;
      return offset + (ctx.currentTime - startedAt);
    },

    get playing() {
      return playing;
    },

    get duration() {
      return buffer?.duration ?? 0;
    },

    set volume(v) {
      gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },

    onEnded(fn) {
      onEnded = fn;
    },

    /**
     * Call once per animation frame. Returns live spectral texture for
     * continuous visual response. Structural timing must come from the
     * BeatMap, never from here.
     */
    sample() {
      analyser.getByteFrequencyData(bins);

      let bass = 0;
      for (let i = bassFrom; i <= bassTo; i++) bass += bins[i];
      bass /= (bassTo - bassFrom + 1) * 255;

      let broad = 0;
      for (let i = 0; i < bins.length; i++) broad += bins[i];
      broad /= bins.length * 255;

      // Asymmetric smoothing: rise fast so hits land crisply, fall slowly so
      // the visuals don't flicker between frames.
      energy += (bass - energy) * (bass > energy ? 0.45 : 0.08);
      level += (broad - level) * (broad > level ? 0.35 : 0.06);

      return { energy, level };
    },

    dispose() {
      stopNode();
      analyser.disconnect();
      gain.disconnect();
    },
  };
}
