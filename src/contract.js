/**
 * SHARED CONTRACT — the integration surface between the audio half and the
 * animation half. Both sides code against this file and nothing else.
 *
 * Pipeline:
 *   ingest -> AudioBuffer -> analyze (worker) -> BeatMap -> choreograph -> render
 *
 * The BeatMap is the single artifact that crosses the boundary. It is plain
 * JSON: structuredClone-able out of a Worker, JSON.stringify-able into
 * IndexedDB, and eventually producible by a server without the renderer
 * noticing anything changed.
 */

/**
 * @typedef {Object} Beat
 * @property {number} t        Time in seconds from track start.
 * @property {number} strength Normalised 0..1. Height of the onset envelope at
 *                             this beat relative to the track's own dynamic
 *                             range. A four-on-the-floor kick is ~1.0, a weak
 *                             offbeat is ~0.2. Used to rank swing candidates.
 * @property {number} index    Ordinal beat number from the grid start.
 * @property {boolean} downbeat True if this is beat 1 of a bar (assumes 4/4).
 */

/**
 * @typedef {Object} Section
 * @property {number} start    Seconds.
 * @property {number} end      Seconds.
 * @property {number} energy   Mean broadband energy 0..1 across the section.
 * @property {string} label    Free-form: 'intro' | 'build' | 'drop' | 'break' | 'outro'.
 *                             Heuristic only; the renderer treats it as a hint.
 */

/**
 * @typedef {Object} SwingPoint
 * A beat the choreographer has selected as a web-release moment. Pre-filtered
 * so that consecutive points are physically reachable: see MIN_SWING_GAP.
 * @property {number} t        Seconds. Release happens here.
 * @property {number} tNext    Seconds. The following swing point; flight time
 *                             is (tNext - t) and the physics inverse-solves
 *                             launch velocity to land exactly on it.
 * @property {number} strength 0..1, inherited from the source beat.
 */

/**
 * @typedef {Object} BeatMap
 * @property {number} version      Schema version. Currently 1.
 * @property {number} duration     Track length in seconds.
 * @property {number} sampleRate   Of the analysed buffer.
 * @property {number} bpm          Estimated tempo.
 * @property {number} bpmConfidence 0..1. Below CONFIDENCE_FLOOR the renderer
 *                                 should fall back to reactive (non-planned)
 *                                 mode rather than choreographing to a wrong grid.
 * @property {number} offset       Seconds to the first beat of the grid.
 * @property {Beat[]} beats        Full grid, ascending by t.
 * @property {Section[]} sections  Coarse structure, ascending, non-overlapping.
 * @property {SwingPoint[]} swingPoints Chosen release moments, ascending.
 * @property {Float32Array|number[]} onsetEnvelope Downsampled to ENVELOPE_HZ,
 *                                 normalised 0..1. Used for continuous visual
 *                                 response that doesn't need beat granularity.
 */

/** Envelope sample rate in Hz. 100 = 10ms resolution, plenty for visuals. */
export const ENVELOPE_HZ = 100;

/** Below this bpmConfidence, don't choreograph — fall back to reactive mode. */
export const CONFIDENCE_FLOOR = 0.55;

/**
 * Swing spacing is MUSICAL, not absolute.
 *
 * The first version of this used absolute seconds, which is subtly wrong: at
 * 83 BPM a 0.85s floor allows a swing every ~1.2 beats, while at 174 BPM it
 * allows one every ~2.5 beats. The character's rhythm therefore drifted
 * relative to the music purely as a function of tempo, and fast tracks looked
 * frantic while slow ones looked lazy.
 *
 * Expressing the window in BARS keeps the choreography locked to musical
 * phrasing at any tempo. Seconds are derived per track:
 *
 *     barSeconds = (60 / bpm) * meter
 *     minGap     = SWING_DENSITY[d].minBars * barSeconds
 *
 * The physical floor still matters — a release, flight, re-anchor and swing
 * cannot be compressed below roughly 0.8s without reading as a twitch — so
 * ABSOLUTE_MIN_SWING_GAP clamps the derived value on very fast tracks.
 */

/** Named density presets. `default` is the shipping choice. */
export const SWING_DENSITY = {
  /** Busy. Roughly one swing per bar. Reads as urgent, close to parkour. */
  quick: { minBars: 0.75, maxBars: 1.5 },
  /** Slightly longer arcs than quick, still driving. */
  brisk: { minBars: 1, maxBars: 2 },
  /** The middle of the useful range. The shipping choice. */
  balanced: { minBars: 1.25, maxBars: 2.5 },
  /** One swing every ~2 bars. Long readable arcs with real air time. */
  relaxed: { minBars: 1.5, maxBars: 3 },
  /** Slow and floaty. Big cinematic arcs, sparse releases. */
  cinematic: { minBars: 3, maxBars: 5 },
};

/** The shipping density. Chosen by ear against real tracks: `quick` reads as
 *  frantic and `relaxed` leaves the character hanging, so the useful range is
 *  narrow and this sits in the middle of it. */
export const DEFAULT_DENSITY = 'balanced';

/** Hard physical floor in seconds; a swing cycle below this looks like a
 *  twitch regardless of what the music is doing. */
export const ABSOLUTE_MIN_SWING_GAP = 0.8;

/** Hard ceiling in seconds. The character must never hang motionless through
 *  a long quiet passage, even if the bar maths would allow it. */
export const ABSOLUTE_MAX_SWING_GAP = 9.0;

/**
 * Resolve a density preset to concrete second gaps for a given tempo.
 * @param {number} bpm
 * @param {number} meter Beats per bar; 4 unless detected otherwise.
 * @param {keyof typeof SWING_DENSITY | {minBars:number,maxBars:number}} density
 */
export function swingGaps(bpm, meter = 4, density = DEFAULT_DENSITY) {
  const d = typeof density === 'string' ? SWING_DENSITY[density] : density;
  if (!d) throw new Error(`unknown swing density: ${density}`);
  const barSeconds = (60 / bpm) * meter;
  return {
    minGap: Math.max(ABSOLUTE_MIN_SWING_GAP, d.minBars * barSeconds),
    maxGap: Math.min(ABSOLUTE_MAX_SWING_GAP, d.maxBars * barSeconds),
    barSeconds,
  };
}

// Retained so existing imports keep working. Prefer swingGaps().
export const MIN_SWING_GAP = ABSOLUTE_MIN_SWING_GAP;
export const MAX_SWING_GAP = ABSOLUTE_MAX_SWING_GAP;

/**
 * ANALYSIS API — implemented by src/audio/analyze.worker.js
 *
 * Worker message in:
 *   { type: 'analyze', channels: Float32Array[], sampleRate: number, id: string }
 * Worker messages out:
 *   { type: 'progress', id, stage: string, pct: number }
 *   { type: 'done', id, beatMap: BeatMap }
 *   { type: 'error', id, message: string }
 *
 * Channel data is transferred (not copied) — the caller must not reuse the
 * buffers after posting.
 */

/**
 * SIMULATION API — implemented by src/sim/
 *
 * createSwinger({ gravity, minWebLength, maxWebLength }) -> Swinger
 *
 * Swinger.update(dt, input) -> void
 *   dt    seconds since last update, already clamped by the caller.
 *   input {
 *     now:        number,   // playback position in seconds
 *     energy:     number,   // 0..1 live FFT bass, for texture not structure
 *     nextSwing:  SwingPoint|null,  // upcoming release; null in reactive mode
 *     beatPulse:  boolean   // true on the frame a beat fires (reactive fallback)
 *   }
 *
 * Swinger.pose -> Pose   // read-only, consumed by the renderer
 *
 * @typedef {Object} Pose
 * @property {{x:number,y:number}} anchor   Web attachment point, world coords.
 * @property {{x:number,y:number}} hip      Root joint, world coords.
 * @property {number} theta                 Pendulum angle from vertical, radians.
 * @property {number} omega                 Angular velocity, rad/s.
 * @property {number} webLength             Current rope length, world units.
 * @property {'swing'|'flight'|'anchor'} phase
 * @property {Record<string,{x:number,y:number}>} joints
 *           Named joint positions in world coords. Keys:
 *           head, neck, hipC, shoulderL, shoulderR, elbowL, elbowR,
 *           handL, handR, kneeL, kneeR, footL, footR
 *
 * The renderer consumes Pose.joints and nothing else about the simulation.
 * This is the seam that lets the silhouette be swapped for a detailed Miles
 * later without touching physics.
 */

/** World units are pixels at a nominal 1080p; the renderer scales. */
export const WORLD_HEIGHT = 1080;

/** Gravity in world units / s^2, tuned for readable arc timing, not realism. */
export const GRAVITY = 2400;
