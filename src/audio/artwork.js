/**
 * Cover art extraction from ID3v2 tags.
 *
 * The curated tracks carry no embedded art (verified with ffprobe: audio
 * streams only), so they get artwork from the manifest instead. This exists
 * for DROPPED files, where most real-world MP3s do carry an APIC frame and
 * pulling it out is the difference between the player showing a placeholder
 * and showing the actual album.
 *
 * Hand-rolled rather than pulling in a tag library: we need exactly one frame
 * type, and the whole parser is shorter than the dependency's README.
 */

/** Synchsafe integers: 7 bits per byte, top bit always clear. ID3 uses them so
 *  a size field can never contain a false frame-sync pattern. */
function synchsafe(v, o) {
  return (v[o] << 21) | (v[o + 1] << 14) | (v[o + 2] << 7) | v[o + 3];
}

function plain32(v, o) {
  return (v[o] << 24) | (v[o + 1] << 16) | (v[o + 2] << 8) | v[o + 3];
}

/**
 * @param {ArrayBuffer} bytes  The whole file.
 * @returns {{blob: Blob, url: string}|null}
 */
export function extractCoverArt(bytes) {
  const v = new Uint8Array(bytes);

  // "ID3" magic, then a version byte we care about (2.3 and 2.4 differ in how
  // frame sizes are encoded).
  if (v.length < 10 || v[0] !== 0x49 || v[1] !== 0x44 || v[2] !== 0x33) return null;
  const major = v[3];
  const tagSize = synchsafe(v, 6);
  const end = Math.min(10 + tagSize, v.length);

  let p = 10;
  while (p + 10 <= end) {
    const id = String.fromCharCode(v[p], v[p + 1], v[p + 2], v[p + 3]);
    // A run of zero bytes is the padding that follows the last real frame.
    if (id === '\0\0\0\0') break;

    // 2.4 made frame sizes synchsafe; 2.3 left them as plain big-endian.
    const size = major >= 4 ? synchsafe(v, p + 4) : plain32(v, p + 4);
    if (size <= 0 || p + 10 + size > end) break;

    if (id === 'APIC') {
      const art = parseApic(v, p + 10, size);
      if (art) return art;
    }
    p += 10 + size;
  }
  return null;
}

/**
 * APIC payload: encoding byte, MIME (latin1, NUL-terminated), picture-type
 * byte, description (NUL-terminated in the declared encoding), image bytes.
 */
function parseApic(v, start, size) {
  let p = start;
  const encoding = v[p++];

  let mime = '';
  while (p < start + size && v[p] !== 0) mime += String.fromCharCode(v[p++]);
  p++; // NUL

  p++; // picture type

  // UTF-16 descriptions terminate on a DOUBLE NUL, and can legitimately
  // contain single zero bytes, so the terminator search differs by encoding.
  if (encoding === 1 || encoding === 2) {
    while (p + 1 < start + size && !(v[p] === 0 && v[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < start + size && v[p] !== 0) p++;
    p++;
  }

  const imgLen = start + size - p;
  if (imgLen <= 0) return null;

  const type = mime.trim() || 'image/jpeg';
  const blob = new Blob([v.subarray(p, p + imgLen)], { type });
  return { blob, url: URL.createObjectURL(blob) };
}
