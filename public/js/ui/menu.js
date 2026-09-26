// The message menu: quick reactions plus Reply / Copy / Edit / Unsend.
// Opened by a long-press on touch screens, or right-click / the "..." button
// on desktop. Keyboard: arrows move, Enter/Space choose, Escape closes.

import { h } from '../dom.js';

export const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

let menu = null;
let backdrop = null;
let returnFocus = null;
let anchorEl = null;

export function menuOpen() {
  return !!menu;
}

export function closeMenu({ restoreFocus = true } = {}) {
  if (!menu) return;
  menu.remove();
  backdrop.remove();
  menu = null;
  backdrop = null;
  if (anchorEl) anchorEl.classList.remove('menu-target');
  anchorEl = null;
  if (restoreFocus && returnFocus && returnFocus.isConnected && returnFocus.focus) {
    returnFocus.focus({ preventScroll: true });
  }
  returnFocus = null;
}

/**
 * anchor: the message element; label: what the menu is about (for screen readers)
 * myReaction: my current emoji or null; onReact(emoji): toggle that reaction
 * actions: [{ testid, label, danger?, run() }]
 */
export function openMenu({ anchor, bubble, label, canReact, myReaction, onReact, actions, returnTo }) {
  closeMenu({ restoreFocus: false });
  returnFocus = returnTo || document.activeElement;
  anchorEl = anchor;
  anchor.classList.add('menu-target');

  const choose = (fn) => () => {
    closeMenu();
    fn();
  };

  const items = [];
  let reactionRow = null;
  if (canReact) {
    reactionRow = h('div', { class: 'reaction-row', role: 'group', 'aria-label': 'React' });
    for (const emoji of QUICK_REACTIONS) {
      const mine = emoji === myReaction;
      const b = h('button', {
        type: 'button',
        class: `reaction-option${mine ? ' selected' : ''}`,
        role: 'menuitemcheckbox',
        'aria-checked': mine ? 'true' : 'false',
        'aria-label': mine ? `Remove your ${emoji} reaction` : `React with ${emoji}`,
        dataset: { testid: 'reaction-option', emoji },
        text: emoji,
        onclick: choose(() => onReact(emoji)),
      });
      items.push(b);
      reactionRow.appendChild(b);
    }
  }
  const list = h('div', { class: 'menu-actions' });
  for (const a of actions) {
    const b = h('button', {
      type: 'button',
      class: `menu-item${a.danger ? ' danger' : ''}`,
      role: 'menuitem',
      dataset: { testid: a.testid },
      text: a.label,
      onclick: choose(a.run),
    });
    items.push(b);
    list.appendChild(b);
  }
  if (!items.length) {
    anchor.classList.remove('menu-target');
    anchorEl = null;
    return;
  }

  menu = h(
    'div',
    { class: 'message-menu', dataset: { testid: 'message-menu' }, role: 'menu', 'aria-label': label },
    reactionRow,
    actions.length ? list : null,
  );
  backdrop = h('div', { class: 'menu-backdrop' });
  // Only a tap that starts on the backdrop closes it: lifting the finger that
  // long-pressed to open the menu can produce a click here too.
  let armed = false;
  backdrop.addEventListener('pointerdown', () => {
    armed = true;
  });
  backdrop.addEventListener('click', () => {
    if (armed) closeMenu();
  });
  backdrop.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeMenu();
  });
  // Roving focus.
  for (const b of items) b.tabIndex = -1;
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    } else if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
    }
  });

  const app = document.getElementById('app');
  menu.style.visibility = 'hidden';
  app.appendChild(backdrop);
  app.appendChild(menu);
  position(menu, (bubble || anchor).getBoundingClientRect(), anchor.classList.contains('mine'));
  menu.style.visibility = '';
  items[0].focus({ preventScroll: true });
}

/** Above the bubble if it fits, else below, else over it; always on screen. */
function position(el, r, mine) {
  const margin = 8;
  const vw = document.documentElement.clientWidth;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const top0 = margin;
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let top;
  if (r.top - hgt - margin >= top0 + 48) top = r.top - hgt - margin;
  else if (r.bottom + hgt + margin <= vh - margin) top = r.bottom + margin;
  else top = Math.max(top0, (vh - hgt) / 2);
  let left = mine ? r.right - w : r.left;
  left = Math.max(margin, Math.min(left, vw - w - margin));
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}
