/**
 * BeatMap cache. Analysis takes a couple of seconds; nobody should pay that
 * twice for the same file.
 *
 * Three tiers, checked in order:
 *   1. Shipped  — curated playlist tracks have their BeatMap precomputed at
 *                 build time and served as static JSON. Zero wait.
 *   2. IndexedDB — dropped files, analysed once on this device.
 *   3. Miss     — caller runs the analyser.
 */

const DB_NAME = 'swing-city';
const DB_VERSION = 1;
const STORE = 'beatmaps';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // Private browsing modes and some embedded webviews block IndexedDB
    // outright. Treat that as a cache miss forever rather than an error.
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/**
 * Cache key for a dropped file.
 *
 * Hashing a whole 8MB file is wasteful when we only need collision resistance
 * across one user's library, so we hash the first 1MB plus the exact byte
 * length. Two different songs colliding on both is not a realistic concern,
 * and it keeps this under ~10ms instead of ~200ms.
 */
export async function fileKey(file) {
  const head = await file.slice(0, 1024 * 1024).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', head);
  const hex = [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `f:${hex}:${file.size}`;
}

/** Cache key for a curated playlist entry. */
export function trackKey(id) {
  return `t:${id}`;
}

/**
 * @param {string} key
 * @param {string} [shippedUrl] Static precomputed BeatMap to try first.
 * @returns {Promise<import('../contract.js').BeatMap|null>}
 */
export async function get(key, shippedUrl) {
  if (shippedUrl) {
    try {
      const res = await fetch(shippedUrl);
      if (res.ok) return reviveEnvelope(await res.json());
    } catch {
      // fall through to IndexedDB
    }
  }

  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () =>
      resolve(req.result ? reviveEnvelope(req.result.beatMap) : null);
    req.onerror = () => resolve(null);
  });
}

/** @param {string} key @param {import('../contract.js').BeatMap} beatMap */
export async function put(key, beatMap) {
  const db = await openDb();
  if (!db) return;

  // Float32Array survives structuredClone, so IndexedDB stores it natively.
  // JSON round-trips (the shipped tier) do not, hence reviveEnvelope on read.
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, beatMap, storedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** JSON turns Float32Array into a plain array (or an object of indices). */
function reviveEnvelope(beatMap) {
  if (!beatMap) return null;
  const env = beatMap.onsetEnvelope;
  if (env && !(env instanceof Float32Array)) {
    beatMap.onsetEnvelope = Float32Array.from(
      Array.isArray(env) ? env : Object.values(env)
    );
  }
  return beatMap;
}

export async function clear() {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
