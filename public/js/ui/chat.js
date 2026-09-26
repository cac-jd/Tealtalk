// An open conversation: message list, typing indicator, composer, and the
// per-message actions (reactions, reply, edit, unsend, copy).

import { Api, attachmentUrl, getToken } from '../api.js';
import { h, clear, dayKey, formatDay, formatTime, isTouchDevice } from '../dom.js';
import {
  state,
  on,
  getChat,
  getConversation,
  upsertConversation,
  addMessages,
  replaceMessage,
  findMessage,
  sortedMessages,
  pendingFor,
  messageStatus,
  conversationTitle,
  otherMembers,
  memberById,
  userName,
  typingUsers,
  applyRead,
  attachmentKind,
  kindLabel,
  systemText,
  messageSummary,
} from '../store.js';
import { enqueue, retry, discard, canRetry, cancelUpload } from '../outbox.js';
import { prepareImage } from '../images.js';
import { prepareVideo, videoMime } from '../video.js';
import { conversationAvatar, totalUnread } from './chats.js';
import { toast, announce, icon, ICONS } from './common.js';
import { imageEl, videoEl, audioEl, expiredEl, closeViewer, viewerOpen } from './media.js';
import { openMenu, closeMenu, menuOpen } from './menu.js';
import { initRecorder, cancelRecording, isRecording } from './recorder.js';

const PAGE = 50;
const GROUP_GAP_MS = 5 * 60 * 1000;
const TYPING_THROTTLE_MS = 2000;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const UNSEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const LONG_PRESS_MS = 500;

const $ = (id) => document.getElementById(id);

let convId = null;
let openSeq = 0;
let socketRef = null;
let lastTypingSent = 0;
let readPosted = 0;
/**
 * Whether the list should stay on the newest message. Only the user scrolling
 * up unpins it; content growing underneath (photos loading, reactions) doesn't.
 */
let pinnedToBottom = true;
let lastScrollTop = 0;
const drafts = new Map();

/** Composer modes: replying to a message, or editing one of mine. */
let replyTo = null;
let editing = null;
let draftBeforeEdit = '';

/** key -> element for messages and day separators currently in the list */
const elements = new Map();
/** message element -> its latest render item */
const itemOf = new WeakMap();

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
  closeMenu({ restoreFocus: false });
  closeViewer();
  if (isRecording()) cancelRecording();
  if (!convId) return;
  if (getToken()) drafts.set(convId, editing ? draftBeforeEdit : $('message-input').value);
  setReply(null);
  setEditing(null, { restoreDraft: false });
  convId = null;
  openSeq++;
  elements.clear();
  clear($('message-list'));
  $('older-status').hidden = true;
  pinnedToBottom = true;
  lastScrollTop = 0;
  $('typing-indicator').hidden = true;
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

/** Load one older page. Resolves true if one was added. */
async function loadOlder() {
  const id = convId;
  const chat = getChat(id);
  if (!chat.loaded || !chat.hasMore || chat.loadingOlder) return false;
  const msgs = sortedMessages(id);
  if (!msgs.length) {
    chat.hasMore = false;
    return false;
  }
  chat.loadingOlder = true;
  const status = $('older-status');
  status.textContent = 'Loading earlier messages…';
  status.hidden = false;
  try {
    const { messages } = await Api.messages(id, { before: msgs[0].id, limit: PAGE });
    chat.hasMore = messages.length === PAGE;
    if (id !== convId) return false;
    addMessages(id, messages, { silent: true });
    render({ preserveFromBottom: true });
    return messages.length > 0;
  } catch {
    if (id === convId) toast('Could not load earlier messages.');
    return false;
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

// ---------- scrolling ----------

function isNearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
  lastScrollTop = box.scrollTop;
  pinnedToBottom = true;
}

/** Something changed size (a photo loaded, the keyboard opened): stay on the newest message. */
function keepPinned() {
  if (convId && pinnedToBottom) scrollToBottom();
}

function onScroll() {
  const box = $('messages');
  const top = box.scrollTop;
  if (isNearBottom()) pinnedToBottom = true;
  else if (top < lastScrollTop - 1) pinnedToBottom = false; // the user scrolled up
  lastScrollTop = top;
  if (top < 200) loadOlder();
}

// ---------- header ----------

function renderHeader() {
  const conv = getConversation(convId);
  const title = $('chat-title');
  const subtitle = $('chat-subtitle');
  const av = $('chat-avatar');
  clear(av);
  $('group-info-button').hidden = !(conv && conv.isGroup);
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
  el.hidden = false;
  keepPinned();
}

// ---------- render model ----------

function serverAttachment(att) {
  const kind = attachmentKind(att);
  const url = att.expired ? null : attachmentUrl(att.id);
  let thumbUrl = null;
  if (!att.expired) thumbUrl = att.thumbnailId ? attachmentUrl(att.thumbnailId) : kind === 'image' ? url : null;
  return {
    kind,
    mime: att.mime || '',
    url,
    thumbUrl,
    width: att.width || null,
    height: att.height || null,
    durationMs: att.durationMs || null,
    expired: !!att.expired,
    pending: false,
  };
}

function pendingAttachment(p) {
  const m = p.media || { kind: 'image', mime: 'image/jpeg' };
  const remote = p.attachmentId ? attachmentUrl(p.attachmentId) : null;
  const remoteThumb = m.thumbnailId ? attachmentUrl(m.thumbnailId) : null;
  let url = remote;
  if (m.kind === 'image') url = remote || p.localUrl || null;
  if (m.kind === 'audio') url = p.fileUrl || remote;
  return {
    kind: m.kind,
    mime: m.mime,
    url,
    thumbUrl: p.localUrl || remoteThumb || (m.kind === 'image' ? remote : null),
    width: m.width,
    height: m.height,
    durationMs: m.durationMs,
    expired: false,
    pending: true,
    uploading: !!p.needsUpload,
    progress: p.progress || 0,
  };
}

/** A reply quote for a message still in the outbox (the server fills `replyTo` later). */
function localReplyTo(id) {
  const m = findMessage(convId, id);
  if (!m) return { id, senderId: null, body: '', attachmentKind: null, deleted: false };
  return {
    id,
    senderId: m.senderId,
    body: (m.body || '').slice(0, 200),
    attachmentKind: m.attachment ? attachmentKind(m.attachment) : null,
    deleted: !!m.deletedAt,
  };
}

/** Normalise server and pending messages into one render model. */
function buildItems(conv) {
  const meId = state.me ? state.me.id : null;
  const items = sortedMessages(convId).map((m) => {
    if (m.system) {
      return { key: `s:${m.id}`, system: true, id: m.id, senderId: `system:${m.id}`, createdAt: m.createdAt, msg: m };
    }
    const mine = meId !== null && m.senderId === meId;
    const deleted = !!m.deletedAt;
    return {
      key: `m:${m.senderId}:${m.clientId || m.id}`,
      id: m.id,
      clientId: m.clientId || null,
      senderId: m.senderId,
      mine,
      body: deleted ? '' : m.body || '',
      attachment: !deleted && m.attachment ? serverAttachment(m.attachment) : null,
      replyTo: deleted ? null : m.replyTo || null,
      reactions: deleted ? {} : m.reactions || {},
      edited: !!m.editedAt && !deleted,
      deleted,
      createdAt: m.createdAt,
      status: mine && conv ? messageStatus(conv, m) : null,
      msg: m,
    };
  });
  for (const p of pendingFor(convId)) {
    items.push({
      key: `m:${meId}:${p.clientId}`,
      id: null,
      clientId: p.clientId,
      senderId: meId,
      mine: true,
      body: p.body || '',
      attachment: p.media || p.attachmentId ? pendingAttachment(p) : null,
      replyTo: p.replyToId ? localReplyTo(p.replyToId) : null,
      reactions: {},
      edited: false,
      deleted: false,
      createdAt: p.createdAt,
      status: p.state === 'failed' ? 'failed' : 'sending',
      pending: p,
    });
  }
  return items;
}

// ---------- message elements ----------

function separatorEl(key, ts) {
  let el = elements.get(key);
  if (!el) {
    el = h('div', { class: 'day-separator', role: 'separator', text: formatDay(ts) });
    elements.set(key, el);
  }
  return el;
}

function systemEl(item, conv) {
  let el = elements.get(item.key);
  if (!el) {
    el = h('div', {
      class: 'system-message',
      role: 'listitem',
      dataset: { testid: 'system-message', messageId: String(item.id) },
    });
    elements.set(item.key, el);
  }
  const text = systemText(conv, item.msg);
  if (el.textContent !== text) el.textContent = text;
  return el;
}

function createMessageEl(item) {
  const bubble = h('div', { class: 'bubble' });
  const more = h(
    'button',
    { type: 'button', class: 'msg-more', 'aria-label': 'Message actions', 'aria-haspopup': 'menu' },
    icon(ICONS.more),
  );
  const el = h(
    'div',
    {
      class: 'message',
      role: 'listitem',
      tabindex: '-1',
      dataset: { testid: 'message', mine: item.mine ? 'true' : 'false' },
    },
    h('span', { class: 'sender-name', hidden: true }),
    h('div', { class: 'bubble-wrap' }, bubble, more),
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

/** Everything in the bubble that means rebuilding its content when it changes. */
function contentSignature(item) {
  const a = item.attachment;
  const r = item.replyTo;
  return [
    item.deleted ? 'deleted' : '',
    a ? `${a.kind}:${a.expired}:${a.kind === 'image' ? '' : `${a.pending}:${a.url}`}` : '',
    r ? `${r.id}:${r.deleted}:${r.senderId}:${r.body}:${r.attachmentKind}` : '',
  ].join('|');
}

function senderLabel(conv, item) {
  return item.mine ? 'you' : userName(conv, item.senderId);
}

function replyQuoteEl(conv, r) {
  const meId = state.me && state.me.id;
  const who = r.senderId === meId ? 'You' : r.senderId ? userName(conv, r.senderId) : '';
  const snippet = r.deleted
    ? 'This message was unsent'
    : (r.body || '').replace(/\s+/g, ' ').trim() || (r.attachmentKind ? kindLabel(r.attachmentKind) : 'Message');
  return h(
    'button',
    {
      type: 'button',
      class: 'reply-quote',
      dataset: { testid: 'message-reply-quote', replyId: String(r.id) },
      'aria-label': `Reply to ${who || 'a message'}: ${snippet}. Show the original message`,
      onclick: (e) => {
        e.stopPropagation();
        jumpTo(r.id);
      },
    },
    who ? h('span', { class: 'reply-quote-name', text: who }) : null,
    h('span', { class: `reply-quote-text${r.deleted ? ' unsent' : ''}`, text: snippet }),
  );
}

function mediaEl(conv, item) {
  const a = item.attachment;
  if (a.expired) return expiredEl(a.kind);
  const from = item.mine ? 'you' : userName(conv, item.senderId);
  if (a.kind === 'video') return videoEl(a, { onLoad: keepPinned });
  if (a.kind === 'audio') return audioEl(a, { label: `Voice message from ${from}` });
  return imageEl(a, { alt: item.mine ? 'Photo you sent' : `Photo from ${from}`, onLoad: keepPinned });
}

function buildBubble(bubble, conv, item) {
  clear(bubble);
  bubble.className = 'bubble';
  if (item.deleted) {
    bubble.classList.add('unsent');
    bubble.appendChild(h('span', { class: 'message-unsent', dataset: { testid: 'message-unsent' }, text: 'This message was unsent' }));
    bubble.appendChild(h('span', { class: 'message-body', dataset: { testid: 'message-body' } }));
    return;
  }
  if (item.replyTo) bubble.appendChild(replyQuoteEl(conv, item.replyTo));
  if (item.attachment) {
    bubble.classList.add('has-media', `has-${item.attachment.kind}`);
    bubble.appendChild(mediaEl(conv, item));
  }
  bubble.appendChild(h('span', { class: 'message-body', dataset: { testid: 'message-body' } }));
}

function updateImage(bubble, item) {
  const img = bubble.querySelector('.message-image');
  if (!img) return;
  const a = item.attachment;
  const next = a.thumbUrl || a.url;
  img.dataset.full = a.url || next;
  if (!next || img.dataset.src === next) return;
  const prev = img.dataset.src;
  img.dataset.src = next;
  if (prev && prev.startsWith('blob:')) {
    // Swap the local preview for the server copy once it has loaded: no flicker.
    const pre = new Image();
    pre.onload = pre.onerror = () => {
      if (img.dataset.src === next) img.src = next;
    };
    pre.src = next;
  } else {
    img.src = next;
  }
}

function setProgress(bar, fraction) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100);
  const progress = bar.querySelector('progress');
  if (progress.value !== pct) progress.value = pct;
  const label = `${pct}%`;
  const text = bar.querySelector('.upload-percent');
  if (text.textContent !== label) text.textContent = label;
}

function updateUpload(bubble, item) {
  const a = item.attachment;
  let bar = bubble.querySelector('.upload-status');
  if (!a || !a.uploading || item.status === 'failed') {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    const p = item.pending;
    bar = h(
      'div',
      { class: 'upload-status' },
      h('progress', {
        class: 'upload-progress',
        dataset: { testid: 'upload-progress' },
        max: '100',
        value: '0',
        'aria-label': `Uploading ${kindLabel(a.kind).toLowerCase()}`,
      }),
      h('span', { class: 'upload-percent', 'aria-hidden': 'true' }),
      h(
        'button',
        {
          type: 'button',
          class: 'upload-cancel',
          dataset: { testid: 'upload-cancel' },
          'aria-label': 'Cancel upload',
          onclick: (e) => {
            e.stopPropagation();
            cancelUpload(p.clientId);
            announce('Upload cancelled');
          },
        },
        icon(ICONS.close),
      ),
    );
    bubble.insertBefore(bar, bubble.querySelector('.message-body'));
  }
  setProgress(bar, a.progress);
}

function myReaction(reactions) {
  const meId = state.me && state.me.id;
  for (const [emoji, users] of Object.entries(reactions || {})) if ((users || []).includes(meId)) return emoji;
  return null;
}

function updateReactions(el, item) {
  let box = el.querySelector('.message-reactions');
  const entries = Object.entries(item.reactions || {}).filter(([, users]) => users && users.length);
  if (!entries.length) {
    if (box) box.remove();
    return;
  }
  const meId = state.me && state.me.id;
  const sig = JSON.stringify(entries) + meId;
  if (box && box.dataset.sig === sig) return;
  if (!box) {
    box = h('div', { class: 'message-reactions', dataset: { testid: 'message-reactions' }, role: 'group', 'aria-label': 'Reactions' });
    el.insertBefore(box, el.querySelector('.meta'));
  }
  box.dataset.sig = sig;
  clear(box);
  entries.sort((x, y) => y[1].length - x[1].length);
  for (const [emoji, users] of entries) {
    const mine = users.includes(meId);
    const n = users.length;
    box.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: `reaction-chip${mine ? ' mine' : ''}`,
          dataset: { testid: 'reaction-chip', emoji },
          'aria-pressed': mine ? 'true' : 'false',
          'aria-label': `${emoji} ${n} ${n === 1 ? 'reaction' : 'reactions'}${mine ? ', including yours. Remove yours' : `. React with ${emoji}`}`,
          onclick: (e) => {
            e.stopPropagation();
            const current = itemOf.get(el);
            if (current && current.id !== null) react(current, emoji);
          },
        },
        h('span', { class: 'reaction-emoji', text: emoji }),
        h('span', { class: 'reaction-count', text: String(n) }),
      ),
    );
  }
}

function updateMeta(el, item) {
  const meta = el.querySelector('.meta');
  const time = meta.querySelector('.message-time');
  const timeText = formatTime(item.createdAt);
  if (time.textContent !== timeText) time.textContent = timeText;

  let edited = meta.querySelector('.message-edited');
  if (item.edited && !edited) {
    edited = h('span', { class: 'message-edited', dataset: { testid: 'message-edited' }, text: 'Edited' });
    time.after(edited);
  } else if (!item.edited && edited) {
    edited.remove();
  }

  if (!item.mine) return;
  const status = meta.querySelector('.message-status');
  if (status.textContent !== item.status) {
    status.textContent = item.status;
    status.className = `message-status ${item.status}`;
  }
  let retryBtn = meta.querySelector('.retry-btn');
  if (item.status === 'failed' && item.pending) {
    if (!retryBtn) {
      const p = item.pending;
      retryBtn = h('button', {
        type: 'button',
        class: 'retry-btn',
        text: canRetry(p) ? 'Retry' : 'Remove',
        onclick: () => (canRetry(p) ? retry(p.clientId) : discard(p.clientId)),
      });
      meta.appendChild(retryBtn);
    }
  } else if (retryBtn) {
    retryBtn.remove();
  }
}

function updateMessageEl(el, item, { grpStart, grpEnd, isGroup, conv, fresh }) {
  itemOf.set(el, item);
  el.classList.toggle('mine', item.mine);
  el.classList.toggle('grp-start', grpStart);
  el.classList.toggle('grp-end', grpEnd);
  el.classList.toggle('sending', item.status === 'sending');
  el.classList.toggle('failed', item.status === 'failed');
  el.classList.toggle('is-unsent', item.deleted);
  if (fresh) el.classList.add('new-arrival');

  if (item.id !== null && el.dataset.messageId !== String(item.id)) {
    el.dataset.messageId = String(item.id);
  }

  const name = el.querySelector('.sender-name');
  const showName = isGroup && !item.mine && grpStart;
  name.hidden = !showName;
  if (showName) name.textContent = userName(conv, item.senderId);

  const bubble = el.querySelector('.bubble');
  const sig = contentSignature(item);
  if (bubble.dataset.sig !== sig || !bubble.firstChild) {
    buildBubble(bubble, conv, item);
    bubble.dataset.sig = sig;
  }
  if (item.attachment && item.attachment.kind === 'image' && !item.attachment.expired) updateImage(bubble, item);
  updateUpload(bubble, item);
  const body = bubble.querySelector('.message-body');
  if (body.textContent !== item.body) body.textContent = item.body;

  // An unsent message has no actions, so no menu button.
  el.querySelector('.msg-more').hidden = item.deleted || (!item.body && item.id === null);
  updateReactions(el, item);
  updateMeta(el, item);
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
  const stick = pinnedToBottom || isNearBottom();
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
    if (item.system) {
      desired.push(systemEl(item, conv));
      continue;
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

  if (preserveFromBottom) {
    box.scrollTop = box.scrollHeight - fromBottom;
    lastScrollTop = box.scrollTop;
  } else if (forceBottom || stick || firstRender) {
    scrollToBottom();
  }
  updateOlderStatus();
  if (replyTo) refreshReplyPreview();
}

/** Keep progress bars moving without re-rendering the whole list. */
function onUploadProgress(p) {
  if (p.conversationId !== convId) return;
  const el = elements.get(`m:${state.me && state.me.id}:${p.clientId}`);
  const bar = el && el.querySelector('.upload-status');
  if (bar) setProgress(bar, p.progress);
}

// ---------- jump to a quoted message ----------

async function jumpTo(id) {
  const target = convId;
  let el = null;
  for (let pages = 0; pages < 20; pages++) {
    el = $('message-list').querySelector(`[data-message-id="${CSS.escape(String(id))}"]`);
    if (el || convId !== target) break;
    if (!getChat(convId).hasMore || !(await loadOlder())) break;
  }
  if (!el || convId !== target) {
    toast('The original message is not available.');
    return;
  }
  pinnedToBottom = false;
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  lastScrollTop = $('messages').scrollTop;
  el.classList.remove('highlight');
  void el.offsetWidth; // restart the animation
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1800);
  el.focus({ preventScroll: true });
}

// ---------- message actions ----------

function canEdit(item) {
  return (
    item.mine && item.id !== null && !item.deleted && !item.attachment && !!item.body &&
    Date.now() - item.createdAt < EDIT_WINDOW_MS
  );
}

function canUnsend(item) {
  return item.mine && item.id !== null && !item.deleted && Date.now() - item.createdAt < UNSEND_WINDOW_MS;
}

function openMenuFor(el, returnTo) {
  const item = el && itemOf.get(el);
  if (!item || item.deleted) return;
  if (menuOpen() && el.classList.contains('menu-target')) return;
  const conv = getConversation(convId);
  const live = item.id !== null;
  const actions = [];
  if (live) actions.push({ testid: 'menu-reply', label: 'Reply', run: () => startReply(item) });
  if (item.body) actions.push({ testid: 'menu-copy', label: 'Copy', run: () => copyText(item.body) });
  if (canEdit(item)) actions.push({ testid: 'menu-edit', label: 'Edit', run: () => startEdit(item) });
  if (canUnsend(item)) actions.push({ testid: 'menu-unsend', label: 'Unsend', danger: true, run: () => unsend(item) });
  const summary = messageSummary(conv, item.msg || { body: item.body });
  openMenu({
    anchor: el,
    bubble: el.querySelector('.bubble'),
    label: `Message from ${senderLabel(conv, item)}: ${summary.slice(0, 60)}`,
    canReact: live,
    myReaction: myReaction(item.reactions),
    onReact: (emoji) => react(item, emoji),
    actions,
    returnTo: returnTo || el,
  });
}

async function react(item, emoji) {
  const id = convId;
  const msg = findMessage(id, item.id);
  if (!msg || !state.me) return;
  const meId = state.me.id;
  const removing = myReaction(msg.reactions) === emoji;
  // Show it right away; the server's copy replaces this a moment later.
  const reactions = {};
  for (const [e, users] of Object.entries(msg.reactions || {})) {
    const rest = users.filter((u) => u !== meId);
    if (rest.length) reactions[e] = rest;
  }
  if (!removing) reactions[emoji] = [...(reactions[emoji] || []), meId];
  replaceMessage(id, { ...msg, reactions });
  try {
    const { message } = removing ? await Api.unreact(id, msg.id) : await Api.react(id, msg.id, emoji);
    addMessages(id, [message]);
    announce(removing ? 'Reaction removed' : `Reacted with ${emoji}`);
  } catch (err) {
    const now = findMessage(id, msg.id);
    if (now) replaceMessage(id, { ...now, reactions: msg.reactions });
    toast(err.message || 'Could not react to that message.');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
    return;
  } catch {
    /* fall back below (older browsers, no permission) */
  }
  const ta = h('textarea', { class: 'clipboard-helper', readonly: true, 'aria-hidden': 'true' });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  toast(ok ? 'Copied' : 'Could not copy. Select the text instead.');
}

async function unsend(item) {
  if (!window.confirm('Unsend this message? It will be removed for everyone in the chat.')) return;
  const id = convId;
  try {
    const { message } = await Api.unsendMessage(id, item.id);
    addMessages(id, [message]);
    announce('Message unsent');
  } catch (err) {
    toast(err.message || 'Could not unsend that message.');
  }
}

// ---------- reply & edit bars ----------

function refreshReplyPreview() {
  const m = replyTo && findMessage(convId, replyTo.id);
  if (!m || m.deletedAt) {
    setReply(null);
    return;
  }
  const conv = getConversation(convId);
  const meId = state.me && state.me.id;
  $('reply-preview-title').textContent = `Replying to ${m.senderId === meId ? 'yourself' : userName(conv, m.senderId)}`;
  $('reply-preview-snippet').textContent = messageSummary(conv, m);
}

function setReply(msg) {
  replyTo = msg ? { id: msg.id } : null;
  $('reply-preview').hidden = !replyTo;
  if (replyTo) refreshReplyPreview();
  keepPinned();
}

function startReply(item) {
  const msg = findMessage(convId, item.id);
  if (!msg) return;
  if (editing) setEditing(null);
  setReply(msg);
  $('message-input').focus({ preventScroll: true });
}

function setEditing(msg, { restoreDraft = true } = {}) {
  const input = $('message-input');
  if (msg) {
    if (!editing) draftBeforeEdit = input.value;
    editing = { id: msg.id };
    input.value = msg.body || '';
    $('edit-bar-snippet').textContent = msg.body || '';
    $('send-button').setAttribute('aria-label', 'Save edit');
  } else {
    if (editing && restoreDraft) input.value = draftBeforeEdit;
    editing = null;
    draftBeforeEdit = '';
    $('send-button').setAttribute('aria-label', 'Send');
  }
  $('edit-bar').hidden = !editing;
  $('composer').classList.toggle('is-editing', !!editing);
  autosize();
  updateSendState();
  keepPinned();
}

function startEdit(item) {
  const msg = findMessage(convId, item.id);
  if (!msg) return;
  setReply(null);
  setEditing(msg);
  const input = $('message-input');
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

async function saveEdit() {
  const input = $('message-input');
  const body = input.value.trim();
  const id = convId;
  const msg = editing && findMessage(id, editing.id);
  if (!msg) {
    setEditing(null);
    return;
  }
  if (!body) {
    toast('A message can’t be empty. Use Unsend to remove it.');
    return;
  }
  setEditing(null);
  if (body === msg.body) return;
  replaceMessage(id, { ...msg, body, editedAt: Date.now() });
  try {
    const { message } = await Api.editMessage(id, msg.id, body);
    addMessages(id, [message]);
    announce('Message edited');
  } catch (err) {
    const now = findMessage(id, msg.id);
    if (now) replaceMessage(id, { ...now, body: msg.body, editedAt: msg.editedAt });
    toast(err.status === 409 ? 'Messages can only be edited for 15 minutes.' : err.message || 'Could not edit that message.');
  }
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

function takeReplyId() {
  const id = replyTo ? replyTo.id : null;
  if (replyTo) setReply(null);
  return id;
}

function submit() {
  if (editing) {
    saveEdit();
    return;
  }
  const input = $('message-input');
  const body = input.value.trim();
  if (!body || !convId) return;
  enqueue({ conversationId: convId, body, replyToId: takeReplyId() });
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
  const isImage = file.type.startsWith('image/');
  const isVideo = !isImage && !!videoMime(file);
  if (!isImage && !isVideo) {
    toast('Only photos and videos can be sent.');
    return;
  }
  let media;
  try {
    if (isVideo) {
      const info = await prepareVideo(file);
      media = { kind: 'video', file, mime: videoMime(file), thumb: info.poster, ...info };
    } else {
      const img = await prepareImage(file);
      media = { kind: 'image', file: img.file, mime: img.mime, thumb: img.thumbnail, width: img.width, height: img.height };
    }
  } catch (err) {
    toast(err.message || 'Could not read that file.');
    return;
  }
  if (id !== convId) return;
  enqueue({ conversationId: id, body: '', media, replyToId: takeReplyId() });
  render({ forceBottom: true });
}

function sendVoice(blob, mime, durationMs) {
  if (!convId) return;
  enqueue({
    conversationId: convId,
    media: { kind: 'audio', file: blob, mime, durationMs },
    replyToId: takeReplyId(),
  });
  render({ forceBottom: true });
}

// ---------- long-press / right-click ----------

function initMessageGestures() {
  const list = $('message-list');
  let press = null;
  let suppressClickUntil = 0;

  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  list.addEventListener('pointerdown', (e) => {
    suppressClickUntil = 0; // a new press: only the long-press's own click is swallowed
    if (e.pointerType === 'mouse' || e.button > 0) return;
    const bubble = e.target.closest('.bubble');
    const el = bubble && bubble.closest('.message');
    if (!el || e.target.closest('button, a, video, .message-audio')) return;
    cancelPress();
    press = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        press = null;
        suppressClickUntil = Date.now() + 800;
        if (navigator.vibrate) navigator.vibrate(10);
        openMenuFor(el);
      }, LONG_PRESS_MS),
    };
  });
  list.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  });
  // A finger that starts scrolling sends pointercancel; content moving under a still finger
  // (a photo loading) doesn't cancel the press.
  for (const type of ['pointerup', 'pointercancel']) list.addEventListener(type, cancelPress);

  // Right-click on desktop; Android also sends this on a long-press.
  list.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.message');
    if (!el || e.target.closest('a, video')) return;
    e.preventDefault();
    cancelPress();
    openMenuFor(el);
  });
  list.addEventListener(
    'click',
    (e) => {
      // The long-press shouldn't also "click" (e.g. open the photo) when the finger lifts.
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const more = e.target.closest('.msg-more');
      if (more) openMenuFor(more.closest('.message'), more);
    },
    true,
  );
  // Keyboard: the context-menu key or Shift+F10 on a focused message.
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const el = e.target.closest('.message');
      if (el) {
        e.preventDefault();
        openMenuFor(el);
      }
    }
  });
}

// ---------- init ----------

export function initChat({ socket }) {
  socketRef = socket;
  const input = $('message-input');

  $('back-button').addEventListener('click', () => {
    location.hash = '#/';
  });
  $('group-info-button').addEventListener('click', () => {
    if (convId) location.hash = `#/c/${encodeURIComponent(convId)}/info`;
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
    } else if (e.key === 'Escape' && (editing || replyTo)) {
      e.preventDefault();
      if (editing) setEditing(null);
      else setReply(null);
    }
  });

  input.addEventListener('input', () => {
    autosize();
    updateSendState();
    if (input.value.trim() && !editing) sendTyping();
  });

  // Keep the keyboard open on phones when tapping Send.
  $('send-button').addEventListener('pointerdown', (e) => {
    if (document.activeElement === input && e.pointerType !== 'mouse') e.preventDefault();
  });

  $('reply-cancel').addEventListener('click', () => {
    setReply(null);
    input.focus({ preventScroll: true });
  });
  $('edit-cancel').addEventListener('click', () => {
    setEditing(null);
    input.focus({ preventScroll: true });
  });

  $('attach-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    attach(file);
    e.target.value = '';
  });

  initRecorder({ onRecorded: sendVoice });
  initMessageGestures();

  $('messages').addEventListener('scroll', onScroll, { passive: true });

  // The keyboard opening, the composer growing, photos loading or reactions
  // appearing all change sizes: keep the newest message in view if we were there.
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(keepPinned);
    ro.observe($('messages'));
    ro.observe($('message-list'));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && viewerOpen()) closeViewer();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeMarkRead();
  });
  window.addEventListener('focus', maybeMarkRead);

  on('messages', (id) => {
    if (id === convId) scheduleRender();
  });
  on('upload-progress', onUploadProgress);
  on('send-failed', (p) => {
    if (p.conversationId === convId && p.error) toast(p.error);
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
  on('conversation-removed', (id) => {
    if (id === convId) location.replace('#/');
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
