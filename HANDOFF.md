# Handoff

Written 2026-08-17, mid-session, while two agents were still working. **Verify
the current state before trusting anything below** — see "First thing to run".

Read [README.md](README.md) first for what the project is and how the pieces
fit. This file is only about *where we got to* and *what to do next*.

---

## First thing to run

```bash
cd ~/swing-city && npm install && npm test
```

Then:

```bash
npm run gen:audio        # regenerate synthetic fixtures (they are gitignored)
npm run dev              # dev sandbox — physics with a synthetic metronome, no audio
node tools/analyze-file.mjs public/audio/scratch/whats-up-danger.mp3
```

That last command is the single most informative thing you can run. Compare its
output against the "known bugs" table below to see whether the fixes landed.

Nothing has been committed yet — the repo is `git init`'d with zero commits.
Everything is on disk and untracked. If you want a checkpoint:

```bash
cd ~/swing-city && git add -A && git commit -m "Initial: contract, audio pipeline, sim, renderer"
```

---

## Status at handoff

### Done and verified (written by me, not an agent)

| File | What it is |
|---|---|
| `src/contract.js` | **Read this first.** The BeatMap schema and the Pose/Swinger API. The integration surface between the audio half and the animation half. Both halves code against it and nothing else — that is what allowed them to be built in parallel. |
| `src/audio/ingest.js` | File-drop and playlist loading, decode, iOS AudioContext unlock, mono downmix for analysis. |
| `src/audio/playback.js` | Playback via `AudioBufferSourceNode` + live FFT for visual texture. |
| `src/audio/cache.js` | Three-tier BeatMap cache: shipped JSON → IndexedDB → miss. |
| `src/playlist.js` | Manifest loading, attribution helper. |
| `tools/make-test-audio.mjs` | Generates 6 synthetic tracks with **ground-truth** BPM/offset/beats + `.truth.json` sidecars. The test oracle. |
| `tools/analyze-file.mjs` | Analyses any real audio file and prints a full report. `--clicks out.wav` renders the song with a click on every detected beat — **listening to that is the only real test of whether a grid is correct**. |
| `tools/build-beatmaps.mjs` | Precomputes BeatMaps for curated playlist tracks at build time via ffmpeg. |
| `public/audio/README.md` | How to add songs to the curated playlist. |

### Killed mid-edit by the spend limit

Both background agents were **terminated by an API spend limit while actively
editing**. Their work is partial. I made two small repairs afterwards to get the
repo back to a runnable state:

1. `src/audio/analyzer/onset.js` used `WHITEN_DECAY` / `WHITEN_FLOOR` without
   defining them (agent died mid-way through adding adaptive whitening), so the
   module threw `ReferenceError` on every run. I added both constants with
   standard published values. **They are unverified guesses — re-tune them.**
2. `package.json` test script was `node --test tests/`, which Node 22 resolved
   as a module path and failed. Changed to `node --test tests/*.test.mjs`.

Those two lines unblocked a large amount of agent work that was already correct
on disk. See the measured table below.

**Last known intent, from each agent's final message before it died:**

- **Analyser agent** — had established that `oh-yeah`'s onset envelope is
  genuinely flatter than the other three (p99/p50 of 3.4 vs 4.0-4.3) because
  dense compressed production masks its transients, and was adding adaptive
  whitening (Stowell & Plumbley) to compensate. That work is half-landed and,
  per the measurements below, **did not actually help oh-yeah**.
- **Sim agent** — had found two further bugs it did not finish fixing: *"the
  catch was clamping θ (breaking perpendicularity), and the forward gate could
  blow past `tNext`"*. Test 14 (`amplitude is clamped so the bob never goes over
  the bar`) is still failing, which is almost certainly the first of those.

`tests/_probe*.mjs` are the analyser agent's scratch debugging files. Delete
them once its work is confirmed done.

### Integration — DONE, and verified in a browser

The site works end to end: entry overlay → decode → Worker analysis → BeatMap →
sample-accurate playback → choreographed release → render. Verified by clicking
through it, with no console errors.

- `src/main.js` — the frame loop that connects everything. Monotonic cursors
  into `swingPoints` / `beats` (reset on seek), a 4s lookahead handed to the
  choreographer, live FFT for texture only.
- `src/audio/analyze-client.js` — Worker wrapper, with an in-process fallback
  for environments where Workers are blocked.
- `index.html` — the site. `sandbox.html` — the physics sandbox, still on the
  synthetic metronome, now a second Vite entry point.
- All four real tracks are in `public/audio/manifest.json` and play.

Confirmed working in-browser: track switching, the playlist, transport, and the
**low-confidence fallback** — `oh-yeah` correctly shows "reactive (low
confidence)" in amber instead of choreographing to a grid it does not trust.

### Fixed this session

**Swing spacing is now musical, not absolute.** It was in seconds, so identical
settings produced structurally different choreography at 83 BPM vs 174 BPM. Now
expressed in **bars** via `SWING_DENSITY` / `swingGaps()` in `contract.js`, with
absolute floor/ceiling clamps. Presets: `quick` / `brisk` / `balanced` /
`relaxed` / `cinematic`. **`balanced` is the shipping choice** (`DEFAULT_DENSITY`),
picked by ear — roughly one swing per 1.25-2.5 bars.

**Half-bar phrasing.** The swing DP only rewarded whole-bar gaps, which made the
density control discontinuous — every setting collapsed to one-per-bar or
one-per-two-bars because a 6-beat gap earned nothing. Half-bars now score at
half weight.

**Sample-rate normalisation — this was a real correctness bug.** Browsers decode
at the device AudioContext rate (48kHz on this Mac); `build-beatmaps.mjs` decodes
via ffmpeg at 44.1kHz. Same file, two rates, two different beat maps — so a
precomputed map would never match what the browser computed. `analyze()` now
resamples to `ANALYSIS_SAMPLE_RATE` first. Verified: `oh-yeah` reports 89 BPM in
both the CLI and the browser, where it previously gave 89 and 108.

⚠️ **Do not "optimise" `ANALYSIS_SAMPLE_RATE` down to 22050.** I tried; it broke
9 tests. The onset envelope's frame rate is `sampleRate / HOP_SIZE`, so halving
the rate halves the envelope's *time* resolution (86 → 43 fps) and the ±60ms
offset and ±1.5 BPM assertions fail immediately. Analysis is already ~800x
realtime; there is nothing to buy. The comment in `analyze()` says this too.

### CURRENT MODEL: pumped swing (src/sim/grapple.js) — built to spec, one open issue

Replaces both the pendulum and the radial-grapple attempts. Phases:
`freefall → fire → swing → release → freefall`.

**Implemented and verified working:**
- Full gravity in every phase, no altitude floor (the drop is where potential
  energy comes from).
- Rope constraint by vector projection; radial velocity removed, position
  snapped back onto the circle.
- **Tangential** pump weighted by `bottomness` (peaks directly below the
  anchor) and scaled by live audio `energy` with a floor of 0.35. This is the
  correction to the earlier radial pull, which did almost no work on a circular
  path and was why grapples felt like weak hops.
- Release when the velocity vector is ≥45° above horizontal AND `vel.x > 0`,
  with a `maxSwingTime` fallback for shallow swings that never reach the angle.
- Quadratic drag instead of a hard speed cap — mandatory, because pumping makes
  this a DRIVEN oscillator and gravity removes no net energy over a cycle.
- Emergency anchor if he drops >1200 below cruise (replaces the old floor).
- Anchor search takes the TALLEST roof in the window, since roof height is the
  radius budget.
- Fires on every BEAT, not on sparse swing points: at ~4.5s spacing under full
  gravity he fell ~24,000 units between webs.

**RESOLVED — `minFreefallTime` was the missing piece.** Firing on every beat
(0.63s at 95 BPM) meant he never fell, so he never sank into the roof band, so
no building ever qualified and every web went to a fallback sky point. Gating
the next shot behind ~1.15s of freefall fixed airtime, distance, and roof
anchoring in one change:

|                     | before        | after                |
|---------------------|---------------|----------------------|
| distance in ~9.6s   | —             | 11,981 (1,248/sec)   |
| hip Y range         | -295..110     | 400..1179            |
| anchor Y            | 121 (sky)     | 346 (a real roof)    |
| backward samples    | 5/25          | 0/23                 |

`anchorY` reading as a single constant is expected, not a bug: the city is a
repeating 2400-wide tile and the search takes the tallest roof in the window,
so it is the same building every time.

**Two fixes applied after the above, both verified by build+tests, the second
NOT verified visually (see note):**

*The motion looped.* The skyline is one repeating 2400-wide tile and
`buildingAheadOf` took the tallest roof in the window — a deterministic rule, so
it resolved to the same buildings forever. Measured: exactly FIVE distinct
anchors in the whole world (tile offsets 114, 585, 902, 1426, 2019), and since
he travels ~1250/sec against a 2400 tile, his cadence had synced to it.
Widening the tile was not an option (pre-rendered canvases, already ~85MB).
Fix: `buildingsAheadOf` returns all qualifying roofs tallest-first, and the
swinger rotates through the top `anchorPool` (3) by a counter. Distinct anchor
heights went 1 -> 7 across 8 swings.

*The catch teleported.* `ropeLength` was clamped to `maxRope` (620) on contact,
but `stepSwing` snaps the character onto a circle of exactly that radius — so
making contact at 900 out jumped him 280 units toward the anchor in one frame.
The clamp is still wanted (a long fall otherwise gives a 1500 arc that swings
off-screen), so the rope now STARTS at its true length and reels in to the
target via `reelRate`/`reelFloor`. Continuous, and reeling is what a web does.

⚠️ **The reel fix is unverified in motion.** The browser pane throttles
requestAnimationFrame whenever it is not fronted, so the fire->swing transition
(only ~6 frames at webSpeed 6000) could not be sampled. The mechanism and the
fix are both clear from the code, but somebody should watch it.

**Remaining polish, in rough priority:**
1. He dips to y 1179, below the 1080 screen line, at the bottom of deep arcs.
   Check whether the camera handles it or he visibly enters the street.
2. Web-fire and release animation refinement — still the user's outstanding
   point 1 from the earlier review, never addressed.
3. The web can end up near-horizontal behind him late in a pass. Correct for
   the model, slightly odd-looking; consider releasing a touch earlier.

**Ratchets found and fixed along the way (do not reintroduce):** the fallback
anchor was `hip.y - 320`, an infinite ladder that took him to y = -1449; the
pump had no altitude ceiling; the release kick was unconditional. All three now
fade with height.

### Superseded: the radial grapple model

`src/sim/grapple.js` is live and wired into `main.js`. The pendulum
(`src/sim/index.js`) is still on disk and still drives `sandbox.html`.

**Verified working:** forward traversal with 0 of 29 samples moving backward,
altitude holding between y 213 and 602 (on-screen throughout), phases cycling
`cruise → fire → pull → pass → cruise`, and anchors landing on real roofs via
the new `city.buildingAheadOf()`.

**Four bugs found and fixed during bring-up, each with the measurement:**
1. *Pulled into the anchor.* Rope length collapsed to 22, the radial constraint
   had no meaningful direction and zeroed all velocity, deadlock. Fix: the pull
   aims a `passClearance` BELOW the roof — you swing under an anchor, never
   into it.
2. *Backward drift during `pass`* (x running 14567 → 14522 → 14477): the
   pendulum backswing sneaking back in. Fix: bail out of `pass` the moment
   horizontal velocity reverses.
3. *Riding the sag floor* (y pinned at exactly `cruiseY + maxSag`): the pull
   target landed below him whenever he was low, so it had no upward component.
   Fix: `minPullRise`.
4. *Ratcheting out of the frame* (y = -197): `minPullRise` applied
   unconditionally made every pull a climb. Fix: apply it only below cruise,
   plus a symmetric lift falloff above it.

**Still to tune (not structural):** he spends long stretches gliding at the sag
floor between grapples — roughly two visible arcs per 11 seconds. The grapple
fires on swing points (~4.5s apart at `balanced`), so either the density wants
raising for this model, or `cruiseGravityScale` wants lowering so the glide
holds height longer. Try the density first; the model reads better with more
frequent, shallower grapples than with rare deep ones.

**Not yet addressed from the same review:** web-fire and release animation
refinement (point 1 of the user's list). The arm now aims at the travelling web
tip during `fire` and at the anchor once attached, which should already help,
but it has not been judged by eye.

### Original spec, kept for reference

The user watched the working pendulum build and identified that the *model* is
wrong, not the tuning. This supersedes the swing physics; read it before
touching `sim/`.

**What is wrong.** We built a pendulum: the character hangs beneath an abstract
anchor and oscillates around it. Even with a forced lead angle producing net
travel, the underlying motion is oscillation — so it reads as a pendulum,
because it is one. The backswing is also almost certainly the "looks like he is
having a stroke" artifact: on the return half of the arc he travels backward
relative to the anchor and the web arm has to whip around to keep up.

**The model to build instead, in the user's words:** he moves forward
continuously; on a beat he fires a web at a **building ahead**; the web *pulls*
him toward it, actively adding speed rather than passively hanging; he carries
that momentum past the building and either coasts or immediately webs the next
one ahead.

The decisive difference: **the anchor ends up BEHIND him.** He passes it and
leaves it. He never oscillates around it.

**Why this is better, beyond looking right:**

- *Beat legibility.* A web-attach-and-pull is a sharp discrete event that lands
  ON a beat. A pendulum apex is a smooth extremum with no crisp moment, so the
  sync is much harder to perceive even when it is numerically exact.
- *Altitude solves itself.* You pull toward an anchor high on a building, so
  height comes from the mechanic. `heroicAssist()` becomes a safety net rather
  than the load-bearing hack it currently is.
- *The anchor becomes real* — a point on an actual building, not a coordinate
  derived from velocity.

**Proposed phases** (replacing swing / flight / anchor):

    cruise  — moving forward, gravity bleeding height, body in a glide
    fire    — on a swing point, pick a building ahead, web shoots out
    pull    — accelerate toward the anchor; this ADDS energy (the superhero
              cheat, and the reason the games feel good)
    pass    — a partial arc past the anchor, NOT a full oscillation
    release — let go carrying momentum up and forward, back to cruise

**What it needs from the city.** `src/render/city.js` already exposes
`buildings` per layer with positions, so anchor targets can be real. Note the
city is a repeating strip of `tileWidth` 2400 — world x must be modded into the
tile to look a building up. The foreground layer (parallax 0.85) is the one the
character should interact with. A `buildingAheadOf(worldX, minDistance)` helper
belongs in city.js.

**What survives the rewrite:** the whole audio half, the BeatMap, the
choreography timing idea (inverse-solving so an event lands exactly on a beat —
now it is the *attach* that lands on the beat instead of the release), the
skeleton, the renderer, the camera, and `MIN_LEAD_THETA` in spirit. What goes
is the pendulum as the primary motion model. `pendulum.js` is still useful for
the `pass` arc.

**Also outstanding from the same review:**
1. Web-fire and release need animation refinement — the transitions read as
   jerky. Suspect the skeleton spring lag during phase changes and the arm
   snapping between anchor directions.
2. ~~More buildings~~ — done: five layers, tighter gaps, crowded skyline.

### Not started

- Spider-Verse render pass (ink lines, halftone, chromatic aberration).
- Precomputing beat maps for the shipped playlist (`npm run build:beatmaps`) —
  currently every track is analysed in-browser on first play and then cached.
- Mobile pass: nothing has been tested below desktop width.
- Credits panel for track attribution.

---

## The active work: four known analyser bugs

Measured against four real tracks, **before** the agents' fixes and **after**
(post-repair, current state on disk):

| | whats-up-danger | calling | loser | oh-yeah |
|---|---|---|---|---|
| tempo *before* | 95.00 | 139.44 | 83.00 | 143.31 |
| tempo **after** | 95.43 | 139.51 | 83.00 | **89.08** |
| confidence *before* | 0.480 | 0.493 | 0.619 | 0.351 |
| confidence **after** | 0.577 | 0.621 | 0.595 | **0.341** |
| offset *before* | 10120ms | 8886ms | 910ms | 14385ms |
| offset **after** | 64ms | 6ms | 189ms | 183ms |
| sections *before* | 20 | 29 | 28 | 14 |
| sections **after** | 7 | 5 | 5 | 5 |
| swing points **after** | 136 | 137 | 100 | 90 |

**Target: confidence > 0.8 on all four, offset within [0, beatPeriod), beats
spanning from t=0, non-uniform swing spacing, 4-8 sections, fixtures still
passing.**

### Where each bug now stands

- **Bug 2 (grid offset) — FIXED.** All four are now well inside one beat period.
- **Bug 4 (sections) — FIXED.** 5-7 per track, inside the 4-8 target.
- **Tempo lattice smell — FIXED.** Tempi are non-integer now (95.43, 139.51),
  so the search is no longer on an integer BPM lattice.
- **Bug 1 (confidence) — PARTIAL.** Three tracks moved above the 0.55 floor, so
  choreography would at least engage, but all are far short of the 0.8 target.
  Still miscalibrated, just less badly.
- **Bug 3 (swing selection) — UNVERIFIED.** Counts now vary sensibly per track
  (136/137/100/90) rather than being a fixed decimation, which is a good sign,
  but **nobody has confirmed the spacing is actually non-uniform**. Run
  `tools/analyze-file.mjs` and look at the spacing histogram it prints.

### NEW problem: oh-yeah got worse, and it is the interesting one

The adaptive whitening added to help `oh-yeah` **made it worse**: confidence
went 0.351 → 0.341, and the detected tempo moved from **143.31 to 89.08 BPM**.

Those two are not an octave apart (ratio ≈ 1.61), so this is not a half/double
flip — it is a genuinely unstable estimate that moved to a different, unrelated
answer under a modest change to the front end. That instability is the real
signal here, and it matters more than either number: it means the tempo estimate
for this track is not converging on anything, and whichever value it lands on
should not be trusted.

Three things to try, roughly in order of cost:

1. **Re-tune or revert the whitening.** `WHITEN_DECAY` / `WHITEN_FLOOR` in
   `onset.js` are my unverified repair guesses. Test whitening on and off across
   all four real tracks *and* all six fixtures. Watch `sparse-pad-72`
   specifically: whitening amplifies noise in quiet passages, so it can easily
   make that fixture look confident when it should not be.
2. **Check the octave explicitly.** Print the autocorrelation strength at
   89.08, at 143.31, and at their halves/doubles, and see whether the perceptual
   prior is picking a genuinely dominant peak or arbitrating between near-ties.
   A near-tie is itself the answer: report low confidence and let the track fall
   back to reactive mode.
3. **Try the essentia.js backend.** This is exactly the sanctioned case for it
   (see Decisions below). The seam already exists at
   `src/audio/analyzer/backends/`. If `RhythmExtractor2013` gives a stable,
   confident answer on oh-yeah where Ellis will not, that is a real argument for
   paying the payload cost — possibly lazy-loaded only for tracks Ellis reports
   low confidence on, which would be the best of both.

**Also still unverified by ear:** whether any of these tempi are the right
octave. Click tracks are at `public/audio/scratch/*-CLICKS.mp3` (rendered from
the *pre-fix* analysis — regenerate them with `--clicks`). The user had not
reported back before cutoff.

### Failing tests (3 of 70; 66 pass, 1 unaccounted)

```
not ok 3  - grid offset          (analyser)
not ok 5  - beats                (analyser)
not ok 14 - amplitude is clamped so the bob never goes over the bar   (sim)
```

Test 14 is almost certainly the sim agent's known-unfixed bug: *"the catch was
clamping θ, breaking perpendicularity"*. Tests 3 and 5 are analyser fixture
assertions — check whether they are real regressions from the whitening change
or assertions the agent had already updated in intent but not in code.

1. **Confidence is miscalibrated.** All four tracks are strongly beat-driven,
   yet three fall below `CONFIDENCE_FLOOR` (0.55), which *silently disables
   choreography* and drops to reactive mode. It should measure "how well does
   this grid explain the observed onsets" — fraction of strong onsets landing
   near a grid position, weighted by strength. **Do not fix this by lowering the
   floor constant.**

2. **Grid offset is out of range.** `offset` must be in `[0, beatPeriod)`;
   10.12s is sixteen beat periods. The tracker starts the grid at the first beat
   it is confident about, so quiet intros get no beats at all and the character
   hangs motionless for ten seconds. Fix: normalise modulo the beat period, and
   extrapolate the grid backwards to t=0, marking extrapolated beats with low
   `strength` so the choreographer under-uses rather than omits them.

3. **Swing point selection is inert.** Spacings were *identical* for every
   consecutive pair (1.26s on whats-up-danger, 0.86s on calling — exactly 2
   beats each). It is decimating the grid, not selecting. `calling` picked swing
   points with `strength` 0.00. Needs a real optimisation (DP / weighted
   interval scheduling) maximising selected strength subject to
   `MIN_SWING_GAP`/`MAX_SWING_GAP`, preferring downbeats and section boundaries.
   **Success criterion: spacing is visibly non-uniform, and a quiet break has
   noticeably fewer swings than a drop.**

4. **Sections over-segmented.** 20-29 per track including 2-second slivers.
   Enforce ~8s minimum length, merge neighbours differing by <0.15 energy.

**Plus one unresolved smell:** grid jitter is *exactly* 0.0ms and tempi land on
round integers (95.00, 83.00). That suggests the tempo search is on an integer
BPM lattice and the Ellis DP backtrace is not permitting per-beat local
deviation — i.e. it may have collapsed into "fit the best rigid grid", which is
not what Ellis DP is supposed to do, and may be the root cause of bug 1. Verify
before assuming the four fixes are sufficient.

**Unverified by ear:** whether the detected tempi are the correct *octave*.
Half/double errors produce grids that fit perfectly and look fine in every
metric. Click tracks were rendered to `public/audio/scratch/*-CLICKS.mp3` and
sent to the user; their verdict was not received before cutoff. `oh-yeah` at
143.31 BPM is the highest octave risk (weakest onset evidence of the four).

---

## Decisions already made — do not re-litigate

**Third-person side-on, 2D Canvas.** Explicitly chosen by the user over a
Three.js chase-cam matching Sony's PS5 game. Rationale: the sim is
renderer-agnostic, so proving the audio choreography in a cheap renderer first
costs little and the 3D door stays open. If revisiting: a swing is planar, so a
chase cam is the same 2D pendulum plane viewed obliquely with a heading angle —
the sim survives mostly intact.

**No Rive, no Matter.js, no Three.js, no React, no GSAP.** Rive needs an
animator we do not have. Matter.js is 80KB for one pendulum (8 lines of maths).
The rest are wrong-shaped for a single canvas driven by physics.

**Playback via `AudioBufferSourceNode`, not `<audio>`.** Element `currentTime`
jitters tens of ms; the choreographer solves to ~30ms. We decode the whole
buffer for analysis anyway, so streaming buys nothing.

**Analysis DSP is pure JS + fft.js, no Web Audio API.** So it runs under
`node --test` against ground-truth fixtures *and* inside a Worker.

**Ellis 2007 DP beat tracker** (the algorithm librosa uses), behind a swappable
backend interface at `src/audio/analyzer/backends/`. **essentia.js is an
approved fallback** — the user confirmed the project is personal, open source
and non-commercial, so AGPL is fine. It was deliberately *not* made the default
because it is 2-6MB of WASM against a ~25KB JS budget. If the four bugs above
cannot be fixed in the Ellis path, implementing the essentia backend behind the
existing seam is the sanctioned next move.

**Music licensing is a non-issue per the user** — personal, non-commercial,
open-source site, same posture as the reference site saloon.wtf. Real
commercial tracks are fine to use and ship. (The generic guidance in
`public/audio/README.md` predates that decision.)

**The sign-lock trick is load-bearing.** `omega += impulse * Math.sign(omega)`
— the impulse always aligns with current motion, so it can never fight the
swing regardless of how tempo relates to the pendulum's natural period. A naive
directional impulse produces a swing that randomly stalls. `tests/sim.test.mjs`
should assert this property holds across random phase/tempo combinations. Keep
it as the fallback for low-confidence tracks even once choreography works.

---

## Suggested order when picking up

1. **Verify agent output.** `npm test`, then `tools/analyze-file.mjs` on all
   four scratch tracks. Compare to the baseline table. Delete `tests/_probe*`.
2. **Confirm tempo octaves by ear** using the `-CLICKS.mp3` files, or
   regenerate them. Everything downstream assumes the grid is right.
3. **Finish the analyser bugs** if the agent did not.
4. **Look at the dev sandbox** (`npm run dev`). This is the first point where
   the motion can be judged. Tune feel before integrating.
   **Strongly consider adding Tweakpane** (MIT, ~10KB) here — there are ~15 feel
   parameters and they cannot be reasoned about, only dragged.
5. **Integrate**: entry overlay → ingest → worker analyse → playback → choreo →
   render. This is the first moment the actual idea exists.
6. Then: player UI, real tracks into the manifest, Spider-Verse render pass.

---

## Test assets

Synthetic fixtures (gitignored, regenerate with `npm run gen:audio`): six WAVs
with `.truth.json` sidecars — `four-on-floor-{90,128,174}` (easy),
`breakbeat-{140,100}-offset` (syncopation, non-zero offset, quiet break),
`sparse-pad-72` (**must report low confidence, not a confident wrong answer**).

Real tracks in `public/audio/scratch/` (gitignored): `whats-up-danger`,
`calling`, `loser`, `oh-yeah`, plus `*-CLICKS.mp3` renders. Move these into
`public/audio/` and add to `manifest.json` when ready to ship them.

---

## Character rendering: three renderers, silhouette is the shipping one

All three consume ONLY `pose.joints`, so they are interchangeable with no
change to physics, skeleton solve, or the comic pass. Flags in
`RENDER_DEFAULTS`:

| Renderer | Flag | State |
|---|---|---|
| Silhouette (`canvas.js`) | both flags false | **SHIPPING** |
| Procedural costume (`figure.js`) | `detailed: true` | works, kept |
| Sprite rig (`sprite-figure.js`) | `sprites: true` | works, kept, parked |

**Why the silhouette won.** A rigid cutout rig shows a seam at every joint
because pieces rotate without deforming — a shoulder cannot compress, a hip
cannot reshape. At play size that reads worse than a clean solid shape. The
user's verdict, and it is correct.

**The sprite path is not wasted.** `public/figure/*.png` (six AI-generated
limb assets) plus a measured pivot table are in the repo and working. It is
the right raw material if this is revisited.

**If revisiting, the real fix is mesh deformation, not more sprite tuning.**
Rive or Spine bind artwork to bones that BEND it. Honest effort estimate for
someone new to those tools: ~5-10h learning, ~10-20h rigging with mesh, ~5-10h
wiring the runtime to our joint solver — call it 20-40 hours, mostly art
skill. Note both tools are built for AUTHORED animation (play a walk cycle),
whereas we need external physics to drive bones every frame. Spine's web
runtime exposes direct bone transforms and suits that better; Spine mesh
deformation requires the Professional tier (~$349). Rive has a usable free
tier but driving 13 joints externally is more awkward.

**Cheaper and probably better: improve the silhouette itself.** One continuous
closed path around the whole body instead of 12 separate capsules, with
anatomically-weighted radii, plus real hands and feet. That removes the joint
bumps and the uniform-tube look — the two things that make the current
silhouette read as a skeleton with thickness — with no assets, no new tools,
and no runtime cost.
