// TealTalk client entry point: routing, session lifecycle and realtime events.

import { Api, getToken, setToken, onUnauthorized } from './js/api.js';
import { Socket } from './js/socket.js';
import {
  state,
  on,
  setMe,
  resetState,
  setConversations,
  upsertConversation,
  getConversation,
  addMessages,
  applyRead,
  incrementUnread,
  uncountUnread,
  findMessage,
  setTyping,
  clearTyping,
  setPresence,
  setConnection,
  userName,
  conversationTitle,
  messageSummary,
  removeConversation,
} from './js/store.js';
import { loadOutbox, clearOutbox, flush } from './js/outbox.js';
import { registerServiceWorker, disableNotifications } from './js/pwa.js';
import { initAuth, showAuth } from './js/ui/auth.js';
import { initChats, renderChats } from './js/ui/chats.js';
import { initNewChat, openNewChat, closeNewChat } from './js/ui/newchat.js';
import {
  initChat,
  openChat,
  closeChat,
  catchUp,
  isChatVisible,
  maybeMarkRead,
} from './js/ui/chat.js';
import { initSettings, openSettings } from './js/ui/settings.js';
import { initGroupInfo, openGroupInfo, closeGroupInfo } from './js/ui/groupinfo.js';
import { announce, toast } from './js/ui/common.js';

const $ = (id) => document.getElementById(id);

const SCREENS = {
  auth: 'auth-screen',
  chats: 'chats-screen',
  new: 'new-chat-screen',
  chat: 'chat-screen',
  info: 'group-info-screen',
  settings: 'settings-screen',
};

let current = null;
let sessionStarted = false;
/** Which group the new-chat screen is adding people to (null: a new chat). */
let newChatFor = null;

// ---------- realtime ----------

const socket = new Socket({
  getToken,
  onState: (s) => setConnection(s),
  onOpen: () => {
    refreshConversations();
    catchUp();
    flush();
  },
  onAuthFail: () => endSession(),
  onMessage: handleEvent,
});

function handleEvent(evt) {
  switch (evt.type) {
    case 'hello':
      if (evt.user) setMe(evt.user);
      break;
    case 'message':
      if (evt.message) handleIncoming(evt.message);
      break;
    case 'conversation':
      if (evt.conversation) upsertConversation(evt.conversation);
      break;
    case 'conversation_removed':
      if (evt.conversationId) handleRemoved(evt.conversationId);
      break;
    case 'read':
      applyRead(evt.conversationId, evt.userId, evt.messageId);
      break;
    case 'typing':
      if (!state.me || evt.userId !== state.me.id) setTyping(evt.conversationId, evt.userId);
      break;
    case 'presence':
      setPresence(evt.userId, !!evt.online);
      break;
    default:
      break;
  }
}

async function handleIncoming(message) {
  const convId = message.conversationId;
  // Ids only grow, so a message at or below the newest one we know of is a change to an
  // existing message (reaction, edit, unsend), even when this chat's history isn't loaded.
  const knownConv = getConversation(convId);
  const known = knownConv && knownConv.lastMessage ? knownConv.lastMessage.id : 0;
  // A conversation we haven't seen yet arrives with a server-computed unreadCount.
  let fetched = false;
  if (!getConversation(convId)) {
    try {
      const { conversation } = await Api.conversation(convId);
      upsertConversation(conversation);
      fetched = true;
    } catch {
      /* will show up on the next refresh */
    }
  }
  const before = findMessage(convId, message.id);
  const added = addMessages(convId, [message], { live: true });
  const mine = state.me && message.senderId === state.me.id;
  const isNew = added.length > 0 && message.id > known;
  // Unsent before I read it: like the server, stop counting it.
  if (!mine && !isNew && message.deletedAt && !(before && before.deletedAt)) uncountUnread(convId, message.id);
  if (mine || !isNew) return;

  clearTyping(convId, message.senderId);
  const conv = getConversation(convId);
  const who = userName(conv, message.senderId);
  const text = messageSummary(conv, message);

  if (isChatVisible(convId)) {
    maybeMarkRead();
    announce(message.system ? text : `${who}: ${text}`);
  } else {
    // System lines ("Jordan added Sam") aren't unread messages, on the server either.
    if (!fetched && !message.system) incrementUnread(convId);
    const where = conv && conv.isGroup ? ` in ${conversationTitle(conv)}` : '';
    announce(`New message from ${who}${where}`);
  }
}

/** I left a group (maybe on another device): drop it and get out of its screens. */
function handleRemoved(convId) {
  const conv = getConversation(convId);
  const open = (location.hash || '').startsWith(`#/c/${encodeURIComponent(convId)}`);
  removeConversation(convId);
  if (open) {
    location.replace('#/');
    toast(conv && conv.isGroup ? `You're no longer in “${conversationTitle(conv)}”.` : 'That chat was removed.');
  }
}

async function refreshConversations(again = true) {
  try {
    const { conversations } = await Api.conversations();
    // Messages that arrived live while this was in flight make the snapshot stale: fetch once more.
    const stale = conversations.some((c) => {
      const known = getConversation(c.id);
      return known && known.lastMessage && (!c.lastMessage || known.lastMessage.id > c.lastMessage.id);
    });
    setConversations(conversations);
    if (stale && again) refreshConversations(false);
  } catch {
    /* offline: keep the cached list */
  }
}

function renderConnection() {
  const el = $('connection-status');
  const conn = state.connection;
  const visible = sessionStarted && conn !== 'open';
  el.hidden = !visible;
  el.classList.toggle('offline', conn === 'offline');
  el.textContent = visible ? (conn === 'offline' ? 'Offline' : 'Connecting...') : '';
}

// ---------- session ----------

function startSession() {
  if (sessionStarted) return;
  sessionStarted = true;
  loadOutbox();
  renderChats();
  renderConnection();
  socket.start();
  refreshConversations();
  Api.me()
    .then(({ user }) => setMe(user))
    .catch(() => {});
}

/** Forget everything local and go back to the login screen. */
function endSession() {
  sessionStarted = false;
  socket.stop();
  setToken(null);
  clearOutbox();
  closeChat();
  closeNewChat();
  resetState();
  renderChats();
  renderConnection();
  if (location.hash && location.hash !== '#/') history.replaceState(null, '', '#/');
  route();
}

async function logout() {
  const button = $('logout-button');
  button.disabled = true;
  await disableNotifications();
  try {
    await Api.logout();
  } catch {
    /* token is dropped locally either way */
  }
  button.disabled = false;
  endSession();
}

onUnauthorized(() => {
  if (sessionStarted || getToken()) endSession();
});

// ---------- routing ----------

function showScreen(name) {
  if (current === name) return;
  current = name;
  for (const [key, id] of Object.entries(SCREENS)) $(id).hidden = key !== name;
}

function route() {
  if (!getToken()) {
    closeChat();
    showScreen('auth');
    showAuth();
    return;
  }
  // A token can appear without a reload (e.g. set by another tab).
  if (!sessionStarted) startSession();
  const hash = location.hash || '#/';
  const chatMatch = hash.match(/^#\/c\/([^/?#]+)(?:\/(info|add))?$/);
  const sub = chatMatch ? chatMatch[2] || null : null;
  const isNew = hash === '#/new' || sub === 'add';

  if (!chatMatch || sub) closeChat();
  if (!chatMatch || sub !== 'info') closeGroupInfo();
  if (!isNew) closeNewChat();

  if (chatMatch && sub === 'info') {
    showScreen('info');
    openGroupInfo(decodeURIComponent(chatMatch[1]));
  } else if (isNew) {
    const addTo = sub === 'add' ? decodeURIComponent(chatMatch[1]) : null;
    if (current !== 'new' || addTo !== newChatFor) openNewChat(addTo);
    newChatFor = addTo;
    showScreen('new');
    if (!matchMedia('(pointer: coarse)').matches) $('user-search-input').focus();
  } else if (chatMatch) {
    showScreen('chat');
    openChat(decodeURIComponent(chatMatch[1]));
  } else if (hash === '#/settings') {
    showScreen('settings');
    openSettings();
  } else {
    showScreen('chats');
    renderChats();
  }
}

// ---------- viewport (iOS keyboard) ----------

function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    // vv.height shrinks when the on-screen keyboard opens (and when pinch-zoomed,
    // which multiplying by scale cancels out).
    const height = vv.height * vv.scale;
    root.style.setProperty('--app-height', `${Math.round(height)}px`);
    // A keyboard is up if the visual viewport is much shorter than the layout viewport.
    document.body.classList.toggle('keyboard-open', window.innerHeight - height > 120);
    // iOS scrolls the layout viewport when focusing an input; undo it so the
    // header stays put and the composer sits right above the keyboard.
    if (vv.scale === 1 && window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// ---------- boot ----------

function boot() {
  trackViewport();
  initAuth({
    onAuthed: () => {
      startSession();
      if (location.hash !== '#/') history.replaceState(null, '', '#/');
      current = null;
      route();
    },
  });
  initChats();
  initNewChat();
  initChat({ socket });
  initGroupInfo();
  initSettings({ onLogout: logout });

  on('connection', renderConnection);
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => flush());

  registerServiceWorker((conversationId) => {
    location.hash = `#/c/${encodeURIComponent(conversationId)}`;
  });

  if (getToken()) startSession();
  route();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
