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

  // A connection that died while iOS had the app suspended can hang forever;
  // time out so the outbox retries (the server dedups sends by clientId).
  const signal = AbortSignal.timeout(raw !== undefined ? 120000 : 20000);
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, cache: 'no-store', signal });
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
    const err = new ApiError(res.status, message);
    err.data = data; // e.g. 409 { error: "members_changed", members } for encrypted sends
    throw err;
  }
  return data;
}

const messagePath = (id, msgId) =>
  `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(msgId)}`;

export const Api = {
  register: (username, password, displayName, signupCode) => {
    const body = { username, password };
    if (displayName) body.displayName = displayName;
    if (signupCode) body.signupCode = signupCode;
    return api('/api/register', { method: 'POST', body, auth: false });
  },
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
  renameConversation: (id, title) =>
    api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } }),
  addMembers: (id, userIds) =>
    api(`/api/conversations/${encodeURIComponent(id)}/members`, { method: 'POST', body: { userIds } }),
  leaveConversation: (id) =>
    api(`/api/conversations/${encodeURIComponent(id)}/members/me`, { method: 'DELETE' }),
  messages: (id, { before, limit = 50 } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', String(before));
    return api(`/api/conversations/${encodeURIComponent(id)}/messages?${params}`);
  },
  /** An encrypted message: `e2ee` is the envelope (docs/E2EE.md). */
  sendMessage: (id, { clientId, e2ee, attachmentIds, replyToId }) => {
    const payload = { clientId, e2ee };
    if (attachmentIds && attachmentIds.length) payload.attachmentIds = attachmentIds;
    if (replyToId) payload.replyToId = replyToId;
    return api(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: payload,
    });
  },
  react: (id, msgId, { clientId, e2ee }) =>
    api(`${messagePath(id, msgId)}/reaction`, { method: 'PUT', body: { clientId, e2ee } }),
  unreact: (id, msgId) => api(`${messagePath(id, msgId)}/reaction`, { method: 'DELETE' }),
  editMessage: (id, msgId, { clientId, e2ee }) =>
    api(messagePath(id, msgId), { method: 'PATCH', body: { clientId, e2ee } }),
  unsendMessage: (id, msgId) => api(messagePath(id, msgId), { method: 'DELETE' }),
  markRead: (id, messageId) =>
    api(`/api/conversations/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      body: { messageId },
    }),
  myKeys: () => api('/api/keys/me'),
  putKeys: (bundle, backup) => api('/api/keys', { method: 'PUT', body: { bundle, backup } }),
  keysFor: (userIds) => api(`/api/keys?userIds=${userIds.map(encodeURIComponent).join(',')}`),
  userKey: (userId, keyId) =>
    api(`/api/keys/${encodeURIComponent(userId)}?keyId=${encodeURIComponent(keyId)}`),
  pushPublicKey: () => api('/api/push/public-key'),
  pushSubscribe: (subscription) =>
    api('/api/push/subscribe', { method: 'POST', body: { subscription } }),
  pushUnsubscribe: (endpoint) =>
    api('/api/push/unsubscribe', { method: 'POST', body: { endpoint } }),
};

export function attachmentUrl(attachmentId) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(getToken() || '')}`;
}
