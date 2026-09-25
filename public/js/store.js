// In-memory app state plus a tiny event emitter. UI modules subscribe to
// change events and re-render the parts they own.

import { storage } from './dom.js';

const CONV_CACHE_KEY = 'tt.conversations';
const ME_KEY = 'tt.me';

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, detail) {
  const set = listeners.get(event);
  if (set) for (const fn of set) fn(detail);
}

export const state = {
  me: storage.get(ME_KEY),
  /** @type {Map<string, object>} */
  conversations: new Map(),
  /** convId -> { messages: Map<id, Message>, hasMore, loadingOlder, loaded } */
  chats: new Map(),
  /** clientId -> pending message (see outbox.js) */
  pending: new Map(),
  /** convId -> Map<userId, timeoutHandle> */
  typing: new Map(),
  /** userIds known to be online */
  online: new Set(),
  connection: 'offline',
};

// Restore the cached chat list so the app can launch offline.
for (const conv of storage.get(CONV_CACHE_KEY, [])) state.conversations.set(conv.id, conv);

let persistTimer = null;
function persistConversations() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    storage.set(CONV_CACHE_KEY, sortedConversations().slice(0, 100));
  }, 300);
}

export function resetState() {
  state.me = null;
  state.conversations.clear();
  state.chats.clear();
  state.pending.clear();
  for (const users of state.typing.values()) for (const t of users.values()) clearTimeout(t);
  state.typing.clear();
  state.online.clear();
  storage.remove(CONV_CACHE_KEY);
  storage.remove(ME_KEY);
}

export function setMe(user) {
  state.me = user;
  storage.set(ME_KEY, user);
  emit('me', user);
}

// ---- conversations ----

export function sortedConversations() {
  return [...state.conversations.values()].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (a.id < b.id ? -1 : 1),
  );
}

export function setConversations(list) {
  const previous = state.conversations;
  state.conversations = new Map();
  for (const conv of list) state.conversations.set(conv.id, mergeConversation(previous.get(conv.id), conv));
  persistConversations();
  emit('conversations');
}

export function upsertConversation(conv) {
  state.conversations.set(conv.id, mergeConversation(state.conversations.get(conv.id), conv));
  persistConversations();
  emit('conversations');
  emit('conversation', conv.id);
}

/** Keep read positions monotonic when a fresher snapshot races an older one. */
function mergeConversation(old, fresh) {
  if (!old) return { ...fresh, readUpTo: { ...(fresh.readUpTo || {}) } };
  const readUpTo = { ...(old.readUpTo || {}) };
  for (const [uid, id] of Object.entries(fresh.readUpTo || {})) {
    readUpTo[uid] = Math.max(readUpTo[uid] || 0, id || 0);
  }
  let lastMessage = fresh.lastMessage;
  if (old.lastMessage && (!lastMessage || old.lastMessage.id > lastMessage.id)) {
    lastMessage = old.lastMessage;
  }
  return {
    ...fresh,
    readUpTo,
    lastMessage,
    updatedAt: Math.max(fresh.updatedAt || 0, lastMessage ? lastMessage.createdAt : 0),
  };
}

export function getConversation(id) {
  return state.conversations.get(id) || null;
}

export function otherMembers(conv) {
  const meId = state.me && state.me.id;
  return (conv.members || []).filter((m) => m.id !== meId);
}

export function memberById(conv, userId) {
  return (conv && (conv.members || []).find((m) => m.id === userId)) || null;
}

export function conversationTitle(conv) {
  if (!conv) return '';
  if (conv.title) return conv.title;
  const others = otherMembers(conv);
  if (!others.length) return state.me ? `${state.me.displayName} (you)` : 'Just you';
  if (!conv.isGroup) return others[0].displayName;
  const names = others.map((m) => m.displayName);
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

/** Record that userId has read up to messageId in convId. */
export function applyRead(convId, userId, messageId) {
  const conv = state.conversations.get(convId);
  if (!conv) return;
  const readUpTo = { ...(conv.readUpTo || {}) };
  if ((readUpTo[userId] || 0) >= messageId) return;
  readUpTo[userId] = messageId;
  const next = { ...conv, readUpTo };
  if (state.me && userId === state.me.id) {
    // Recount my unread messages from what we have loaded; if the read point
    // covers the last message, nothing is unread.
    if (!conv.lastMessage || messageId >= conv.lastMessage.id) next.unreadCount = 0;
    else {
      const chat = state.chats.get(convId);
      if (chat && chat.loaded) {
        let n = 0;
        for (const m of chat.messages.values()) if (m.senderId !== userId && m.id > messageId) n++;
        next.unreadCount = n;
      }
    }
  }
  state.conversations.set(convId, next);
  persistConversations();
  emit('conversations');
  emit('read', convId);
}

// ---- messages ----

export function getChat(convId) {
  let chat = state.chats.get(convId);
  if (!chat) {
    chat = { messages: new Map(), hasMore: true, loadingOlder: false, loaded: false };
    state.chats.set(convId, chat);
  }
  return chat;
}

/**
 * Merge server messages into a conversation. Returns the messages that were new.
 * Also resolves pending (optimistic) messages that share a clientId.
 */
export function addMessages(convId, messages, { silent = false } = {}) {
  const chat = getChat(convId);
  const added = [];
  for (const msg of messages) {
    if (!chat.messages.has(msg.id)) added.push(msg);
    chat.messages.set(msg.id, msg);
    if (msg.clientId && state.me && msg.senderId === state.me.id) {
      const pending = state.pending.get(msg.clientId);
      if (pending) {
        state.pending.delete(msg.clientId);
        emit('pending-resolved', { pending, message: msg });
      }
    }
  }
  const newest = messages.reduce((a, m) => (!a || m.id > a.id ? m : a), null);
  const conv = state.conversations.get(convId);
  if (conv && newest && (!conv.lastMessage || newest.id > conv.lastMessage.id)) {
    state.conversations.set(convId, {
      ...conv,
      lastMessage: newest,
      updatedAt: Math.max(conv.updatedAt || 0, newest.createdAt),
    });
    persistConversations();
    emit('conversations');
  }
  if (!silent) emit('messages', convId);
  return added;
}

export function sortedMessages(convId) {
  const chat = state.chats.get(convId);
  if (!chat) return [];
  return [...chat.messages.values()].sort((a, b) => a.id - b.id);
}

export function pendingFor(convId) {
  return [...state.pending.values()]
    .filter((p) => p.conversationId === convId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 'read' once every other member has read it, otherwise 'sent'. */
export function messageStatus(conv, msg) {
  const others = otherMembers(conv);
  if (!others.length) return 'sent';
  const readUpTo = conv.readUpTo || {};
  return others.every((m) => (readUpTo[m.id] || 0) >= msg.id) ? 'read' : 'sent';
}

export function incrementUnread(convId) {
  const conv = state.conversations.get(convId);
  if (!conv) return;
  state.conversations.set(convId, { ...conv, unreadCount: (conv.unreadCount || 0) + 1 });
  persistConversations();
  emit('conversations');
}

// ---- typing & presence ----

const TYPING_SHOW_MS = 4000;

export function setTyping(convId, userId) {
  if (!state.typing.has(convId)) state.typing.set(convId, new Map());
  const users = state.typing.get(convId);
  clearTimeout(users.get(userId));
  users.set(
    userId,
    setTimeout(() => clearTyping(convId, userId), TYPING_SHOW_MS),
  );
  emit('typing', convId);
}

export function clearTyping(convId, userId) {
  const users = state.typing.get(convId);
  if (!users || !users.has(userId)) return;
  clearTimeout(users.get(userId));
  users.delete(userId);
  emit('typing', convId);
}

export function typingUsers(convId) {
  const users = state.typing.get(convId);
  return users ? [...users.keys()] : [];
}

export function setPresence(userId, online) {
  if (online) state.online.add(userId);
  else state.online.delete(userId);
  emit('presence', userId);
}

export function setConnection(conn) {
  state.connection = conn;
  emit('connection', conn);
}
