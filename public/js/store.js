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
  /** userId -> User: everyone seen in any conversation (names for people who left a group) */
  users: new Map(),
  /** userIds known to be online */
  online: new Set(),
  connection: 'offline',
};

// Restore the cached chat list so the app can launch offline.
for (const conv of storage.get(CONV_CACHE_KEY, [])) {
  state.conversations.set(conv.id, conv);
  rememberUsers(conv);
}

function rememberUsers(conv) {
  for (const m of (conv && conv.members) || []) state.users.set(m.id, m);
}

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
  state.users.clear();
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
  for (const conv of list) {
    rememberUsers(conv);
    state.conversations.set(conv.id, mergeConversation(previous.get(conv.id), conv));
  }
  persistConversations();
  emit('conversations');
}

export function upsertConversation(conv) {
  rememberUsers(conv);
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
  let unreadCount = fresh.unreadCount;
  if (old.lastMessage && (!lastMessage || old.lastMessage.id > lastMessage.id)) {
    // The snapshot predates messages we already got live, so its unread count is too low.
    // Don't let it hide them; refreshConversations() fetches again to get the exact count.
    lastMessage = old.lastMessage;
    unreadCount = Math.max(fresh.unreadCount || 0, old.unreadCount || 0);
  }
  return {
    ...fresh,
    readUpTo,
    lastMessage,
    unreadCount,
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

/** I left the group (or was removed): forget it and anything unsent in it. */
export function removeConversation(convId) {
  if (!state.conversations.has(convId) && !state.chats.has(convId)) return;
  state.conversations.delete(convId);
  state.chats.delete(convId);
  for (const [clientId, p] of state.pending) if (p.conversationId === convId) state.pending.delete(clientId);
  persistConversations();
  emit('conversations');
  emit('conversation-removed', convId);
}

/** A user's display name, also for people who have since left the conversation. */
export function userName(conv, userId) {
  if (state.me && userId === state.me.id) return state.me.displayName;
  const m = memberById(conv, userId) || state.users.get(userId);
  return m ? m.displayName : 'Someone';
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
  let newest = null;
  for (const incoming of messages) {
    const old = chat.messages.get(incoming.id);
    // Same id again (a reaction, edit or unsend): replace it in place, never duplicate.
    const msg = old ? mergeMessage(old, incoming) : incoming;
    if (!old) added.push(msg);
    chat.messages.set(msg.id, msg);
    if (!newest || msg.id > newest.id) newest = msg;
    if (msg.clientId && state.me && msg.senderId === state.me.id) {
      const pending = state.pending.get(msg.clientId);
      if (pending) {
        state.pending.delete(msg.clientId);
        emit('pending-resolved', { pending, message: msg });
      }
    }
  }
  const conv = state.conversations.get(convId);
  if (conv && newest && (!conv.lastMessage || newest.id >= conv.lastMessage.id)) {
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

/**
 * A message we already have arrived again (a live update over WebSocket, or a
 * page fetched while one was in flight). Take the newer copy, but never let a
 * stale snapshot undo an unsend or an edit.
 */
function mergeMessage(old, fresh) {
  if (old.deletedAt && !fresh.deletedAt) return old;
  if ((old.editedAt || 0) > (fresh.editedAt || 0)) return { ...fresh, body: old.body, editedAt: old.editedAt };
  return fresh;
}

/** Replace one message locally (optimistic reactions); the server's copy follows. */
export function replaceMessage(convId, msg) {
  const chat = state.chats.get(convId);
  if (!chat || !chat.messages.has(msg.id)) return;
  chat.messages.set(msg.id, msg);
  emit('messages', convId);
}

export function findMessage(convId, id) {
  const chat = state.chats.get(convId);
  return (chat && chat.messages.get(id)) || null;
}

// ---- message descriptions ----

const KIND_LABEL = { image: 'Photo', video: 'Video', audio: 'Voice message' };

/** image | video | audio (older attachments have no `kind`: go by the type). */
export function attachmentKind(att) {
  if (!att) return null;
  if (att.kind) return att.kind;
  const mime = att.mime || '';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'image';
}

export function kindLabel(kind) {
  return KIND_LABEL[kind] || 'Attachment';
}

/** "Maya added Sam and Jordan" etc. */
export function systemText(conv, msg) {
  const sys = msg.system || {};
  const meId = state.me && state.me.id;
  const actor = msg.senderId === meId ? 'You' : userName(conv, msg.senderId);
  const names = (sys.userIds || []).map((id) => (id === meId ? 'you' : userName(conv, id)));
  const list =
    names.length <= 1
      ? names.join('')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  switch (sys.type) {
    case 'member_added':
      return `${actor} added ${list || 'someone'}`;
    case 'member_left':
      return `${actor} left the group`;
    case 'renamed':
      return sys.title ? `${actor} named the group “${sys.title}”` : `${actor} renamed the group`;
    default:
      return `${actor} changed the group`;
  }
}

/** One-line description of a message for previews, quotes and announcements. */
export function messageSummary(conv, msg) {
  if (!msg) return '';
  if (msg.system) return systemText(conv, msg);
  if (msg.deletedAt) return 'This message was unsent';
  const body = (msg.body || '').replace(/\s+/g, ' ').trim();
  if (body) return body;
  if (msg.attachment) return kindLabel(attachmentKind(msg.attachment));
  if (msg.attachmentKind) return kindLabel(msg.attachmentKind);
  return '';
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
