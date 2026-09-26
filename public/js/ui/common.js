// Shared UI bits: toasts, screen-reader announcements, icons.

let toastTimer = null;

export function toast(text, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

let announceTimer = null;

/** Polite screen-reader announcement (e.g. "New message from Sam"). */
export function announce(text) {
  const el = document.getElementById('announcer');
  // Clear first so repeating the same text is announced again.
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    el.textContent = text;
  }, 50);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build a small inline SVG icon from a path (no innerHTML). */
export function icon(pathData) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  return svg;
}

export const ICONS = {
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  close: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z',
};

// ---------- back navigation ----------

let currentHash = location.hash || '#/';
let previousHash = null;
window.addEventListener('hashchange', () => {
  previousHash = currentHash;
  currentHash = location.hash || '#/';
});

/** Go back to `hash`: a real history step when that's where we came from (Android back stays right). */
export function backTo(hash) {
  if (previousHash === hash) history.back();
  else location.hash = hash;
}
