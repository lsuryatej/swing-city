# swing-city

> **Picking this up after a break? Read [HANDOFF.md](HANDOFF.md) first** — it
> covers current status, the four open analyser bugs with their measured
> baseline, and decisions already settled.

An audio-reactive web experience: a web-slinging figure whose swing is
choreographed to the music, not merely reacting to it.

Bring your own track by dropping a file on the page, or pick from the built-in
playlist. Everything runs client-side. Nothing is uploaded.

## How it works

Three stages, connected by one artifact.

**Ingest** decodes the audio to an `AudioBuffer`, from a dropped file or the
curated playlist.

**Analyse** runs offline in a Web Worker, faster than realtime: spectral-flux
onset detection, then the Ellis dynamic-programming beat tracker to recover
tempo, phase, and a full beat grid. The output is a **BeatMap** — the single
object that crosses into the animation half. Curated tracks ship theirs
precomputed; dropped files are analysed once and cached in IndexedDB.

**Perform** plays back and animates. Because the whole beat grid is known
before a note plays, the animation can *plan*: knowing the next release lands
at t=12.30s and the next anchor at t=14.10s, the flight time is fixed, so the
launch velocity and anchor distance are inverse-solved to arrive exactly on the
beat. That planning is what separates this from a visualiser — the character is
choreographed to the track rather than chasing it.

A thin layer of live FFT still runs, but only for texture that doesn't need
planning: glow, particle density, sky wash. Structural timing always comes from
the BeatMap.

### The one trick worth knowing

A pendulum has a natural period set by its length. A song has a tempo. They
don't agree, so pushing the swing on every beat will sometimes push *against*
the motion and kill it — a swing that randomly stalls and reads as a bug.

The fix is to apply the impulse along the current direction of travel:

```js
omega += impulse * Math.sign(omega);
```

Aligned with existing motion by construction, so it can never subtract energy,
at any tempo, on any track, with no BPM matching. Damping bleeds energy back
out, so amplitude tracks musical intensity on its own.

With a precomputed beat map the choreographer can do better than this, but it
remains the fallback whenever tempo confidence is low.

## Running it

```bash
npm install
npm run dev
```

The dev sandbox at `/` runs the simulation against a synthetic metronome with
no audio, for tuning the physics in isolation.

```bash
npm test                 # sim + analyser tests
npm run gen:audio        # regenerate synthetic fixtures with known ground truth
npm run build:beatmaps   # precompute beat maps for the curated playlist
```

## Adding music

See [public/audio/README.md](public/audio/README.md). Drop files in, list them
in the manifest, run `npm run build:beatmaps`. Tracks must be redistributable —
the project is public, so CC0 or CC-BY only.

## Design notes

**Playback uses an `AudioBufferSourceNode`, not an `<audio>` element.** The
element's `currentTime` jitters by tens of milliseconds; the choreographer
solves to ~30ms. Buffer-source position derived from `ctx.currentTime` is
sample-accurate. We already decode the full buffer for analysis, so streaming
buys nothing.

**Analysis DSP is pure JS with no Web Audio dependency**, so it runs under
`node --test` against fixtures with known ground truth, and inside a Worker
where Web Audio isn't reliably available.

**The renderer consumes only `pose.joints`.** The simulation knows nothing
about how it's drawn. That seam is what lets the silhouette be replaced with a
detailed character — or the whole 2D renderer swapped for a 3D one — without
touching physics.

**Character animation is stepped to 12fps** while camera and parallax run at
60. Animating on twos is what the Spider-Verse films do; stepped motion reads
as deliberate style rather than as dropped frames, and it lowers the pose-
quality bar considerably.

## Licence

Source is open. Bundled audio carries its own licences, listed in the manifest
and surfaced in the credits panel.
