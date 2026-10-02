// Settings: profile, notifications, install, encryption, about, logout.

import { Api } from '../api.js';
import { avatar, clear, isIOS } from '../dom.js';
import { state, on, setMe } from '../store.js';
import {
  enableNotifications,
  notificationState,
  installState,
  promptInstall,
  pushSupported,
  appFingerprint,
} from '../pwa.js';
import { resetKeys, keysReady, getKeyState } from '../e2ee.js';
import { START_FRESH_WARNING } from './keys.js';

const $ = (id) => document.getElementById(id);

function setStatus(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function renderProfile() {
  const me = state.me;
  if (!me) return;
  const holder = $('profile-avatar');
  clear(holder);
  holder.appendChild(avatar(me.id, me.displayName, 'large'));
  $('profile-name').textContent = me.displayName;
  $('profile-username').textContent = `@${me.username}`;
}

async function renderNotifications() {
  const button = $('enable-notifications-button');
  const text = $('notif-text');
  const iosNote = $('notif-ios-note');
  const st = await notificationState();
  iosNote.hidden = true;
  button.hidden = false;
  if (st === 'unsupported') {
    if (isIOS()) {
      text.textContent = 'Notifications need TealTalk on your Home Screen.';
      iosNote.hidden = false;
    } else {
      text.textContent = 'This browser does not support web notifications.';
    }
  } else if (st === 'denied') {
    text.textContent =
      'Notifications are blocked for TealTalk. Allow them in your browser or system settings, then try again.';
  } else if (st === 'enabled') {
    text.textContent = 'Notifications are on for this device.';
    button.textContent = 'Notifications enabled';
    return;
  } else {
    text.textContent = 'Get notified about new messages when TealTalk is closed.';
  }
  button.textContent = 'Enable notifications';
}

function renderInstall() {
  const st = installState();
  const button = $('install-button');
  const steps = $('install-ios-steps');
  const text = $('install-text');
  button.hidden = st !== 'prompt';
  steps.hidden = st !== 'ios';
  if (st === 'installed') text.textContent = 'TealTalk is installed on this device.';
  else if (st === 'prompt') text.textContent = 'Install TealTalk for a full-screen app with its own icon.';
  else if (st === 'ios') text.textContent = 'Add TealTalk to your Home Screen to use it like an app and get notifications:';
  else
    text.textContent =
      'To install, use your browser menu and choose "Install app" or "Add to Home screen".';
}

let fingerprintSeq = 0;

/** The app fingerprint, computed by the service worker from its cached files. */
function renderFingerprint() {
  const el = $('app-fingerprint');
  const seq = ++fingerprintSeq;
  el.textContent = 'Calculating…';
  appFingerprint().then((fp) => {
    if (seq !== fingerprintSeq) return;
    el.textContent = fp || 'Not available yet. Reopen Settings in a moment.';
  });
}

export function openSettings() {
  renderProfile();
  renderFingerprint();
  setStatus('keys-status', '');
  // A key whose recovery key was never confirmed (the app closed first): suggest a reset.
  $('recovery-unconfirmed-note').hidden = !getKeyState().recoveryUnconfirmed;
  $('displayname-input').value = state.me ? state.me.displayName : '';
  setStatus('settings-status', '');
  setStatus('notif-status', '');
  renderNotifications();
  renderInstall();
}

export function initSettings({ onLogout }) {
  $('settings-back').addEventListener('click', () => {
    location.hash = '#/';
  });

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('displayname-input').value.trim();
    if (!name) {
      setStatus('settings-status', 'Display name cannot be empty.', true);
      return;
    }
    const button = $('save-settings-button');
    button.disabled = true;
    setStatus('settings-status', 'Saving…');
    try {
      const { user } = await Api.updateMe(name);
      setMe(user);
      setStatus('settings-status', 'Saved.');
    } catch (err) {
      setStatus('settings-status', err.message || 'Could not save.', true);
    } finally {
      button.disabled = false;
    }
  });

  $('enable-notifications-button').addEventListener('click', async () => {
    if (!pushSupported()) {
      if (isIOS()) {
        $('notif-ios-note').hidden = false;
        setStatus('notif-status', 'Add TealTalk to your Home Screen first, then open it from there.', true);
      } else {
        setStatus('notif-status', 'This browser does not support web notifications.', true);
      }
      return;
    }
    setStatus('notif-status', 'Asking for permission…');
    try {
      await enableNotifications();
      setStatus('notif-status', 'Notifications enabled.');
    } catch (err) {
      if (err.message === 'denied') {
        setStatus('notif-status', 'Permission was not granted.', true);
      } else {
        setStatus('notif-status', err.message && err.message !== 'unsupported' ? `Could not enable notifications: ${err.message}` : 'Could not enable notifications.', true);
      }
    }
    renderNotifications();
  });

  $('install-button').addEventListener('click', async () => {
    await promptInstall();
    renderInstall();
  });

  $('logout-button').addEventListener('click', () => onLogout());

  $('reset-keys-button').addEventListener('click', async () => {
    if (!keysReady()) return;
    if (!window.confirm(START_FRESH_WARNING.replace('Start fresh with a new key?', 'Reset your key?'))) return;
    const button = $('reset-keys-button');
    button.disabled = true;
    setStatus('keys-status', 'Making a new key…');
    try {
      await resetKeys(); // then the new recovery key is shown
      setStatus('keys-status', '');
    } catch {
      setStatus('keys-status', 'Couldn’t reset your key. Check your connection and try again.', true);
    } finally {
      button.disabled = false;
    }
  });

  on('me', () => {
    if (!$('settings-screen').hidden) renderProfile();
  });
  on('install', () => {
    if (!$('settings-screen').hidden) renderInstall();
  });
}
