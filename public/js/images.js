// Photos go at full resolution: the original file is never downscaled or
// re-encoded. For JPEGs the GPS location is removed from the EXIF data in place
// (same bytes otherwise, orientation kept). The chat bubble shows a small JPEG
// thumbnail instead of the original.

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const THUMB_SIDE = 480;
const THUMB_QUALITY = 0.8;
/** Small images are their own thumbnail. */
const THUMB_SKIP_BYTES = 200 * 1024;
/** Bytes read to find the metadata (it sits before the image data). */
const HEAD_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// EXIF GPS removal

class ExifError extends Error {}

/** Size in bytes of one value of each TIFF field type. */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const TAG_GPS_IFD = 0x8825;

/**
 * Blank the GPS IFD of the TIFF block u8[start, end) (an APP1 Exif payload after
 * "Exif\0\0"). Validates everything before writing, so a malformed block is
 * never half-modified. Returns true if GPS data was found and blanked.
 */
function stripTiffGps(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const need = (pos, len) => {
    if (pos < start || pos + len > end) throw new ExifError('EXIF offset out of range');
  };
  need(start, 8);
  const order = dv.getUint16(start);
  if (order !== 0x4949 && order !== 0x4d4d) throw new ExifError('bad TIFF byte order');
  const le = order === 0x4949;
  const u16 = (p) => (need(p, 2), dv.getUint16(p, le));
  const u32 = (p) => (need(p, 4), dv.getUint32(p, le));
  if (u16(start + 2) !== 42) throw new ExifError('bad TIFF magic');

  const ifd0 = start + u32(start + 4);
  const n0 = u16(ifd0);
  need(ifd0 + 2, n0 * 12);
  let gpsOffset = null;
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (u16(e) === TAG_GPS_IFD) gpsOffset = u32(e + 8);
  }
  if (gpsOffset === null) return false;

  const gps = start + gpsOffset;
  const n = u16(gps);
  if (n === 0) return false; // already empty
  need(gps + 2, n * 12);
  const blank = [];
  for (let i = 0; i < n; i++) {
    const e = gps + 2 + i * 12;
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = (TYPE_SIZE[type] || 0) * count;
    if (size > 4) {
      const at = start + u32(e + 8);
      need(at, size);
      blank.push([at, at + size]);
    }
    blank.push([e, e + 12]); // the entry itself: tag, type, count and inline value
  }
  // Everything checked: now write. An IFD with 0 entries whose "next IFD" offset
  // (the old first entry, zeroed) is 0 is a valid, empty GPS IFD.
  for (const [a, b] of blank) u8.fill(0, a, b);
  dv.setUint16(gps, 0, le);
  return true;
}

const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';

/** XMP can repeat the location as exif:GPS... properties: blank their values (same length). */
function blankXmpGps(u8, start, end) {
  let text = '';
  for (let i = start; i < end; i++) text += String.fromCharCode(u8[i]);
  let changed = false;
  const blankRange = (from, to) => {
    for (let i = from; i < to; i++) u8[start + i] = 0x20;
    changed = true;
  };
  // Attribute form: exif:GPSLatitude="47,36.5N"
  for (const m of text.matchAll(/exif:GPS\w+\s*=\s*(["'])([^"']*)\1/g)) {
    const valueAt = m.index + m[0].length - 1 - m[2].length;
    blankRange(valueAt, valueAt + m[2].length);
  }
  // Element form: <exif:GPSLatitude>47,36.5N</exif:GPSLatitude>
  for (const m of text.matchAll(/<exif:(GPS\w+)(\s[^>]*)?>([\s\S]*?)<\/exif:\1>/g)) {
    const inner = m[3];
    const valueAt = m.index + m[0].length - `</exif:${m[1]}>`.length - inner.length;
    // Keep nested tags (rdf:Seq etc.) intact, blank only the text between them.
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === '<') {
        i = inner.indexOf('>', i) + 1 || inner.length;
        continue;
      }
      const next = inner.indexOf('<', i);
      const stop = next === -1 ? inner.length : next;
      if (inner.slice(i, stop).trim()) blankRange(valueAt + i, valueAt + stop);
      i = stop;
    }
  }
  return changed;
}

function startsWith(u8, at, ascii) {
  if (at + ascii.length > u8.length) return false;
  for (let i = 0; i < ascii.length; i++) if (u8[at + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

/** True if the bytes contain what looks like a GPS IFD pointer entry (either byte order). */
function mentionsGpsPointer(u8, start, end) {
  for (let i = start; i + 4 <= end; i++) {
    if (u8[i] === 0x88 && u8[i + 1] === 0x25 && u8[i + 2] === 0x00 && u8[i + 3] === 0x04) return true;
    if (u8[i] === 0x25 && u8[i + 1] === 0x88 && u8[i + 2] === 0x04 && u8[i + 3] === 0x00) return true;
  }
  return false;
}

/**
 * Remove GPS data from a JPEG held in `u8` (modified in place). Only the part
 * before the image data is looked at, so `u8` may be just the file's head.
 * Returns { changed, gpsFound, error, needMore }.
 */
export function stripJpegGps(u8) {
  const result = { changed: false, gpsFound: false, error: null, needMore: false };
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) {
    result.error = 'not a JPEG';
    return result;
  }
  let p = 2;
  try {
    while (p + 4 <= u8.length) {
      if (u8[p] !== 0xff) throw new ExifError('bad JPEG marker');
      const marker = u8[p + 1];
      if (marker === 0xff) {
        p++; // fill byte
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        p += 2; // markers without a length
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return result; // image data starts: no more metadata
      const len = (u8[p + 2] << 8) | u8[p + 3];
      if (len < 2) throw new ExifError('bad segment length');
      const start = p + 4;
      const end = p + 2 + len;
      if (end > u8.length) {
        result.needMore = true;
        return result;
      }
      if (marker === 0xe1 && startsWith(u8, start, 'Exif\0\0')) {
        try {
          if (stripTiffGps(u8, start + 6, end)) {
            result.gpsFound = true;
            result.changed = true;
          }
        } catch (err) {
          // Unreadable EXIF. Only safe to send as-is if it has no GPS pointer at all.
          if (mentionsGpsPointer(u8, start, end)) {
            result.gpsFound = true;
            throw err;
          }
        }
      } else if (marker === 0xe1 && startsWith(u8, start, XMP_SIG)) {
        if (blankXmpGps(u8, start + XMP_SIG.length, end)) result.changed = true;
      }
      p = end;
    }
    // Ran out of bytes before the image data.
    result.needMore = true;
  } catch (err) {
    result.error = err.message || 'unreadable EXIF';
  }
  return result;
}

/**
 * The file to upload: the original, with GPS removed from JPEGs. If a JPEG's
 * EXIF can't be parsed but does contain a GPS pointer, falls back to a
 * full-resolution re-encode (drops all metadata) rather than leak the location.
 */
async function withoutLocation(file, mime) {
  if (mime !== 'image/jpeg') return file;
  let headLen = Math.min(file.size, HEAD_BYTES);
  for (;;) {
    const head = new Uint8Array(await file.slice(0, headLen).arrayBuffer());
    const r = stripJpegGps(head);
    if (r.needMore && !r.error && headLen < file.size) {
      headLen = file.size; // metadata larger than expected: read it all
      continue;
    }
    if (r.error) {
      if (r.gpsFound) return reencodeFullSize(file);
      return file; // no location in it: send the original untouched
    }
    if (!r.changed) return file;
    return new Blob([head, file.slice(headLen)], { type: mime });
  }
}

// ---------------------------------------------------------------------------
// decoding, thumbnails

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> (e.g. HEIC on Safari, or no options support) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const sizeOf = (source) => ({
  width: source.naturalWidth || source.width,
  height: source.naturalHeight || source.height,
});

export function toJpeg(canvas, quality = THUMB_QUALITY) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality);
  });
}

/** Draw `source` (image, bitmap or video) onto a canvas no larger than maxSide. */
export function drawScaled(source, maxSide, { maxPixels = Infinity, width, height } = {}) {
  const natural = sizeOf(source);
  const sw = width || natural.width || source.videoWidth;
  const sh = height || natural.height || source.videoHeight;
  let scale = Math.min(1, maxSide / Math.max(sw, sh));
  if (sw * sh * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (sw * sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha: flatten transparent images onto white
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

/** Last resort for formats the server doesn't take (HEIC etc.) or unreadable EXIF. */
async function reencodeFullSize(file) {
  const source = await decode(file);
  try {
    // iOS Safari refuses canvases above ~16.7 megapixels.
    return await toJpeg(drawScaled(source, Infinity, { maxPixels: 16_000_000 }), 0.95);
  } finally {
    if (source.close) source.close();
  }
}

/**
 * Prepare a picked photo for sending.
 * Returns { file, mime, width, height, thumbnail } where `file` is the full
 * resolution original (GPS removed) and `thumbnail` a small JPEG Blob, or null
 * when the photo is small enough to show as is.
 */
export async function prepareImage(input) {
  let file = input;
  let mime = file.type;
  if (!IMAGE_TYPES.includes(mime)) {
    try {
      file = await reencodeFullSize(file);
    } catch {
      throw new Error('That image format is not supported.');
    }
    mime = 'image/jpeg';
  } else {
    file = await withoutLocation(file, mime);
  }

  let width = null;
  let height = null;
  let thumbnail = null;
  let source = null;
  try {
    source = await decode(file);
    ({ width, height } = sizeOf(source));
    const small = Math.max(width, height) <= THUMB_SIDE && file.size <= THUMB_SKIP_BYTES;
    // Animated GIFs show as themselves: a still thumbnail would stop the animation.
    if (!small && mime !== 'image/gif') thumbnail = await toJpeg(drawScaled(source, THUMB_SIDE));
  } catch {
    /* no preview: the bubble falls back to the original */
  } finally {
    if (source && source.close) source.close();
  }
  return { file: file.type === mime ? file : new Blob([file], { type: mime }), mime, width, height, thumbnail };
}

// ---------------------------------------------------------------------------
// self-check (from tests or the console: (await import('/js/images.js')).exifSelfCheck())

/** Build a tiny JPEG with an EXIF block holding Orientation=6 and a GPS IFD. */
function sampleJpeg(le) {
  const tiff = new Uint8Array(160);
  const dv = new DataView(tiff.buffer);
  tiff.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);
  // IFD0 at 8: Orientation and the GPS pointer
  dv.setUint16(8, 2, le);
  dv.setUint16(10, 0x0112, le); // Orientation SHORT 1 = 6
  dv.setUint16(12, 3, le);
  dv.setUint32(14, 1, le);
  dv.setUint16(18, 6, le);
  dv.setUint16(22, TAG_GPS_IFD, le); // GPS pointer LONG 1 -> 38
  dv.setUint16(24, 4, le);
  dv.setUint32(26, 1, le);
  dv.setUint32(30, 38, le);
  dv.setUint32(34, 0, le); // no IFD1
  // GPS IFD at 38: 3 entries
  dv.setUint16(38, 3, le);
  dv.setUint16(40, 1, le); // GPSLatitudeRef ASCII 2 "N"
  dv.setUint16(42, 2, le);
  dv.setUint32(44, 2, le);
  tiff[48] = 0x4e;
  dv.setUint16(52, 2, le); // GPSLatitude RATIONAL 3 -> 80
  dv.setUint16(54, 5, le);
  dv.setUint32(56, 3, le);
  dv.setUint32(60, 80, le);
  dv.setUint16(64, 4, le); // GPSLongitude RATIONAL 3 -> 104
  dv.setUint16(66, 5, le);
  dv.setUint32(68, 3, le);
  dv.setUint32(72, 104, le);
  dv.setUint32(76, 0, le);
  for (let i = 0; i < 6; i++) {
    dv.setUint32(80 + i * 4, 47 + i, le);
    dv.setUint32(104 + i * 4, 122 + i, le);
  }
  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  payload.set(tiff, 6);
  const len = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...payload, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
}

/** Returns a list of problems (empty when EXIF GPS removal works). */
export function exifSelfCheck() {
  const problems = [];
  for (const le of [true, false]) {
    const label = le ? 'little-endian' : 'big-endian';
    const jpeg = sampleJpeg(le);
    const before = jpeg.length;
    const r = stripJpegGps(jpeg);
    const tiff = new DataView(jpeg.buffer, 12);
    const bytes = new Uint8Array(jpeg.buffer, 12);
    if (!r.changed || !r.gpsFound || r.error) problems.push(`${label}: not stripped (${JSON.stringify(r)})`);
    if (jpeg.length !== before) problems.push(`${label}: length changed`);
    if (tiff.getUint16(18, le) !== 6) problems.push(`${label}: orientation lost`);
    if (tiff.getUint16(22, le) !== TAG_GPS_IFD) problems.push(`${label}: GPS pointer entry damaged`);
    if (tiff.getUint16(38, le) !== 0) problems.push(`${label}: GPS IFD still has entries`);
    if (bytes.slice(38, 128).some((b) => b !== 0)) problems.push(`${label}: GPS bytes left`);
    if (jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) problems.push(`${label}: image data touched`);
    const again = stripJpegGps(jpeg); // nothing left to do the second time
    if (again.changed || again.error) problems.push(`${label}: second pass ${JSON.stringify(again)}`);
  }
  // Corrupt EXIF that has a GPS pointer must be reported, never passed through.
  const bad = sampleJpeg(true);
  new DataView(bad.buffer, 12).setUint32(30, 5000, true); // GPS offset out of range
  const r = stripJpegGps(bad);
  if (!r.error || !r.gpsFound) problems.push(`corrupt EXIF not flagged: ${JSON.stringify(r)}`);
  return problems;
}
