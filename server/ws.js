'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { hashToken } = require('./auth');
const { parseTarget } = require('./util');

const TYPING_MIN_INTERVAL_MS = 1000; // clients throttle to 2 s; this just stops floods
const MAX_FRAMES_PER_10S = 100;

/**
 * Tracks every open socket per user. Used for fan-out, presence and to decide
 * whether a user should get a web push instead (no open socket).
 */
class Hub {
  constructor({ store, heartbeatMs = 30000, log = console }) {
    this.store = store;
    this.log = log;
    this.byUser = new Map(); // userId -> Set<WebSocket>
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws, req, session) => this.onConnection(ws, session));
    this.heartbeat = setInterval(() => this.beat(), heartbeatMs);
    this.heartbeat.unref();
    this.closed = false;
  }

  handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const { pathname, query } = parseTarget(req.url);
    if (this.closed || pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = query.get('token');
    let session = null;
    if (token && token.length <= 512) {
      const tokenHash = hashToken(token);
      const user = this.store.getSessionUser(tokenHash);
      if (user) session = { user, tokenHash };
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!session) {
        ws.close(4401, 'Unauthorized');
        return;
      }
      this.wss.emit('connection', ws, req, session);
    });
  }

  isOnline(userId) {
    const set = this.byUser.get(userId);
    return !!set && set.size > 0;
  }

  sendRaw(ws, text) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }

  sendToUser(userId, event) {
    const set = this.byUser.get(userId);
    if (!set || !set.size) return;
    const text = JSON.stringify(event);
    for (const ws of set) this.sendRaw(ws, text);
  }

  sendToUsers(userIds, event) {
    const text = JSON.stringify(event);
    for (const userId of userIds) {
      const set = this.byUser.get(userId);
      if (!set) continue;
      for (const ws of set) this.sendRaw(ws, text);
    }
  }

  onConnection(ws, { user, tokenHash }) {
    ws.userId = user.id;
    ws.tokenHash = tokenHash;
    ws.isAlive = true;
    ws.typingAt = new Map();
    ws.frameWindowStart = Date.now();
    ws.frameCount = 0;

    let set = this.byUser.get(user.id);
    if (!set) {
      set = new Set();
      this.byUser.set(user.id, set);
    }
    const cameOnline = set.size === 0;
    set.add(ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => this.onFrame(ws, data, isBinary));
    ws.on('close', () => this.onClose(ws));

    this.sendRaw(ws, JSON.stringify({ type: 'hello', user }));

    let contacts = [];
    try {
      contacts = this.store.contactIds(user.id);
    } catch (err) {
      this.log.error('ws contacts lookup failed', err && err.message);
    }
    // Tell the new socket who is already online, then tell contacts about us.
    for (const contactId of contacts) {
      if (this.isOnline(contactId)) this.sendRaw(ws, JSON.stringify({ type: 'presence', userId: contactId, online: true }));
    }
    if (cameOnline) this.sendToUsers(contacts, { type: 'presence', userId: user.id, online: true });
  }

  onClose(ws) {
    const set = this.byUser.get(ws.userId);
    if (!set || !set.delete(ws)) return;
    if (set.size > 0) return;
    this.byUser.delete(ws.userId);
    if (this.closed) return;
    try {
      this.sendToUsers(this.store.contactIds(ws.userId), { type: 'presence', userId: ws.userId, online: false });
    } catch {
      /* store may be closing */
    }
  }

  onFrame(ws, data, isBinary) {
    const now = Date.now();
    if (now - ws.frameWindowStart > 10000) {
      ws.frameWindowStart = now;
      ws.frameCount = 0;
    }
    if (++ws.frameCount > MAX_FRAMES_PER_10S) {
      ws.close(1008, 'Too many messages');
      return;
    }
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      this.sendRaw(ws, JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type === 'typing') {
      const conversationId = msg.conversationId;
      if (typeof conversationId !== 'string' || conversationId.length > 64) return;
      const last = ws.typingAt.get(conversationId) || 0;
      if (now - last < TYPING_MIN_INTERVAL_MS) return;
      let members;
      try {
        if (!this.store.isMember(conversationId, ws.userId)) return;
        members = this.store.memberIds(conversationId);
      } catch {
        return;
      }
      ws.typingAt.set(conversationId, now);
      if (ws.typingAt.size > 200) ws.typingAt.clear();
      this.sendToUsers(
        members.filter((id) => id !== ws.userId),
        { type: 'typing', conversationId, userId: ws.userId }
      );
    }
  }

  beat() {
    for (const ws of this.wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  /** Close every socket that authenticated with this (now revoked) session. */
  closeSession(tokenHash) {
    for (const ws of this.wss.clients) {
      if (ws.tokenHash === tokenHash) ws.close(4401, 'Logged out');
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    this.byUser.clear();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

module.exports = { Hub };
