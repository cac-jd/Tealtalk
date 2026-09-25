// Conversation list.

import { h, clear, avatar, formatListTime, initials } from '../dom.js';
import {
  state,
  on,
  sortedConversations,
  conversationTitle,
  otherMembers,
  memberById,
  typingUsers,
} from '../store.js';

const $ = (id) => document.getElementById(id);

export function previewText(conv) {
  const typing = typingUsers(conv.id);
  if (typing.length) {
    if (!conv.isGroup) return 'typing…';
    const who = memberById(conv, typing[0]);
    return `${who ? who.displayName : 'Someone'} is typing…`;
  }
  const msg = conv.lastMessage;
  if (!msg) return conv.isGroup ? 'New group' : 'Say hi';
  const text = msg.body ? msg.body.replace(/\s+/g, ' ') : msg.attachment ? 'Photo' : '';
  if (state.me && msg.senderId === state.me.id) return `You: ${text}`;
  if (conv.isGroup) {
    const sender = memberById(conv, msg.senderId);
    if (sender) return `${sender.displayName}: ${text}`;
  }
  return text;
}

export function conversationAvatar(conv, extraClass = '') {
  if (conv.isGroup) {
    const label = conv.title ? initials(conv.title) : String((conv.members || []).length);
    const el = avatar(conv.id, '', `group ${extraClass}`);
    el.textContent = label;
    return el;
  }
  const other = otherMembers(conv)[0] || state.me || { id: conv.id, displayName: '?' };
  return avatar(other.id, other.displayName, extraClass);
}

function renderItem(conv) {
  const unread = conv.unreadCount || 0;
  const title = conversationTitle(conv);
  const time = conv.lastMessage ? conv.lastMessage.createdAt : conv.createdAt;
  const button = h(
    'button',
    {
      type: 'button',
      class: `conversation-item${unread ? ' unread' : ''}`,
      dataset: { testid: 'conversation-item', conversationId: conv.id },
      onclick: () => {
        location.hash = `#/c/${encodeURIComponent(conv.id)}`;
      },
    },
    conversationAvatar(conv),
    h(
      'span',
      { class: 'conv-main' },
      h(
        'span',
        { class: 'conv-top' },
        h('span', { class: 'conv-name', text: title }),
        time ? h('time', { class: 'conv-time', datetime: new Date(time).toISOString(), text: formatListTime(time) }) : null,
      ),
      h(
        'span',
        { class: 'conv-bottom' },
        h('span', { class: 'conv-preview', text: previewText(conv) }),
        unread
          ? [
              h('span', { class: 'unread-badge', dataset: { testid: 'unread-badge' }, text: String(unread) }),
              h('span', { class: 'sr-only', text: unread === 1 ? ' unread message' : ' unread messages' }),
            ]
          : null,
      ),
    ),
  );
  return h('li', {}, button);
}

let scheduled = false;

export function renderChats() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    renderNow();
  });
}

function renderNow() {
  const list = $('conv-list');
  const convs = sortedConversations();
  // Preserve keyboard focus across re-renders.
  const focusedId = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.conversationId
    : null;
  clear(list);
  for (const conv of convs) list.appendChild(renderItem(conv));
  $('chats-empty').hidden = convs.length > 0;
  if (focusedId) {
    const again = list.querySelector(`[data-conversation-id="${CSS.escape(focusedId)}"]`);
    if (again) again.focus();
  }
  updateDocumentTitle();
}

export function totalUnread(exceptId = null) {
  let total = 0;
  for (const conv of state.conversations.values()) {
    if (conv.id !== exceptId) total += conv.unreadCount || 0;
  }
  return total;
}

function updateDocumentTitle() {
  const n = totalUnread();
  document.title = n ? `(${n}) TealTalk` : 'TealTalk';
}

export function initChats() {
  $('new-chat-button').addEventListener('click', () => {
    location.hash = '#/new';
  });
  $('settings-button').addEventListener('click', () => {
    location.hash = '#/settings';
  });
  on('conversations', renderChats);
  on('typing', renderChats);
  on('me', renderChats);
}
