# Curated playlist

Drop audio files in this directory, list them in `manifest.json`, then run:

```bash
npm run build:beatmaps
```

That decodes each track, runs the offline analyser, and writes a precomputed
BeatMap to `public/audio/beatmaps/<id>.json`. Visitors selecting a curated
track then pay a fetch and a decode but **no analysis wait**.

## manifest.json

```json
{
  "tracks": [
    {
      "id": "neon-transit",
      "title": "Neon Transit",
      "artist": "Some Artist",
      "url": "/audio/neon-transit.mp3",
      "license": "CC0",
      "source": "https://example.com/track-page"
    }
  ]
}
```

`id` must be a stable slug. It is the cache key and the beatmap filename, so
renaming it invalidates that track's cached analysis.

## Format

**MP3 at ~160kbps** is the right default. It decodes everywhere with no
caveats. Opus-in-WebM is smaller but Safari support arrived late and unevenly,
and this site has to work on iPhones.

Keep tracks under ~6MB. The whole file is downloaded and decoded before
playback starts, because offline beat analysis needs the complete buffer.

## What analyses well

The beat tracker wants **clear transients**. Tracks with a defined kick and a
steady tempo produce tight, confident beat grids. Ambient washes, heavy rubato,
and live recordings that drift will report low `bpmConfidence`, and the site
will fall back to reactive mode — still reacts to the music, but the swing
choreography stops being planned to land on beats.

If a track feels off, check its analysis first:

```bash
npm run build:beatmaps -- --report
```

which prints detected BPM, offset, and confidence per track.

## Licensing

This project is open source and publicly hosted, so every track needs a
licence that permits redistribution. Safe sources:

- **Pixabay Music** — their own licence, free for commercial use, no attribution required
- **Free Music Archive** — per-track, check each one; many are CC-BY
- **Uppbeat** free tier — requires attribution
- **ccMixter** — mostly CC-BY / CC-BY-NC

Record `license` and `source` in the manifest. CC-BY tracks are surfaced in
the credits panel automatically; CC0 ones are not.

Do not commit commercial soundtrack rips. That is the fastest way to get the
whole site taken down.
