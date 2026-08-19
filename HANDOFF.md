# Handoff

Current as of 2026-08-20. Supersedes all earlier versions of this file.

Read [README.md](README.md) first for what the project *is*. This file is
about where it got to, what is broken, and what to do next.

---

## Start here

```bash
cd ~/swing-city && npm install && npm test && npm run dev
```

Expect **68 pass, 4 fail**. The four failures are pre-existing analyser issues,
documented below, not regressions. If you see a different number, something
changed.

Branches: `main` has the working site. **`spider-verse-render` is ahead** and
has everything from the comic pass onward — that is the live branch.

---

## What the project is

Audio-choreographed web-swinging. Three stages joined by one artifact:

```
ingest -> offline analysis (Worker) -> BeatMap -> performance
```

`src/contract.js` is the integration surface. It is what let the audio half
and the animation half be built in parallel, and it is still the thing to read
before changing anything that crosses that boundary.

The idea that makes it more than a visualiser: **the whole beat grid is known
before a note plays**, so the animation can plan rather than react.

---

## Current state, by area

### Audio — solid

- Spectral-flux onset detection + Ellis 2007 DP beat tracking, behind a
  swappable backend seam (`src/audio/analyzer/backends/`).
- Pure JS + fft.js, no Web Audio in the DSP, so it runs under `node --test`
  against ground-truth fixtures *and* inside a Worker.
- ~800x realtime. A 3.7-minute track analyses in ~0.3s.
- Playback via `AudioBufferSourceNode`, not `<audio>` — element `currentTime`
  jitters tens of ms and the choreographer solves to ~30ms.
- Analysis normalises to a canonical sample rate. Browsers decode at the device
  AudioContext rate (48kHz); the build tool uses ffmpeg at 44.1kHz. Without
  this the two disagreed on tempo for the same file.

⚠️ **Do not "optimise" `ANALYSIS_SAMPLE_RATE` to 22050.** Tried; broke 9 tests.
The onset envelope's frame rate is `sampleRate / HOP_SIZE`, so halving the rate
halves its *time* resolution and the ±60ms offset assertions fail immediately.

### Simulation — working, `src/sim/grapple.js`

Phases: `freefall → fire → swing → release → freefall`.

Two earlier models failed, instructively, and both are documented at the top of
that file:
- A **pure pendulum** oscillated, so it read as a metronome, and the backswing
  made the web arm whip around.
- A **radial grapple** pulled toward the anchor — a physics error, since a
  radial force does almost no work on a circular path, so grapples were weak
  hops.

What works: full gravity everywhere, no altitude floor, rope constraint by
vector projection, and a **tangential** pump scaled by live audio energy,
released when the velocity vector points up-and-forward past 45°.

Quadratic drag is **mandatory**, not stylistic: pumping makes this a driven
oscillator, and gravity removes no net energy over a cycle, so without
dissipation it diverges.

Anchors are real roofs, chosen from the tallest few by a rotating counter.
Taking the single tallest made every swing identical, since the skyline is one
repeating tile — the whole world offered only five distinct anchors.

### Rendering — three character renderers, silhouette ships

| Renderer | Flag in `RENDER_DEFAULTS` | State |
|---|---|---|
| Silhouette (`silhouette.js`) | both false | **SHIPPING** |
| Procedural costume (`figure.js`) | `detailed: true` | works, parked |
| Sprite rig (`sprite-figure.js`) | `sprites: true` | works, parked |

All three consume ONLY `pose.joints`, so they are interchangeable.

**Why the silhouette won.** A rigid cutout rig shows a seam at every joint
because pieces rotate without deforming — a shoulder cannot compress. At play
size that reads worse than a clean solid shape. User's call, and correct.

**The silhouette is now continuous** (`src/render/silhouette.js`, moved out of
`canvas.js`, which re-exports it). It was twelve tapered capsules; it is now
one path:

- One outline per limb CHAIN, not per bone. Each chain is sampled along its
  arc length and offset left and right by a radius from an anatomical profile.
  The centreline stays the exact polyline, so bone lengths are untouched; only
  the tangent is blended across the joint, and that is what removes the crease.
- Radii come from profiles with real anatomy in them: deltoid, forearm belly,
  wrist; glute, thigh belly, calf **below** the knee, ankle. Linear root-to-tip
  taper cannot express either shape, which is why the old limbs read as tubes.
- Torso is one closed shape through pelvis, waist, ribcage and trapezius, built
  in the torso's own frame off the actual shoulder joints.
- Real hands (oval past the wrist, on the forearm axis) and feet (a low wedge
  forward of the ankle, square to the shin, in the facing direction — facing is
  recovered from the joints, so the renderer stays on the seam).

⚠️ **Everything goes into ONE path and is filled ONCE.** That is not tidiness —
separate fills of overlapping opaque shapes still show an antialiased join
along every overlap edge, and those joins were the seams. One path means
winding matters: nonzero fill turns two oppositely-wound overlapping subpaths
into a HOLE. Every loop therefore goes through `emitLoop()`, which measures its
own signed area and reverses itself when needed, and circles are emitted as
polygons through the same path rather than via `arc()`.

⚠️ **Both ribbon end-caps sweep NEGATIVE.** `n` is `t` rotated +90°, so the
outward direction at a tip is `angle(n) − 90°`. Sweeping `+PI` carries the cap
back across the limb instead of around its end. That fold self-intersects, and
under nonzero fill the doubled region cancels — it put a dark notch at every
hip, shoulder and wrist on the first attempt. It looks like a winding bug in
`emitLoop` and is not.

**Tuning it:** `/figure-lab.html` (dev only, not a vite build input) drives the
real skeleton solver through six held poses and draws them at 2.1x, with
`?only=N` to isolate one at 4.4x and a skeleton overlay checkbox. The sandbox
shows the character at ~90px, which is the right test for whether it READS and
a useless one for whether a joint creases.

The comic pass (`comic.js`) is live: halftone, Kirby krackle on rising audio
energy, speed lines. **Chromatic aberration is off** (`chromaAmount: 0`) — it
was tuned against the flat figure and reads as blur over anything detailed.

### Player + deploy — done

Bottom-centre pill after saloon.wtf: artwork doubling as the playlist toggle,
elapsed/total with BPM inline, icon transport, hairline seek. Cover art comes
from ID3 APIC frames for dropped files, and from an optional `art` field in
`manifest.json` for curated tracks.

**Cloudflare Pages is the intended host**, because the payload is almost
entirely audio and Pages does not meter static bandwidth. `public/_headers`
mirrors the `headers` block of `vercel.json` — note it is NOT regex, so the
`/(audio|figure)/(.*)` form becomes one rule per prefix. `.node-version` pins
the build to Node 22. Deploy is either the GitHub integration (build
`npm run build`, output `dist`) or `npm run deploy` for a direct upload.

`vercel.json` is kept and still valid, so Vercel remains a working fallback.
The build is Vercel-ready. `npm run build` strips
`dist/audio/scratch` (~70MB of local-only click tracks that `public/` would
otherwise copy). **dist is now ~56MB**, almost all of it the ten MP3s.

### Playlist — ten tracks

Six Spider-Verse tracks were added on 2026-08-20: Sunflower, Annihilate, Am I
Dreaming, Self Love, Hummingbird, Scared of the Dark. Every MP3 ships. Note
that `public/audio/README.md` warns against committing commercial soundtrack
rips on takedown grounds; shipping these was an explicit call, not an oversight.

`npm run build:beatmaps -- --report` on the full playlist:

| id | bpm | conf | mode |
|---|---|---|---|
| sunflower | 179 | 0.84 | choreographed |
| calling | 139.5 | 0.62 | choreographed |
| self-love | 120 | 0.60 | choreographed |
| loser | 83 | 0.60 | choreographed |
| whats-up-danger | 95.4 | 0.58 | choreographed |
| hummingbird | 162 | 0.49 | reactive |
| scared-of-the-dark | 79.5 | 0.46 | reactive |
| am-i-dreaming | 90.4 | 0.45 | reactive |
| oh-yeah | 89.1 | 0.34 | reactive |
| annihilate | 97.5 | 0.25 | reactive |

**Five of ten fall back to reactive**, which makes the confidence-calibration
bug below much more expensive than it was with four tracks. The tempos
themselves look right — sunflower and hummingbird are double-time readings of
~89.5 and ~81, which is a defensible octave choice, not an error. It is the
confidence metric that is wrong, and it is now the highest-value analyser fix.

---

## Known broken

**4 failing tests**, all analyser, all pre-existing from an agent that was cut
off mid-edit:
- `breakbeat-100-offset: offset within ±60ms`
- `four-on-floor kicks read as strong beats`
- `breakbeat downbeats align with ground truth`
- one sim test (`amplitude is clamped…`) now largely moot, since the pendulum
  is no longer the primary model

**Confidence is miscalibrated.** Sits ~0.58 on tracks that should read 0.8+. It
clears the 0.55 floor so choreography engages, but the metric is not measuring
what it should.

**`oh-yeah` has an unstable tempo.** Reported 143, 89, 108, 89 across builds. It
correctly falls back to reactive mode, but the estimate does not converge. This
is the strongest candidate for trying the essentia.js backend — the seam exists
at `src/audio/analyzer/backends/`.

---

## Next, roughly in order

1. ~~Make the silhouette continuous.~~ **Done**, 2026-08-20. See above.
2. **Fix confidence calibration.** Promoted from the bottom of this list: half
   the playlist now runs reactive because of it. `src/audio/analyzer/` .
3. **Background detail.** The plan is AI-generated *individual buildings*
   composited by the existing city generator — not full layers, which cannot
   tile seamlessly. A ready-to-use prompt is in the chat history; the shape is
   12 buildings, front elevation, no perspective, same baseline, magenta
   background, cut to transparent PNGs in `public/city/`.
4. **Precompute beat maps** (`npm run build:beatmaps`) so curated tracks skip
   in-browser analysis on first play. Worth more now: ten tracks, and the
   longest (hummingbird, 5m20s) is the slowest cold start.
5. **Mobile.** Genuinely untested below desktop width.
6. `prefers-reduced-motion`, credits panel for track attribution.
7. The four analyser test failures — last, unless a track actually misbehaves.

---

## Things that cost real time to learn

Written down so they are not rediscovered.

- **The city repeats every 2400 units.** Any deterministic rule over it
  produces visibly looping motion.
- **The browser pane throttles `requestAnimationFrame` when not fronted.** A
  measurement that returns identical frozen values is usually this, not a bug.
- **`vercel.json` rejects unknown keys.** A `"comment"` field fails the whole
  deploy. JSON has no comments; rationale goes here instead.
- **The bone end is not the image edge** on `forearm` and `shin` sprites — it
  is the wrist and the ankle, with the hand and foot overhanging.
- **`public/` is copied wholesale into `dist`.** Anything parked there ships.
- **Pivot fractions measured by eye were badly wrong.** Scan the alpha channel
  instead; the snippet is in the chat history and took one call.
- **Overlapping opaque fills still show a seam.** Each `fill()` antialiases its
  own edge against what is already on the canvas, so two shapes that share a
  border leave a visible line even in one flat colour. The only fix is one path
  and one fill — which then makes winding direction something you have to get right.
