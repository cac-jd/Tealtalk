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
  setTyping,
  clearTyping,
  setPresence,
  setConnection,
  memberById,
  conversationTitle,
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
import { announce } from './js/ui/common.js';

const $ = (id) => document.getElementById(id);

const SCREENS = {
  auth: 'auth-screen',
  chats: 'chats-screen',
  new: 'new-chat-screen',
  chat: 'chat-screen',
  settings: 'settings-screen',
};

let current = null;
let sessionStarted = false;

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
  const added = addMessages(convId, [message]);
  const mine = state.me && message.senderId === state.me.id;
  if (mine || !added.length) return;

  clearTyping(convId, message.senderId);
  const conv = getConversation(convId);
  const sender = memberById(conv, message.senderId);
  const who = sender ? sender.displayName : 'Someone';
  const text = message.body || (message.attachment ? 'Photo' : '');

  if (isChatVisible(convId)) {
    maybeMarkRead();
    announce(`${who}: ${text}`);
  } else {
    if (!fetched) incrementUnread(convId);
    const where = conv && conv.isGroup ? ` in ${conversationTitle(conv)}` : '';
    announce(`New message from ${who}${where}`);
  }
}

async function refreshConversations() {
  try {
    const { conversations } = await Api.conversations();
    setConversations(conversations);
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
  const chatMatch = hash.match(/^#\/c\/([^/?#]+)/);

  if (!chatMatch) closeChat();
  if (hash !== '#/new') closeNewChat();

  if (chatMatch) {
    showScreen('chat');
    openChat(decodeURIComponent(chatMatch[1]));
  } else if (hash === '#/new') {
    if (current !== 'new') openNewChat();
    showScreen('new');
    if (!matchMedia('(pointer: coarse)').matches) $('user-search-input').focus();
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
