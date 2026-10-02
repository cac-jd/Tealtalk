// Encryption key screens: setting up (or the error if it can't), showing the
// recovery key once (confirmed by re-typing its last group; it's never stored),
// and entering it on a new device or after the key changed elsewhere (or starting fresh).

import { getKeyState, loadKeys, recover, resetKeys, confirmRecoverySaved, recoveryKeyText } from '../e2ee.js';
import { RecoveryKeyFormatError, RecoveryError } from '../crypto/keys.js';
import { state } from '../store.js';
import { toast } from './common.js';
import { formatTime, formatDay } from '../dom.js';

const $ = (id) => document.getElementById(id);

export const START_FRESH_WARNING =
  'Start fresh with a new key?\n\nMessages sent to your old key stay readable only on devices that already have it, ' +
  'and your contacts will see that your safety number changed.';

export function renderKeySetup() {
  const { state: st, error } = getKeyState();
  const failed = st === 'error';
  $('key-setup-text').textContent = failed ? 'Encryption couldn’t be set up.' : 'Setting up encryption…';
  const err = $('key-setup-error');
  err.textContent = failed ? error : '';
  err.hidden = !failed;
  $('key-setup-retry').hidden = !failed;
}

/** The recovery key, shown once right after a key is made. TealTalk keeps no copy. */
export function showRecoveryKey({ settings = false } = {}) {
  const text = recoveryKeyText();
  if (settings && !text) {
    // Old link to "Show recovery key": it can't be shown again.
    location.hash = '#/settings';
    return;
  }
  $('recovery-key-display').textContent = text;
  $('recovery-key-intro').textContent =
    'Write this down and keep it somewhere safe. It’s the only way to read your messages on a new phone or after logging out. ' +
    'TealTalk shows it only this once and can’t show it again or reset it for you.';
  $('recovery-confirm-input').value = '';
  showConfirmError('');
}

function showConfirmError(text) {
  const el = $('recovery-confirm-error');
  el.textContent = text;
  el.hidden = !text;
}

function when(ts) {
  return `${formatDay(ts)} ${formatTime(ts)}`;
}

export function showRecoveryEntry() {
  const { conflict } = getKeyState();
  const box = $('key-conflict-screen');
  box.hidden = !conflict;
  $('key-conflict-text').textContent = conflict
    ? `Your key was changed on another device at ${when(conflict.at)}. If this wasn’t you, reset your key and change your password.`
    : '';
  $('recovery-text').textContent = conflict
    ? 'To keep reading new messages here, enter the recovery key for the new key. Or start fresh with a new key: messages already on this device stay readable here.'
    : 'Your messages are locked with your key. Enter the recovery key you wrote down when you set up TealTalk to read them on this device.';
  showError('');
}

function showError(text) {
  const el = $('recovery-error');
  el.textContent = text;
  el.hidden = !text;
}

async function copyKey() {
  const text = recoveryKeyText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Recovery key copied');
  } catch {
    // Select it so the person can copy it by hand.
    const range = document.createRange();
    range.selectNodeContents($('recovery-key-display'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Select the key and copy it.');
  }
}

export function initKeys({ onLogout }) {
  $('key-setup-retry').addEventListener('click', () => {
    if (state.me) loadKeys(state.me);
  });
  $('key-setup-logout').addEventListener('click', () => onLogout());
  $('recovery-logout-button').addEventListener('click', () => onLogout());

  $('recovery-copy-button').addEventListener('click', copyKey);
  $('recovery-confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const typed = $('recovery-confirm-input').value;
    if (!typed.trim()) {
      showConfirmError('Type the last 4 letters and digits of your recovery key.');
      return;
    }
    if (await confirmRecoverySaved(typed)) {
      $('recovery-confirm-input').value = '';
      showConfirmError('');
    } else {
      showConfirmError('That doesn’t match the last group of your recovery key. Check what you wrote down.');
    }
  });

  let busy = false;
  $('recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = $('recovery-input').value;
    if (!text.trim()) {
      showError('Enter your recovery key.');
      return;
    }
    busy = true;
    const button = $('recovery-submit');
    button.disabled = true;
    showError('');
    try {
      await recover(text);
      $('recovery-input').value = '';
    } catch (err) {
      if (err instanceof RecoveryKeyFormatError) {
        showError('That doesn’t look like a recovery key. It has 32 letters and digits in groups of 4.');
      } else if (err instanceof RecoveryError) {
        showError('That recovery key doesn’t match this account. Check it and try again.');
      } else {
        showError('Couldn’t reach TealTalk. Check your connection and try again.');
      }
    } finally {
      busy = false;
      button.disabled = false;
    }
  });

  $('recovery-reset-button').addEventListener('click', async () => {
    if (!window.confirm(START_FRESH_WARNING)) return;
    const button = $('recovery-reset-button');
    button.disabled = true;
    try {
      await resetKeys();
    } catch {
      showError('Couldn’t make a new key. Check your connection and try again.');
    } finally {
      button.disabled = false;
    }
  });
}
