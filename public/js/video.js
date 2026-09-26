// Videos go as the original file. This only reads their size and length and
// grabs a poster frame for the chat bubble; any of that may fail (codec the
// device can't decode, strict browsers) and the video is still sent.

import { drawScaled, toJpeg } from './images.js';

export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const POSTER_SIDE = 480;
const STEP_TIMEOUT_MS = 6000;

/** The type the server should store: fixes empty or odd types from some pickers. */
export function videoMime(file) {
  const type = (file.type || '').toLowerCase().split(';')[0].trim();
  if (VIDEO_TYPES.includes(type)) return type;
  if (type === 'video/x-m4v' || type === 'video/3gpp') return 'video/mp4';
  const ext = (file.name || '').toLowerCase().split('.').pop();
  if (ext === 'mov' || ext === 'qt') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mp4' || ext === 'm4v' || ext === '3gp') return 'video/mp4';
  return type.startsWith('video/') ? 'video/mp4' : null;
}

function once(target, events, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeout);
    const handlers = {};
    function done(fn, value) {
      clearTimeout(timer);
      for (const [e, h] of Object.entries(handlers)) target.removeEventListener(e, h);
      fn(value);
    }
    for (const e of events) {
      handlers[e] = (ev) => (e === 'error' ? done(reject, new Error('media error')) : done(resolve, ev));
      target.addEventListener(e, handlers[e]);
    }
  });
}

/**
 * Returns { width, height, durationMs, poster } (poster: small JPEG Blob) with
 * nulls for anything the browser couldn't read.
 */
export async function prepareVideo(file) {
  const out = { width: null, height: null, durationMs: null, poster: null };
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  try {
    video.src = url;
    await once(video, ['loadedmetadata', 'error'], STEP_TIMEOUT_MS);
    if (video.videoWidth && video.videoHeight) {
      out.width = video.videoWidth;
      out.height = video.videoHeight;
    }
    if (Number.isFinite(video.duration) && video.duration > 0) out.durationMs = Math.round(video.duration * 1000);
    if (!out.width) return out; // no decodable picture (e.g. HEVC here): generic poster

    // An early frame, not the very first one (often black).
    const target = Math.min(0.1, (video.duration || 0.2) / 2);
    if (video.readyState < 2) {
      try {
        await once(video, ['loadeddata', 'error'], STEP_TIMEOUT_MS);
      } catch {
        // iOS Safari sometimes loads nothing until playback is attempted.
        await video.play().catch(() => {});
        video.pause();
      }
    }
    const seeked = once(video, ['seeked', 'error'], STEP_TIMEOUT_MS);
    video.currentTime = target;
    await seeked;
    const canvas = drawScaled(video, POSTER_SIDE, { width: video.videoWidth, height: video.videoHeight });
    out.poster = await toJpeg(canvas, 0.8);
  } catch {
    /* keep whatever we learned; the bubble shows a generic poster */
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
  return out;
}
