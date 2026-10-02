// Safety number screen: the 60 digits you compare with a contact in person or on
// a call, and marking them verified.

import { avatar, clear } from '../dom.js';
import { on, getConversation, userName } from '../store.js';
import { safetyNumberWith, contactInfo, markVerified, unmarkVerified, MissingKeysError } from '../e2ee.js';
import { formatSafetyNumber } from '../crypto/safety.js';
import { announce, backTo } from './common.js';

const $ = (id) => document.getElementById(id);

let convId = null;
let userId = null;
let shownKeyId = null;
let seq = 0;

export function openSafetyScreen(conversationId, targetId) {
  convId = conversationId;
  userId = targetId;
  shownKeyId = null;
  const mySeq = ++seq;
  const conv = getConversation(convId);
  const name = userName(conv, userId);
  const holder = $('safety-avatar');
  clear(holder);
  holder.appendChild(avatar(userId, name, 'large'));
  $('safety-name').textContent = name;
  $('safety-explain').textContent =
    `Compare these numbers with ${name}, in person or on a call. If they match on both phones, ` +
    'nobody can secretly read your messages. They change if either of you gets a new key.';
  const number = $('safety-number');
  number.textContent = 'Calculating…';
  number.classList.add('pending');
  $('safety-error').hidden = true;
  renderVerified();
  safetyNumberWith(userId).then(
    ({ digits, keyId }) => {
      if (mySeq !== seq) return;
      shownKeyId = keyId;
      number.textContent = formatSafetyNumber(digits);
      number.classList.remove('pending');
      renderVerified();
    },
    (err) => {
      if (mySeq !== seq) return;
      number.textContent = '';
      const el = $('safety-error');
      el.textContent =
        err instanceof MissingKeysError
          ? `${name} hasn’t opened TealTalk since encryption arrived, so there’s no safety number yet.`
          : 'Couldn’t load the safety number. Check your connection and try again.';
      el.hidden = false;
      renderVerified();
    },
  );
}

export function closeSafetyScreen() {
  seq++;
  convId = null;
  userId = null;
  shownKeyId = null;
}

function renderVerified() {
  const info = userId ? contactInfo(userId) : null;
  const verified = !!(info && info.verified && info.keyId === shownKeyId);
  const ready = !!shownKeyId;
  $('mark-verified-button').hidden = !ready || verified;
  $('unmark-verified-button').hidden = !ready || !verified;
  $('safety-status').textContent = !ready ? '' : verified ? 'You verified this safety number.' : 'Not verified yet.';
  const badge = $('safety-verified-badge');
  badge.hidden = !verified;
}

export function initSafety() {
  $('safety-back').addEventListener('click', () => {
    const conv = convId && getConversation(convId);
    backTo(convId ? `#/c/${encodeURIComponent(convId)}${conv && conv.isGroup ? '/info' : ''}` : '#/');
  });
  $('mark-verified-button').addEventListener('click', () => {
    if (!userId || !shownKeyId) return;
    if (markVerified(userId, shownKeyId)) announce('Marked as verified');
    renderVerified();
  });
  $('unmark-verified-button').addEventListener('click', () => {
    if (!userId) return;
    unmarkVerified(userId);
    announce('No longer verified');
    renderVerified();
  });
  on('safety', (id) => {
    if (id === userId && !$('safety-screen').hidden) {
      const info = contactInfo(id);
      // Their key changed while the screen was open: show the new number.
      if (info && shownKeyId && info.keyId !== shownKeyId) openSafetyScreen(convId, userId);
      else renderVerified();
    }
  });
}
