// Small DOM helpers. User content only ever goes through textContent.

/**
 * Create an element.
 *   h('div', { class: 'x', dataset: { testid: 'y' }, onclick: fn }, 'text', child)
 * Strings become text nodes (never parsed as HTML).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

/** Find an element by data-testid inside root. */
export function byTestId(id, root = document) {
  return root.querySelector(`[data-testid="${id}"]`);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function show(el, visible) {
  el.hidden = !visible;
}

// ---- formatting ----

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const longDateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const yearDateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function formatTime(ts) {
  return timeFmt.format(ts);
}

/** Compact timestamp for the chat list. */
export function formatListTime(ts) {
  const today = startOfDay(Date.now());
  if (ts >= today) return timeFmt.format(ts);
  if (ts >= today - 6 * 86400000) return weekdayFmt.format(ts);
  return shortDateFmt.format(ts);
}

/** Label for a day separator in a chat. */
export function formatDay(ts) {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return 'Today';
  if (day === today - 86400000) return 'Yesterday';
  if (new Date(ts).getFullYear() === new Date().getFullYear()) return longDateFmt.format(ts);
  return yearDateFmt.format(ts);
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] || '';
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] || '' : '';
  return (first + last).toUpperCase();
}

/** Stable small hash -> avatar colour class index. */
export function colorIndex(seed, buckets = 8) {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % buckets;
}

export function avatar(seed, name, extraClass = '') {
  return h('span', {
    class: `avatar av-${colorIndex(seed)} ${extraClass}`.trim(),
    'aria-hidden': 'true',
    text: initials(name),
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Read/write localStorage defensively (private mode, quota, etc). */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota / private mode */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older engines (RFC 4122 v4 from getRandomValues).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const isTouchDevice = () =>
  window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
