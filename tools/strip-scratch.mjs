/**
 * Removes local-only scratch audio from the build output.
 *
 * `public/` is copied wholesale into `dist/`, and public/audio/scratch holds
 * the working copies and click-track renders used for analyser tuning — about
 * 75MB of them. Those are gitignored, so a CI build never sees them, but a
 * local build would happily ship them and a local `preview` would serve them.
 * Deleting them here makes the local build match what deploys.
 */
import { rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await rm(resolve(root, 'dist/audio/scratch'), { recursive: true, force: true });
console.log('stripped dist/audio/scratch');

// Finder leaves .DS_Store inside public/, and "copied wholesale" includes it.
await rm(resolve(root, 'dist/.DS_Store'), { force: true });

