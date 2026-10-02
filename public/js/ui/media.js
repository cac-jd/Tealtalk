// Photos, videos and voice messages inside message bubbles, and the
// full-screen photo viewer.
//
// Encrypted media has no URL up front: the render model carries `load(onProgress)`
// and `loadThumb()`, which download, decrypt and resolve to an object URL.

import { h } from '../dom.js';
import { icon } from './common.js';

const PLAY = 'M8 5v14l11-7z';
const PAUSE = 'M6 19h4V5H6zm8-14v14h4V5z';
const CLOSE = 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z';
const DOWNLOAD = 'M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z';
const BROKEN = 'M21 5v6.6l-3-3-4 4-4-4-4 4-3-3V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2ZM3 19v-6.6l3 3 4-4 4 4 4-4 3 3V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z';

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rest = String(s % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** Reserve the box before the picture arrives, so the list doesn't jump when it loads. */
function reserveBox(el, att) {
  if (att.width > 0 && att.height > 0) {
    el.style.aspectRatio = `${att.width} / ${att.height}`;
    el.classList.add('has-ratio');
  }
}

/** Shown instead of a photo, video or voice message that can't be downloaded or decrypted. */
export function mediaErrorEl(text, onRetry) {
  const el = h(
    'div',
    { class: 'media-expired media-error', dataset: { testid: 'media-error' }, role: 'img', 'aria-label': text },
    icon(BROKEN),
    h('span', { text }),
  );
  if (onRetry) {
    el.appendChild(
      h('button', {
        type: 'button',
        class: 'btn link media-retry',
        text: 'Try again',
        onclick: (e) => {
          e.stopPropagation();
          onRetry(el);
        },
      }),
    );
  }
  return el;
}

/** Files up to this size are downloaded and decrypted as soon as they're shown. */
const AUTO_DOWNLOAD_BYTES = 40 * 1024 * 1024;
/** Thumbnails bigger than this aren't real thumbnails: wait for a tap. */
const MAX_AUTO_THUMB_BYTES = 1024 * 1024;

/**
 * May the preview of `att` download by itself? A thumbnail up to 1 MB; with no
 * thumbnail (the preview is the file itself), the same cap as for videos.
 */
function previewAutoLoads(att) {
  if (att.thumbSize === undefined || att.thumbSize === null) return true; // local or legacy: nothing to fetch
  return att.hasThumb ? att.thumbSize <= MAX_AUTO_THUMB_BYTES : att.thumbSize <= AUTO_DOWNLOAD_BYTES;
}

function formatSizeShort(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Decrypt the thumbnail into `img` (unless something newer was set meanwhile). */
function loadThumbInto(img, att) {
  const loader = att.loadThumb || att.load;
  if (!loader) return;
  img.classList.add('loading');
  loader()
    .then((url) => {
      img.classList.remove('loading');
      if (img.dataset.src) return;
      img.src = url;
      img.dataset.src = url;
    })
    .catch((err) => {
      img.classList.remove('loading');
      if (!img.isConnected || img.dataset.src) return;
      img.replaceWith(
        mediaErrorEl(err.message || 'Can’t decrypt this file', (box) => {
          const again = imageEl(att, { alt: img.alt, onLoad: () => {} });
          box.replaceWith(again);
        }),
      );
    });
}

export function imageEl(att, { alt, onLoad }) {
  const img = h('img', {
    class: 'message-image',
    dataset: { testid: 'message-image' },
    alt,
    decoding: 'async',
    draggable: 'false',
  });
  reserveBox(img, att);
  const src = att.thumbUrl || att.url;
  if (src) {
    img.src = src;
    img.dataset.src = src;
  } else if (!previewAutoLoads(att)) {
    return tapToLoadImage(att, img, { alt, onLoad });
  } else {
    loadThumbInto(img, att);
  }
  img.dataset.full = att.url || src || ''; // updated when the local preview becomes the server copy
  img.loadFull = att.load || null;
  img.addEventListener('load', onLoad);
  img.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const thumbUrl = img.currentSrc || img.src;
    if (img.loadFull) openViewer({ load: img.loadFull, thumbUrl, alt: img.alt });
    else openViewer({ url: img.dataset.full, thumbUrl, alt: img.alt });
  });
  return img;
}

/** A big photo (or an oversized thumbnail): a button first, the picture after a tap. */
function tapToLoadImage(att, img, { onLoad }) {
  const box = h('div', { class: 'video-poster secure image-load-box' });
  reserveBox(box, att);
  const size = att.thumbSize || att.size || 0;
  box.appendChild(
    h(
      'div',
      { class: 'media-status' },
      h(
        'button',
        {
          type: 'button',
          class: 'video-load',
          dataset: { testid: 'media-load' },
          'aria-label': `Load photo, ${formatSizeShort(size)}`,
          onclick: (e) => {
            e.stopPropagation();
            e.preventDefault();
            box.replaceWith(img);
            loadThumbInto(img, att);
          },
        },
        icon(DOWNLOAD),
        h('span', { text: formatSizeShort(size) }),
      ),
    ),
  );
  img.addEventListener('load', onLoad);
  return box;
}

/** Can this device play the file? (e.g. HEVC .mov from an iPhone on an older Android.) */
function canPlay(mime) {
  const probe = document.createElement('video');
  if (!probe.canPlayType) return true;
  if (probe.canPlayType(mime)) return true;
  // Most .mov files are H.264 in a QuickTime box, which MP4 players read fine;
  // if it really can't be decoded, the 'error' handler below switches to the link.
  return mime === 'video/quicktime' && !!probe.canPlayType('video/mp4');
}

function durationBadge(ms) {
  return ms ? h('span', { class: 'video-duration', text: formatDuration(ms) }) : null;
}

/**
 * The poster for a video (or the preview while uploading). `onPoster(url)` is
 * called once the decrypted thumbnail is ready (at once if it already was).
 */
function posterBox(att, extraClass = '', onPoster = null) {
  const box = h('div', { class: `video-poster ${extraClass}`.trim() });
  reserveBox(box, att);
  if (att.thumbUrl) {
    box.appendChild(h('img', { src: att.thumbUrl, alt: '', draggable: 'false' }));
    if (onPoster) onPoster(att.thumbUrl);
  } else if (att.loadThumb && previewAutoLoads(att)) {
    const img = h('img', { alt: '', draggable: 'false' });
    box.appendChild(img);
    att.loadThumb().then(
      (url) => {
        img.src = url;
        if (onPoster) onPoster(url);
      },
      () => img.remove(),
    );
  }
  return box;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * An encrypted video: poster first, then download (with progress), decrypt and
 * swap in the player. Big files wait for a tap. The player gets the poster from
 * the thumbnail decrypted for the poster box, whenever that arrives.
 */
function secureVideoEl(att, { onLoad }) {
  let posterUrl = att.thumbUrl || null;
  let player = null;
  const box = posterBox(att, 'secure', (url) => {
    posterUrl = url;
    if (player && player.tagName === 'VIDEO' && !player.poster) player.poster = url;
  });
  const status = h('div', { class: 'media-status' });
  box.appendChild(status);
  const d = durationBadge(att.durationMs);
  if (d) box.appendChild(d);

  const start = () => {
    status.replaceChildren(
      h('progress', { class: 'media-progress', dataset: { testid: 'media-progress' }, max: '100', value: '0', 'aria-label': 'Downloading video' }),
    );
    const bar = status.firstChild;
    att.load((f) => {
      bar.value = Math.round(f * 100);
    }).then(
      (url) => {
        if (!box.isConnected) return;
        player = playerEl({ ...att, url, thumbUrl: posterUrl }, { onLoad });
        box.replaceWith(player);
      },
      (err) => {
        status.replaceChildren(
          h('span', { class: 'media-note', text: err.message || 'Can’t decrypt this file' }),
          err.code === 'undecryptable' || err.code === 'gone'
            ? null
            : h('button', { type: 'button', class: 'btn link media-retry', text: 'Try again', onclick: (e) => (e.stopPropagation(), start()) }),
        );
      },
    );
  };

  if (att.size <= AUTO_DOWNLOAD_BYTES) {
    start();
  } else {
    status.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'video-load',
          dataset: { testid: 'media-load' },
          'aria-label': `Load video, ${formatSize(att.size)}`,
          onclick: (e) => {
            e.stopPropagation();
            start();
          },
        },
        icon(PLAY),
        h('span', { text: formatSize(att.size) }),
      ),
    );
  }
  return box;
}

function downloadFallback(att) {
  const box = posterBox(att, 'unplayable');
  box.appendChild(
    h(
      'a',
      {
        class: 'video-download',
        dataset: { testid: 'message-video-download' },
        href: att.url,
        download: '',
        rel: 'noopener',
      },
      icon(DOWNLOAD),
      h('span', { text: 'Download to watch' }),
    ),
  );
  box.appendChild(h('span', { class: 'video-note', text: "This phone can't play this video here." }));
  return box;
}

export function videoEl(att, { onLoad }) {
  if (att.pending || (!att.url && !att.load)) {
    // Still uploading: the poster, with a play mark.
    const box = posterBox(att, 'pending');
    box.appendChild(h('span', { class: 'video-play', 'aria-hidden': 'true' }, icon(PLAY)));
    const d = durationBadge(att.durationMs);
    if (d) box.appendChild(d);
    return box;
  }
  if (!att.url && att.load) return secureVideoEl(att, { onLoad });
  return playerEl(att, { onLoad });
}

function playerEl(att, { onLoad }) {
  if (!canPlay(att.mime)) return downloadFallback(att);
  const video = h('video', {
    class: 'message-video',
    dataset: { testid: 'message-video' },
    controls: true,
    playsinline: true,
    'webkit-playsinline': true,
    preload: 'metadata',
    'aria-label': 'Video',
  });
  video.playsInline = true;
  reserveBox(video, att);
  if (att.thumbUrl) video.poster = att.thumbUrl;
  const fallBack = () => {
    if (video.isConnected) video.replaceWith(downloadFallback(att));
  };
  video.addEventListener('error', fallBack);
  video.addEventListener('loadedmetadata', () => {
    // Audio track decodes but the picture doesn't: nothing useful to show.
    if (!video.videoWidth && att.width) fallBack();
    else onLoad();
  });
  video.src = att.url;
  return video;
}

// ---------- voice messages ----------

let playing = null;

export function audioEl(att, { label }) {
  const audio = h('audio', { preload: 'metadata' });
  const button = h('button', { type: 'button', class: 'audio-toggle', 'aria-label': `Play ${label}` }, icon(PLAY));
  const fill = h('span', { class: 'audio-fill' });
  const track = h(
    'span',
    {
      class: 'audio-track',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Position',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    },
    fill,
  );
  const time = h('span', { class: 'audio-time', text: formatDuration(att.durationMs || 0) });
  const el = h(
    'div',
    { class: 'message-audio', dataset: { testid: 'message-audio' }, role: 'group', 'aria-label': label },
    button,
    track,
    time,
    audio,
  );

  // Encrypted: decrypt first (voice messages are small), then it plays like any other.
  let url = att.url || null;
  let wantPlay = false;
  if (!url && att.load) {
    el.classList.add('loading');
    att.load().then(
      (u) => {
        url = u;
        el.classList.remove('loading');
        if (!audio.src) audio.src = u;
        if (wantPlay) button.click();
      },
      (err) => {
        el.classList.remove('loading');
        el.classList.add('audio-error');
        time.textContent = err.code === 'undecryptable' ? 'Can’t decrypt' : 'Can’t play';
      },
    );
  }

  const duration = () => {
    if (att.durationMs) return att.durationMs / 1000;
    // Recorded WebM often reports Infinity until fully read.
    return Number.isFinite(audio.duration) ? audio.duration : 0;
  };
  const update = () => {
    const d = duration();
    const t = audio.currentTime || 0;
    const f = d ? Math.min(1, t / d) : 0;
    fill.style.transform = `scaleX(${f})`;
    track.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    time.textContent = formatDuration(((audio.paused && t === 0) || !d ? d : d - t) * 1000);
  };
  const setIcon = () => {
    const isPlaying = !audio.paused && !audio.ended;
    button.replaceChildren(icon(isPlaying ? PAUSE : PLAY));
    button.setAttribute('aria-label', `${isPlaying ? 'Pause' : 'Play'} ${label}`);
    el.classList.toggle('playing', isPlaying);
  };

  button.addEventListener('click', () => {
    if (!url) {
      wantPlay = true;
      return;
    }
    wantPlay = false;
    if (!audio.src) audio.src = url;
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  });
  const seek = (fraction) => {
    const d = duration();
    if (!d || !url) return;
    if (!audio.src) audio.src = url;
    audio.currentTime = Math.max(0, Math.min(d, fraction * d));
    update();
  };
  track.addEventListener('click', (e) => {
    const r = track.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width);
  });
  track.addEventListener('keydown', (e) => {
    const d = duration();
    if (!d) return;
    const step = 5 / d;
    const now = (audio.currentTime || 0) / d;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seek(now + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seek(now - step);
    else return;
    e.preventDefault();
  });
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('loadedmetadata', update);
  audio.addEventListener('durationchange', update);
  audio.addEventListener('play', setIcon);
  audio.addEventListener('pause', setIcon);
  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    setIcon();
    update();
  });
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    el.classList.add('audio-error');
    time.textContent = "Can't play";
  });
  if (url) audio.src = url;
  return el;
}

// ---------- expired / unavailable ----------

const GONE = { image: 'Photo no longer available', video: 'Video no longer available', audio: 'Voice message no longer available' };

export function expiredEl(kind) {
  return h(
    'div',
    { class: 'media-expired', role: 'img', 'aria-label': GONE[kind] || 'Attachment no longer available' },
    icon(BROKEN),
    h('span', { text: GONE[kind] || 'Attachment no longer available' }),
  );
}

// ---------- full-screen photo viewer ----------

let viewer = null;
let returnFocus = null;

/** load: for encrypted photos, resolves to the decrypted original's URL. */
export function openViewer({ url, thumbUrl, alt, load }) {
  closeViewer();
  returnFocus = document.activeElement;
  const img = h('img', { class: 'viewer-image', alt: alt || 'Photo', draggable: 'false' });
  // Show the thumbnail at once, then the full-resolution original when it has loaded.
  if (thumbUrl || url) img.src = thumbUrl || url;
  const showFull = (fullUrl) => {
    if (!fullUrl || fullUrl === thumbUrl) return;
    const full = new Image();
    full.onload = () => {
      if (viewer && viewer.contains(img)) img.src = fullUrl;
    };
    full.src = fullUrl;
  };
  if (load) {
    load().then(showFull, () => {
      if (viewer && viewer.contains(img)) viewer.classList.add('viewer-failed');
    });
  } else {
    showFull(url);
  }
  const close = h(
    'button',
    { type: 'button', class: 'viewer-close', dataset: { testid: 'image-viewer-close' }, 'aria-label': 'Close photo' },
    icon(CLOSE),
  );
  const stage = h('div', { class: 'viewer-stage' }, img);
  viewer = h(
    'div',
    {
      class: 'viewer',
      dataset: { testid: 'image-viewer' },
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': alt || 'Photo',
      tabindex: '-1',
    },
    stage,
    close,
  );
  close.addEventListener('click', closeViewer);
  // Tap/click the photo to switch between fitting the screen and actual size
  // (pinch-zoom also works: the page isn't locked against zooming).
  img.addEventListener('click', (e) => {
    const zoomed = viewer.classList.toggle('zoomed');
    if (zoomed) {
      // Keep the tapped spot under the finger.
      requestAnimationFrame(() => {
        const rx = e.offsetX / (e.target.clientWidth || 1);
        const ry = e.offsetY / (e.target.clientHeight || 1);
        stage.scrollLeft = img.naturalWidth * rx - stage.clientWidth / 2;
        stage.scrollTop = img.naturalHeight * ry - stage.clientHeight / 2;
      });
    }
  });
  stage.addEventListener('click', (e) => {
    if (e.target === stage) closeViewer();
  });
  viewer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeViewer();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // one control: keep focus inside the dialog
      close.focus();
    }
  });
  document.getElementById('app').appendChild(viewer);
  close.focus();
}

export function closeViewer() {
  if (!viewer) return;
  viewer.remove();
  viewer = null;
  if (returnFocus && returnFocus.isConnected && returnFocus.focus) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

export function viewerOpen() {
  return !!viewer;
}
