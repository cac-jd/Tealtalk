// An open conversation: message list, typing indicator, composer.

import { Api, attachmentUrl, getToken } from '../api.js';
import { h, clear, dayKey, formatDay, formatTime, isTouchDevice } from '../dom.js';
import {
  state,
  on,
  getChat,
  getConversation,
  upsertConversation,
  addMessages,
  sortedMessages,
  pendingFor,
  messageStatus,
  conversationTitle,
  otherMembers,
  memberById,
  typingUsers,
  applyRead,
} from '../store.js';
import { enqueue, retry, discard, canRetry } from '../outbox.js';
import { prepareImage } from '../images.js';
import { conversationAvatar, totalUnread } from './chats.js';
import { toast } from './common.js';

const PAGE = 50;
const GROUP_GAP_MS = 5 * 60 * 1000;
const TYPING_THROTTLE_MS = 2000;

const $ = (id) => document.getElementById(id);

let convId = null;
let openSeq = 0;
let socketRef = null;
let lastTypingSent = 0;
let readPosted = 0;
/** Whether the list was at the bottom as of the last scroll (images growing later don't scroll). */
let pinnedToBottom = true;
const drafts = new Map();

/** key -> element for messages and day separators currently in the list */
const elements = new Map();

// ---------- open / close ----------

export function currentConversationId() {
  return convId;
}

/** True when the user can actually see the open chat. */
export function isChatVisible(id) {
  return convId === id && !$('chat-screen').hidden && document.visibilityState === 'visible';
}

export async function openChat(id) {
  if (convId === id) {
    render();
    maybeMarkRead();
    return;
  }
  closeChat();
  convId = id;
  const seq = ++openSeq;
  readPosted = 0;
  lastTypingSent = 0;

  const input = $('message-input');
  input.value = drafts.get(id) || '';
  autosize();
  updateSendState();

  renderHeader();
  renderTyping();
  render({ forceBottom: true });

  if (!getConversation(id)) {
    try {
      const { conversation } = await Api.conversation(id);
      if (seq !== openSeq) return;
      upsertConversation(conversation);
    } catch (err) {
      if (seq !== openSeq) return;
      if (err.status === 403 || err.status === 404) {
        toast('That chat does not exist or you are not in it.');
        location.replace('#/');
        return;
      }
    }
  }
  renderHeader();

  try {
    await fetchLatest(id);
  } catch {
    /* offline: show what we have; the socket reconnect will catch up */
  }
  if (seq !== openSeq) return;
  render({ forceBottom: true });
  maybeMarkRead();
  fillViewport();
  if (!isTouchDevice()) input.focus({ preventScroll: true });
}

export function closeChat() {
  // Logged out: forget unsent drafts so the next account on this device never sees them.
  if (!getToken()) drafts.clear();
  if (!convId) return;
  if (getToken()) drafts.set(convId, $('message-input').value);
  convId = null;
  openSeq++;
  elements.clear();
  clear($('message-list'));
  $('older-status').hidden = true;
  pinnedToBottom = true;
  $('typing-indicator').hidden = true;
  closeViewer();
}

// ---------- loading ----------

/**
 * Fetch the newest page and, if we already had older messages cached, keep
 * paging back until the gap between them is closed (catch-up after offline).
 */
async function fetchLatest(id) {
  const chat = getChat(id);
  let knownNewest = 0;
  for (const m of chat.messages.values()) if (m.id > knownNewest) knownNewest = m.id;

  const { messages } = await Api.messages(id, { limit: PAGE });
  let batch = messages;
  let lastPageFull = messages.length === PAGE;

  if (chat.loaded && knownNewest) {
    let pages = 0;
    while (lastPageFull && batch.length && batch[0].id > knownNewest && pages < 10) {
      const older = await Api.messages(id, { before: batch[0].id, limit: PAGE });
      batch = older.messages.concat(batch);
      lastPageFull = older.messages.length === PAGE;
      pages++;
    }
    if (lastPageFull && batch.length && batch[0].id > knownNewest) {
      // Too far behind: drop the stale cache rather than show a hole.
      chat.messages.clear();
      chat.hasMore = true;
    }
  } else {
    chat.hasMore = lastPageFull;
  }
  chat.loaded = true;
  addMessages(id, batch, { silent: true });
}

/** Called after the socket (re)connects. */
export async function catchUp() {
  const id = convId;
  // Closed chats may have missed messages while we were disconnected, and a live message
  // arriving before they are reopened would hide that gap from fetchLatest: drop them.
  for (const cid of [...state.chats.keys()]) if (cid !== id) state.chats.delete(cid);
  if (!id) return;
  try {
    await fetchLatest(id);
  } catch {
    return;
  }
  if (id !== convId) return;
  render();
  maybeMarkRead();
}

async function loadOlder() {
  const id = convId;
  const chat = getChat(id);
  if (!chat.loaded || !chat.hasMore || chat.loadingOlder) return;
  const msgs = sortedMessages(id);
  if (!msgs.length) {
    chat.hasMore = false;
    return;
  }
  chat.loadingOlder = true;
  const status = $('older-status');
  status.textContent = 'Loading earlier messages…';
  status.hidden = false;
  try {
    const { messages } = await Api.messages(id, { before: msgs[0].id, limit: PAGE });
    chat.hasMore = messages.length === PAGE;
    if (id !== convId) return;
    addMessages(id, messages, { silent: true });
    render({ preserveFromBottom: true });
  } catch {
    if (id === convId) toast('Could not load earlier messages.');
  } finally {
    chat.loadingOlder = false;
    if (id === convId) updateOlderStatus();
  }
}

function updateOlderStatus() {
  const chat = convId && getChat(convId);
  const status = $('older-status');
  if (chat && chat.loaded && !chat.hasMore && chat.messages.size > 0) {
    status.textContent = 'This is the beginning of the conversation.';
    status.hidden = false;
  } else if (!chat || !chat.loadingOlder) {
    status.hidden = true;
  }
}

/** If the first page doesn't fill the screen, fetch more so scrolling works. */
function fillViewport() {
  const box = $('messages');
  const chat = convId && getChat(convId);
  if (chat && chat.hasMore && box.scrollHeight <= box.clientHeight + 40) loadOlder();
}

// ---------- rendering ----------

function isNearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function renderHeader() {
  const conv = getConversation(convId);
  const title = $('chat-title');
  const subtitle = $('chat-subtitle');
  const av = $('chat-avatar');
  clear(av);
  if (!conv) {
    title.textContent = 'Loading…';
    subtitle.textContent = '';
    return;
  }
  title.textContent = conversationTitle(conv);
  av.appendChild(conversationAvatar(conv, 'small'));
  if (conv.isGroup) {
    const n = (conv.members || []).length;
    subtitle.textContent = `${n} ${n === 1 ? 'member' : 'members'}`;
  } else {
    const other = otherMembers(conv)[0];
    if (!other) subtitle.textContent = 'Notes to self';
    else subtitle.textContent = state.online.has(other.id) ? 'online' : `@${other.username}`;
  }
  const unreadElsewhere = totalUnread(convId);
  const badge = $('back-badge');
  badge.textContent = unreadElsewhere > 99 ? '99+' : String(unreadElsewhere);
  badge.hidden = unreadElsewhere === 0;
  $('back-button').setAttribute(
    'aria-label',
    unreadElsewhere ? `Back to chats, ${unreadElsewhere} unread` : 'Back to chats',
  );
}

function renderTyping() {
  const el = $('typing-indicator');
  if (!convId) {
    el.hidden = true;
    return;
  }
  const conv = getConversation(convId);
  const names = typingUsers(convId).map((uid) => {
    const m = memberById(conv, uid);
    return m ? m.displayName : 'Someone';
  });
  if (!names.length) {
    el.hidden = true;
    return;
  }
  let text;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = 'Several people are typing…';
  $('typing-text').textContent = text;
  const wasBottom = isNearBottom();
  el.hidden = false;
  if (wasBottom) scrollToBottom();
}

/** Normalise server and pending messages into one render model. */
function buildItems(conv) {
  const meId = state.me ? state.me.id : null;
  const items = sortedMessages(convId).map((m) => ({
    key: `m:${m.senderId}:${m.clientId || m.id}`,
    id: m.id,
    clientId: m.clientId || null,
    senderId: m.senderId,
    mine: m.senderId === meId,
    body: m.body || '',
    image: m.attachment ? attachmentUrl(m.attachment.id) : null,
    createdAt: m.createdAt,
    status: m.senderId === meId && conv ? messageStatus(conv, m) : null,
  }));
  for (const p of pendingFor(convId)) {
    items.push({
      key: `m:${meId}:${p.clientId}`,
      id: null,
      clientId: p.clientId,
      senderId: meId,
      mine: true,
      body: p.body || '',
      image: p.localUrl || (p.attachmentId ? attachmentUrl(p.attachmentId) : null),
      createdAt: p.createdAt,
      status: p.state === 'failed' ? 'failed' : 'sending',
      pending: p,
    });
  }
  return items;
}

function separatorEl(key, ts) {
  let el = elements.get(key);
  if (!el) {
    el = h('div', { class: 'day-separator', role: 'separator', text: formatDay(ts) });
    elements.set(key, el);
  }
  return el;
}

function createMessageEl(item) {
  const bubble = h('div', { class: 'bubble' });
  if (item.image) {
    bubble.classList.add('has-image');
    const img = h('img', {
      class: 'message-image',
      dataset: { testid: 'message-image' },
      alt: 'Photo',
      decoding: 'async',
      loading: 'lazy',
    });
    img.src = item.image;
    img.dataset.src = item.image;
    img.addEventListener('load', () => {
      // Images change height after load; stay pinned to the bottom if we were.
      if (pinnedToBottom && img.isConnected) scrollToBottom();
    });
    img.addEventListener('click', () => openViewer(img.src));
    bubble.appendChild(img);
  }
  bubble.appendChild(h('span', { class: 'message-body', dataset: { testid: 'message-body' }, text: item.body }));

  const el = h(
    'div',
    {
      class: 'message',
      role: 'listitem',
      dataset: { testid: 'message', mine: item.mine ? 'true' : 'false' },
    },
    h('span', { class: 'sender-name', hidden: true }),
    bubble,
    h(
      'div',
      { class: 'meta' },
      h('time', { class: 'message-time', datetime: new Date(item.createdAt).toISOString(), text: formatTime(item.createdAt) }),
    ),
  );
  if (item.clientId) el.dataset.clientId = item.clientId;
  el.addEventListener('animationend', () => el.classList.remove('new-arrival'));
  if (item.mine) {
    el.querySelector('.meta').appendChild(
      h('span', { class: 'message-status', dataset: { testid: 'message-status' } }),
    );
  }
  return el;
}

function updateMessageEl(el, item, { grpStart, grpEnd, isGroup, conv, fresh }) {
  el.classList.toggle('mine', item.mine);
  el.classList.toggle('grp-start', grpStart);
  el.classList.toggle('grp-end', grpEnd);
  el.classList.toggle('sending', item.status === 'sending');
  el.classList.toggle('failed', item.status === 'failed');
  if (fresh) el.classList.add('new-arrival');

  if (item.id !== null && el.dataset.messageId !== String(item.id)) {
    el.dataset.messageId = String(item.id);
  }

  const name = el.querySelector('.sender-name');
  const showName = isGroup && !item.mine && grpStart;
  name.hidden = !showName;
  if (showName) {
    const sender = memberById(conv, item.senderId);
    name.textContent = sender ? sender.displayName : 'Former member';
  }

  const img = el.querySelector('.message-image');
  if (img && item.image && img.dataset.src !== item.image) {
    const next = item.image;
    const prev = img.dataset.src;
    img.dataset.src = next;
    if (prev && prev.startsWith('blob:')) {
      // Swap the local preview for the server copy once it has loaded: no flicker.
      const pre = new Image();
      pre.onload = pre.onerror = () => {
        if (img.dataset.src === next) img.src = next;
        URL.revokeObjectURL(prev);
      };
      pre.src = next;
    } else {
      img.src = next;
    }
  }
  if (img) {
    const sender = memberById(conv, item.senderId);
    img.alt = item.mine ? 'Photo you sent' : `Photo from ${sender ? sender.displayName : 'someone'}`;
  }

  const time = el.querySelector('.message-time');
  const timeText = formatTime(item.createdAt);
  if (time.textContent !== timeText) time.textContent = timeText;

  if (item.mine) {
    const status = el.querySelector('.message-status');
    if (status.textContent !== item.status) {
      status.textContent = item.status;
      status.className = `message-status ${item.status}`;
    }
    let retryBtn = el.querySelector('.retry-btn');
    if (item.status === 'failed' && item.pending) {
      if (!retryBtn) {
        const p = item.pending;
        retryBtn = h('button', {
          type: 'button',
          class: 'retry-btn',
          text: canRetry(p) ? 'Retry' : 'Remove',
          onclick: () => (canRetry(p) ? retry(p.clientId) : discard(p.clientId)),
        });
        el.querySelector('.meta').appendChild(retryBtn);
      }
    } else if (retryBtn) {
      retryBtn.remove();
    }
  }
}

let renderScheduled = null;

/** Batch bursts of events into one render per frame. */
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = requestAnimationFrame(() => {
    renderScheduled = null;
    render();
    maybeMarkRead();
  });
}

function render({ forceBottom = false, preserveFromBottom = false } = {}) {
  if (renderScheduled) {
    cancelAnimationFrame(renderScheduled);
    renderScheduled = null;
  }
  if (!convId) return;
  const box = $('messages');
  const list = $('message-list');
  const conv = getConversation(convId);
  const isGroup = !!(conv && conv.isGroup);
  const wasAtBottom = isNearBottom();
  const fromBottom = box.scrollHeight - box.scrollTop;
  const firstRender = elements.size === 0;

  const items = buildItems(conv);
  const desired = [];
  let prevDay = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prev = items[i - 1];
    const next = items[i + 1];
    const dk = dayKey(item.createdAt);
    if (dk !== prevDay) {
      desired.push(separatorEl(`d:${dk}`, item.createdAt));
      prevDay = dk;
    }
    const grpStart =
      !prev ||
      prev.senderId !== item.senderId ||
      item.createdAt - prev.createdAt > GROUP_GAP_MS ||
      dayKey(prev.createdAt) !== dk;
    const grpEnd =
      !next ||
      next.senderId !== item.senderId ||
      next.createdAt - item.createdAt > GROUP_GAP_MS ||
      dayKey(next.createdAt) !== dk;

    let el = elements.get(item.key);
    const fresh = !el && !firstRender && !preserveFromBottom;
    // Rebuild if ownership changed (e.g. `me` arrived after the first render).
    if (!el || el.dataset.mine !== String(item.mine)) {
      el = createMessageEl(item);
      elements.set(item.key, el);
    }
    updateMessageEl(el, item, { grpStart, grpEnd, isGroup, conv, fresh });
    desired.push(el);
  }

  // Keyed reconcile: move/insert only what changed.
  const keep = new Set(desired);
  let cursor = list.firstChild;
  for (const el of desired) {
    if (el === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(el, cursor);
  }
  while (cursor) {
    const nextNode = cursor.nextSibling;
    list.removeChild(cursor);
    cursor = nextNode;
  }
  for (const [key, el] of elements) if (!keep.has(el)) elements.delete(key);

  if (preserveFromBottom) box.scrollTop = box.scrollHeight - fromBottom;
  else if (forceBottom || wasAtBottom || firstRender) scrollToBottom();
  updateOlderStatus();
}

// ---------- read receipts ----------

export function maybeMarkRead() {
  if (!convId || !state.me || !isChatVisible(convId)) return;
  const conv = getConversation(convId);
  if (!conv) return;
  const meId = state.me.id;
  const myRead = Math.max((conv.readUpTo || {})[meId] || 0, readPosted);
  let newest = 0;
  let hasUnreadFromOthers = false;
  for (const m of getChat(convId).messages.values()) {
    if (m.id > newest) newest = m.id;
    if (m.senderId !== meId && m.id > myRead) hasUnreadFromOthers = true;
  }
  if (!newest || newest <= myRead) return;
  if (!hasUnreadFromOthers && !conv.unreadCount) return;
  const id = convId;
  readPosted = newest;
  applyRead(id, meId, newest);
  Api.markRead(id, newest).catch(() => {
    if (convId === id && readPosted === newest) readPosted = 0;
  });
}

// ---------- composer ----------

function autosize() {
  const input = $('message-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
}

function updateSendState() {
  $('send-button').classList.toggle('idle', !$('message-input').value.trim());
}

function sendTyping() {
  const now = Date.now();
  if (!convId || !socketRef || now - lastTypingSent < TYPING_THROTTLE_MS) return;
  if (socketRef.send({ type: 'typing', conversationId: convId })) lastTypingSent = now;
}

function submit() {
  const input = $('message-input');
  const body = input.value.trim();
  if (!body || !convId) return;
  enqueue({ conversationId: convId, body });
  input.value = '';
  drafts.delete(convId);
  lastTypingSent = 0;
  autosize();
  updateSendState();
  render({ forceBottom: true });
}

async function attach(file) {
  if (!file || !convId) return;
  const id = convId;
  if (!file.type.startsWith('image/')) {
    toast('Only photos can be sent right now.');
    return;
  }
  let blob;
  try {
    blob = await prepareImage(file);
  } catch (err) {
    toast(err.message || 'Could not read that photo.');
    return;
  }
  if (blob.size > 10 * 1024 * 1024) {
    toast('That photo is too large (max 10 MB).');
    return;
  }
  enqueue({ conversationId: id, body: '', file: blob });
  if (id === convId) render({ forceBottom: true });
}

// ---------- image viewer ----------

let viewer = null;

function openViewer(src) {
  closeViewer();
  const previous = document.activeElement;
  viewer = h(
    'button',
    { type: 'button', class: 'viewer', 'aria-label': 'Close photo' },
    h('img', { src, alt: '' }),
  );
  viewer.addEventListener('click', () => {
    closeViewer();
    if (previous && previous.focus) previous.focus();
  });
  document.body.appendChild(viewer);
  viewer.focus();
}

function closeViewer() {
  if (viewer) {
    viewer.remove();
    viewer = null;
  }
}

// ---------- init ----------

export function initChat({ socket }) {
  socketRef = socket;
  const input = $('message-input');

  $('back-button').addEventListener('click', () => {
    location.hash = '#/';
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  input.addEventListener('keydown', (e) => {
    // Desktop: Enter sends, Shift+Enter is a newline. Touch keyboards: Enter is a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouchDevice()) {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', () => {
    autosize();
    updateSendState();
    if (input.value.trim()) sendTyping();
  });

  // Keep the keyboard open on phones when tapping Send.
  $('send-button').addEventListener('pointerdown', (e) => {
    if (document.activeElement === input && e.pointerType !== 'mouse') e.preventDefault();
  });

  $('attach-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    attach(file);
    e.target.value = '';
  });

  $('messages').addEventListener(
    'scroll',
    () => {
      pinnedToBottom = isNearBottom();
      if ($('messages').scrollTop < 200) loadOlder();
    },
    { passive: true },
  );

  // The keyboard opening, the composer growing or the typing indicator appearing all
  // shrink the list: keep the newest message in view if we were at the bottom.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (convId && pinnedToBottom) scrollToBottom();
    }).observe($('messages'));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && viewer) closeViewer();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeMarkRead();
  });
  window.addEventListener('focus', maybeMarkRead);

  on('messages', (id) => {
    if (id === convId) scheduleRender();
  });
  on('read', (id) => {
    if (id === convId) scheduleRender();
  });
  on('conversation', (id) => {
    if (id === convId) {
      renderHeader();
      scheduleRender();
    }
  });
  on('conversations', () => {
    if (convId) renderHeader();
  });
  on('typing', (id) => {
    if (id === convId) renderTyping();
  });
  on('presence', () => {
    if (convId) renderHeader();
  });
  on('me', () => {
    if (!convId) return;
    renderHeader();
    scheduleRender();
  });
}
