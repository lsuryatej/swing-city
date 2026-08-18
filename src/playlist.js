/**
 * Curated playlist.
 *
 * The manifest lives at public/audio/manifest.json so tracks can be added by
 * dropping files in and re-running `npm run build:beatmaps`, with no code
 * change. See public/audio/README.md.
 *
 * Curated tracks ship a precomputed BeatMap alongside the audio, so selecting
 * one costs a fetch and a decode but no analysis. Dropped files pay the ~2s
 * analysis once, then hit the IndexedDB cache forever after.
 */

/**
 * @typedef {Object} Track
 * @property {string} id       Stable slug; also the cache key and beatmap filename.
 * @property {string} title
 * @property {string} artist
 * @property {string} url      Path under public/.
 * @property {string} [beatMapUrl] Precomputed BeatMap JSON, if built.
 * @property {string} [license] e.g. 'CC0', 'CC-BY 4.0'
 * @property {string} [source]  Attribution URL, required for CC-BY.
 */

let cached = null;

/** @returns {Promise<Track[]>} */
export async function loadPlaylist() {
  if (cached) return cached;
  try {
    const res = await fetch('/audio/manifest.json');
    if (!res.ok) throw new Error(String(res.status));
    const raw = await res.json();
    cached = raw.tracks.map(normalise);
  } catch {
    // A missing or malformed manifest must not break the site — drag-and-drop
    // still works, so degrade to an empty playlist rather than failing hard.
    console.warn('[playlist] no manifest found; drag-and-drop only');
    cached = [];
  }
  return cached;
}

function normalise(t) {
  return {
    ...t,
    beatMapUrl: t.beatMapUrl ?? `/audio/beatmaps/${t.id}.json`,
  };
}

/** Attribution lines for any CC-BY tracks, for the credits panel. */
export function attributions(tracks) {
  return tracks
    .filter((t) => t.license && !/^cc0/i.test(t.license))
    .map((t) => `${t.title} — ${t.artist} (${t.license})${t.source ? ` ${t.source}` : ''}`);
}
