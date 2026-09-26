'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const webpush = require('web-push');

const MAX_SUBSCRIPTIONS_PER_USER = 20;

/** Loads VAPID keys from DATA_DIR, generating and saving them on first start. */
function loadVapidKeys(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.publicKey === 'string' && typeof saved.privateKey === 'string') return saved;
  } catch {
    /* generate below */
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }, null, 2), {
    mode: 0o600,
  });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

const B64URL = /^[A-Za-z0-9_\-=+/]+$/;

/**
 * Validates PushSubscription JSON. Returns a normalized subscription or null.
 * Endpoints must be https on a public hostname: the server should only ever talk to
 * the push service the browser picked, never to local/internal addresses.
 */
function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null;
  if (!keys || typeof keys !== 'object') return null;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || p256dh.length < 16 || p256dh.length > 256 || !B64URL.test(p256dh)) return null;
  if (typeof auth !== 'string' || auth.length < 8 || auth.length > 128 || !B64URL.test(auth)) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || net.isIP(host) || host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) return null;
  return { endpoint, keys: { p256dh, auth } };
}

const KIND_PREVIEW = { image: 'Photo', video: 'Video', audio: 'Voice message' };

/** Notification text: the message, else what was attached (`attachment` is an Attachment or `true` for a photo). */
function preview(body, attachment) {
  const text = (body || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (!attachment) return '';
    return KIND_PREVIEW[attachment.kind] || 'Photo';
  }
  const chars = Array.from(text);
  if (chars.length <= 100) return text;
  return chars.slice(0, 99).join('') + '…';
}

class PushService {
  constructor({ store, hub, vapid, subject, sendPush, log = console }) {
    this.store = store;
    this.hub = hub;
    this.vapid = vapid;
    this.subject = subject || 'mailto:admin@localhost';
    this.log = log;
    this.closed = false;
    this.pending = new Set();
    this.send =
      sendPush ||
      ((subscription, payload) =>
        webpush.sendNotification(subscription, payload, {
          TTL: 24 * 60 * 60,
          urgency: 'high',
          vapidDetails: { subject: this.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        }));
  }

  get publicKey() {
    return this.vapid.publicKey;
  }

  subscribe(userId, subscription) {
    this.store.upsertPushSubscription(
      { endpoint: subscription.endpoint, userId, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      MAX_SUBSCRIPTIONS_PER_USER
    );
  }

  unsubscribe(userId, endpoint) {
    this.store.deletePushSubscription(endpoint, userId);
  }

  /**
   * Fire-and-forget: pushes a brand-new message to every other member without an open socket.
   * Never throws and never delays the caller.
   */
  notifyMessage(message, conversationRow, sender, memberIds) {
    if (this.closed) return;
    setImmediate(() => {
      if (this.closed) return;
      try {
        const recipients = memberIds.filter((id) => id !== sender.id && !this.hub.isOnline(id));
        if (!recipients.length) return;
        const title = conversationRow.is_group && conversationRow.title ? conversationRow.title : sender.displayName;
        const payload = JSON.stringify({
          title,
          body: preview(message.body, message.attachment),
          conversationId: message.conversationId,
        });
        for (const userId of recipients) {
          for (const sub of this.store.pushSubscriptionsFor(userId)) this.deliver(sub, payload);
        }
      } catch (err) {
        if (!this.closed) this.log.error('push fan-out failed:', err && err.message);
      }
    });
  }

  deliver(subscription, payload) {
    let p;
    try {
      p = Promise.resolve(this.send(subscription, payload));
    } catch (err) {
      p = Promise.reject(err);
    }
    const tracked = p
      .catch((err) => {
        const status = err && err.statusCode;
        if (status === 404 || status === 410) {
          if (!this.closed) this.store.deletePushSubscriptionByEndpoint(subscription.endpoint);
        } else if (!this.closed) {
          this.log.warn('web push failed:', status || (err && err.message));
        }
      })
      .catch(() => {})
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Resolves when all in-flight pushes have settled (used by tests and close()). */
  async idle() {
    await new Promise((r) => setImmediate(r));
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  close() {
    this.closed = true;
  }
}

module.exports = { PushService, loadVapidKeys, validateSubscription, preview };
