// HTTP API client. The session token lives in localStorage.

const TOKEN_KEY = 'tt.token';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status; // 0 = network failure
  }
  get isNetwork() {
    return this.status === 0;
  }
  /** Worth retrying later (offline, server hiccup, rate limit). */
  get isTransient() {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

let unauthorizedHandler = () => {};

export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Call the API. Returns parsed JSON (or null for 204).
 * `auth: false` requests (login/register) never trigger the global 401 handler,
 * because there a 401 simply means "wrong password".
 */
export async function api(path, { method = 'GET', body, raw, contentType, auth = true } = {}) {
  const headers = {};
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = contentType || raw.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
  } catch {
    throw new ApiError(0, navigator.onLine ? 'Could not reach TealTalk.' : 'You are offline.');
  }

  let data = null;
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
  }

  if (!res.ok) {
    if (res.status === 401 && auth) unauthorizedHandler();
    const message =
      (data && typeof data.error === 'string' && data.error) ||
      (res.status === 413 ? 'That file is too large.' : `Request failed (${res.status}).`);
    throw new ApiError(res.status, message);
  }
  return data;
}

export const Api = {
  register: (username, password, displayName) =>
    api('/api/register', {
      method: 'POST',
      body: displayName ? { username, password, displayName } : { username, password },
      auth: false,
    }),
  login: (username, password) =>
    api('/api/login', { method: 'POST', body: { username, password }, auth: false }),
  logout: () => api('/api/logout', { method: 'POST' }),
  me: () => api('/api/me'),
  updateMe: (displayName) => api('/api/me', { method: 'PATCH', body: { displayName } }),
  searchUsers: (q) => api(`/api/users/search?q=${encodeURIComponent(q)}`),
  conversations: () => api('/api/conversations'),
  conversation: (id) => api(`/api/conversations/${encodeURIComponent(id)}`),
  createConversation: (memberIds, title) =>
    api('/api/conversations', {
      method: 'POST',
      body: title ? { memberIds, title } : { memberIds },
    }),
  messages: (id, { before, limit = 50 } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', String(before));
    return api(`/api/conversations/${encodeURIComponent(id)}/messages?${params}`);
  },
  sendMessage: (id, { clientId, body, attachmentId }) => {
    const payload = { clientId };
    if (body) payload.body = body;
    if (attachmentId) payload.attachmentId = attachmentId;
    return api(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: payload,
    });
  },
  markRead: (id, messageId) =>
    api(`/api/conversations/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      body: { messageId },
    }),
  uploadAttachment: (blob) => api('/api/attachments', { method: 'POST', raw: blob }),
  pushPublicKey: () => api('/api/push/public-key'),
  pushSubscribe: (subscription) =>
    api('/api/push/subscribe', { method: 'POST', body: { subscription } }),
  pushUnsubscribe: (endpoint) =>
    api('/api/push/unsubscribe', { method: 'POST', body: { endpoint } }),
};

export function attachmentUrl(attachmentId) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(getToken() || '')}`;
}
