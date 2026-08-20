# Handoff

Current as of 2026-08-20. Supersedes all earlier versions of this file.

Read [README.md](README.md) first for what the project *is*. This file is
about where it got to, what is broken, and what to do next.

---

## Start here

```bash
cd ~/swing-city && npm install && npm test && npm run dev
```

Expect **74 pass, 4 fail**. The four failures are pre-existing analyser issues,
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

### ⚠️ There are TWO swing models

`src/sim/grapple.js` is what the SITE runs. `src/sim/index.js` is the earlier
pendulum swinger, and it is what `sandbox.html` still drives. They have
different phase names (`freefall` vs `flight`), so **a green sandbox proves
nothing about shipping behaviour** and neither does `tests/sim.test.mjs`, which
covers `index.js`. `tests/grapple.test.mjs` covers the real one. This cost real
time to notice — the sandbox HUD says `flight`, a phase grapple.js never sets.

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

### Beat legibility — the count-in

The choreography was audible and invisible. Cause, found 2026-08-20: `main.js`
called `renderer.render({ pose, dt, energy })`. `beatPulse` and `nextSwing` were
computed and passed to the SIMULATION only. `energy` is a smoothed signal, so
every visual accent it drove was merely correlated with the beat rather than
locked to it, and the one genuinely beat-locked event — the web fire — is the
softest visual event there is, because the character just keeps moving through
it.

**The count-in** (`drawTarget` in `canvas.js`) is the fix that matters. The
anchor used to be chosen at the instant of firing; it is now committed early and
exposed as `pose.nextAnchor`, and a ring pulses on it once per beat until the
web arrives. Every other accent REACTS, and a reaction is what you get free by
cutting a loop to a track. Anticipation is not: the whole grid is known before a
note plays, so the target can be telegraphed, and a viewer who watches it count
itself in and then get hit on time has been shown the choreography.

⚠️ **Commit at the apex, not on a timer.** Freefall STARTS with an upward launch,
so a roof that clears him at commit time may not clear him at the fire beat.
Measured: 6 of 17 swings re-picked at the last moment, moving the target the ring
had spent four beats pointing at. After the apex his altitude only increases, so
the commit is correct by construction. A bigger clearance number does NOT fix
this — tried 240, it got worse.

⚠️ **The ring must never be contradicted, and keeping that true is subtle.**
Emergency recovery fires at whatever it can reach. Clearing `plannedAnchor` at
that moment is too late — the ring goes dark on the same frame the web leaves
for a different roof, which a viewer reads as the promise being broken.
Measured: 61-78% of count-ins at low energy were doing exactly that.

`ringAbandonAt: 0.9` withdraws the promise at 90% of the way to the emergency
threshold, so the ring fades during the fall instead. Tuned by measurement: at
0.55 the ring was honest and almost never appeared; at 1.0 the lie rate came
straight back. Do NOT raise it to make the ring appear more often — the reason
it is rare at low energy is the emergency-rate problem above, not this number.
The emergency path also now prefers the already-committed roof when it is still
usable, since the emergency is about altitude, not about the target being wrong.

⚠️ **This bug shipped past a green test.** The original test excluded emergency
fires, reasoning that abandonment is legitimate. It is — but that made the test
assert the invariant the CODE happened to have rather than the one the feature
exists to provide. The test now tracks the ring's live state including its
withdrawal, across six tempo/energy combinations, and allows no exclusions.

⚠️ **Beat accents are MOTION, never luminance.** A whole-frame brightness pulse
per beat is a photosensitivity hazard, not a style choice — WCAG 2.3.1 caps
flashes at three per second over a large area, and a 174 BPM track beat-flashing
sits at 2.9Hz, inside the letter of the rule and past what anyone can watch. The
saturated-red palettes under consideration are singled out by the same
guideline. So the kick is a 1.4% scale punch on the fire beat and the ring is a
small stroked circle; any large-area colour change must cross-fade over seconds.
`main.js` now honours `prefers-reduced-motion` (it never did — only the sandbox
did) and re-reads it live, because people change that setting when something on
screen is already bothering them.

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

**Cloudflare is the intended host**, because the payload is almost entirely
audio and Cloudflare does not meter static bandwidth.

It is a **Worker with static assets, not a Pages project.** Cloudflare's git
integration now creates a Worker for an imported repo and sets the deploy
command to `npx wrangler deploy`. `wrangler.jsonc` declares `assets.directory`
and NO `main`, which is what makes that an assets-only deploy.

⚠️ Without `wrangler.jsonc`, `wrangler deploy` guesses what the project is,
finds `vite.config.js`, assumes the Workers Vite plugin and fails with
**"The version of Vite used in the project (5.4.21) cannot be automatically
configured. Please update the Vite version to at least 6.0.0"**. That message
is asking for a framework integration this site does not use. Do not upgrade
Vite to chase it — the fix is the config file.

`public/_headers` mirrors the `headers` block of `vercel.json`; note it is NOT
regex, so the `/(audio|figure)/(.*)` form becomes one rule per prefix. Workers
static assets honour `_headers` and `_redirects` the same way Pages does.
`.node-version` pins the build to Node 22. `wrangler` is a devDependency so CI
and local deploys agree on a version.

`vercel.json` is kept and still valid, so Vercel remains a working fallback.
The build is Vercel-ready. `npm run build` strips
`dist/audio/scratch` (~70MB of local-only click tracks that `public/` would
otherwise copy). **dist is now ~56MB**, almost all of it the ten MP3s.

### Art direction — palette system, default `noir`

`src/render/palettes.js` holds five named palettes as data. `noir` is the
default; press **P** on the site to cycle them live.

The style lab's real finding was not that one look beat the others. It was that
every look which worked shared a CONTRAST STRATEGY and differed only in hue —
saturated sky, near-black city, hot rim on a near-black figure. The ones that
failed, the original included, put the buildings and the character at nearly the
same value, so the figure sank into the skyline and no amount of texture saved
it. `noir` and `magicHour` are deliberately the same recipe in different keys;
that is the evidence this is a system rather than a look, and it is why the
palettes are data and not a branch.

A palette carries the city colours, the figure colours, halftone parameters, a
grain amount, and a halo colour that light-ground palettes set to null (a dark
halo raises local contrast against a dark sky; on cream it is a smudge).

`applyPalette()` regenerates the city, because the layer colours are baked into
the pre-rendered layer canvases — which is exactly why the layers are cheap to
draw. It refills `city.layers` IN PLACE so references handed out at boot stay
valid: main.js passes `city.buildingsAheadOf` to the simulation, and since the
seed does not change, the geometry the grapple targets is identical across a
switch. Only the paint moves.

⚠️ Large-area colour may only ever CROSS-FADE between palettes, never cut. See
the beat-accent note above: a large-area luminance change at beat rate is a
photosensitivity hazard, and the saturated reds here are the case the
guidelines name specifically.

### Art direction — the six candidates that produced it

`style-lab.html` (dev only) renders one swing frame in six treatments. The
comparison says the current look is the WEAKEST of the six: the figure and the
buildings sit at nearly the same value, so the character sinks into the city.
What separates the working ones is a contrast strategy — saturated sky,
near-black city, hot rim on a near-black figure. Nothing to do with texture.

Leading candidate is E (noir palette + print texture); F is the same recipe in a
cool key, which is the evidence that this is a palette SYSTEM rather than one
lucky set of colours. Not yet wired into `createRenderer` on purpose — the lab
composites by hand so nothing reaches shipping code before a direction is picked.

Note for whoever wires it up: `chromaAmount` was zeroed because misregistration
read as blur over the DETAILED figure. The silhouette is flat again, which is
what that effect was originally tuned against, so it should come back cleanly —
but check it at speed, not in a still.

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

### ⚠️ He falls far too deep, and it is the top problem

Measured 2026-08-20 on the synthetic skyline in `tests/grapple.test.mjs`:

```
cruiseY = 421   emergencyDrop = 1200   WORLD_HEIGHT = 1080
                       emergency fires        deepest hip.y
95 BPM  energy 0.15         72%                  2104
120 BPM energy 0.15         78%                  2091
120 BPM energy 0.85          5%                  2166
140 BPM energy 0.85          6%                  2166
```

He routinely reaches **hip.y ~2100 — roughly 1700 below cruise, and about twice
WORLD_HEIGHT below the top of the world.** At low energy the MAJORITY of swing
cycles end in emergency recovery rather than a planned fire.

This is what the "camera drops below the roofline and you are looking at the
sides of buildings" frames are. It was visible on screen and dismissed once as
an artifact of a half-applied edit. It is not an artifact.

The arc-energy work improved it a lot at high energy (baseline was 42-70%
emergency, now 5-11%) but low energy is barely better than baseline. The
suspects are `minFreefallTime: 1.15` interacting with full gravity, and the
altitude assist not being able to keep up. **Do this before any more visual
work** — it is upstream of the count-in, the framing, and the arc scaling all
at once.

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

1. ~~Make the silhouette continuous.~~ **Done**, 2026-08-20.
1b. ~~Make the beat visible.~~ **Count-in done**, 2026-08-20. Still open:
   arc height scaling with section energy, and a palette that cross-fades on
   section boundaries — which needs section detection the BeatMap does not
   have yet.
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
