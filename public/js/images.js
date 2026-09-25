// Client-side photo downscaling: longest side <= 1600px, re-encoded as JPEG.
// Keeps uploads small on mobile data and strips EXIF metadata (location!).

const MAX_SIDE = 1600;
const QUALITY = 0.85;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> (e.g. HEIC on Safari) */
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

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', QUALITY);
  });
}

/**
 * Returns a Blob ready for upload. Animated GIFs are passed through untouched
 * (re-encoding would drop the animation).
 */
export async function prepareImage(file) {
  if (file.type === 'image/gif') return file;
  let source;
  try {
    source = await decode(file);
  } catch {
    if (ACCEPTED.includes(file.type)) return file;
    throw new Error('That image format is not supported.');
  }
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha; flatten transparent PNGs onto white
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  if (source.close) source.close();
  return toBlob(canvas);
}
