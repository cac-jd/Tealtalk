// Service worker registration, web push subscription and install prompts.

import { Api } from './api.js';
import { isIOS, isStandalone } from './dom.js';
import { emit } from './store.js';

let installPrompt = null;

export function registerServiceWorker(onOpenConversation) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
    /* offline launch just won't work; the app still does */
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'open-conversation' && data.conversationId) {
      onOpenConversation(data.conversationId);
    }
  });
}

// Android / desktop Chrome: capture the install prompt so Settings can offer a button.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  emit('install');
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  emit('install');
});

/** 'installed' | 'prompt' | 'ios' | 'unavailable' */
export function installState() {
  if (isStandalone()) return 'installed';
  if (installPrompt) return 'prompt';
  if (isIOS()) return 'ios';
  return 'unavailable';
}

export async function promptInstall() {
  if (!installPrompt) return false;
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice.catch(() => null);
  emit('install');
  return !!choice && choice.outcome === 'accepted';
}

// ---- notifications ----

export function pushSupported() {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  );
}

/** 'unsupported' | 'denied' | 'enabled' | 'available' */
export async function notificationState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub && Notification.permission === 'granted') return 'enabled';
  } catch {
    /* ignore */
  }
  return 'available';
}

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enableNotifications() {
  if (!pushSupported()) throw new Error('unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('denied');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await Api.pushPublicKey();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    });
  }
  await Api.pushSubscribe(sub.toJSON());
}

/** Best effort: drop this device's push subscription (on logout). */
export async function disableNotifications() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    await Api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  } catch {
    /* ignore */
  }
}
