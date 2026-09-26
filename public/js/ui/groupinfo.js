// Group info: members, add people, rename, leave.

import { Api } from '../api.js';
import { h, clear, avatar } from '../dom.js';
import { state, on, getConversation, upsertConversation, removeConversation, conversationTitle } from '../store.js';
import { conversationAvatar } from './chats.js';
import { toast, announce, backTo } from './common.js';

const $ = (id) => document.getElementById(id);

let convId = null;
let leaving = false;

export function openGroupInfo(id) {
  convId = id;
  render();
  if (!getConversation(id)) {
    Api.conversation(id)
      .then(({ conversation }) => upsertConversation(conversation))
      .catch(() => {
        if (convId === id) location.replace('#/');
      });
  }
}

export function closeGroupInfo() {
  closeRename();
  convId = null;
}

function render() {
  const conv = getConversation(convId);
  const list = $('group-members');
  clear(list);
  clear($('group-info-avatar'));
  if (!conv) {
    $('group-info-name').textContent = 'Loading…';
    $('group-info-count').textContent = '';
    return;
  }
  $('group-info-avatar').appendChild(conversationAvatar(conv, 'large'));
  $('group-info-name').textContent = conversationTitle(conv);
  const members = [...(conv.members || [])].sort((a, b) => {
    const meId = state.me && state.me.id;
    if (a.id === meId) return -1;
    if (b.id === meId) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
  $('group-info-count').textContent = `${members.length} ${members.length === 1 ? 'member' : 'members'}`;
  for (const m of members) {
    const me = state.me && m.id === state.me.id;
    list.appendChild(
      h(
        'li',
        { class: 'member' },
        avatar(m.id, m.displayName, 'small'),
        h(
          'span',
          { class: 'names' },
          h('span', { class: 'display', text: me ? `${m.displayName} (you)` : m.displayName }),
          h('span', { class: 'username', text: `@${m.username}` }),
        ),
        !me && state.online.has(m.id) ? h('span', { class: 'online-dot', text: 'online' }) : null,
      ),
    );
  }
}

async function leave() {
  const conv = getConversation(convId);
  if (!conv || leaving) return;
  const name = conversationTitle(conv);
  if (!window.confirm(`Leave “${name}”? You won't get its messages any more.`)) return;
  leaving = true;
  const button = $('leave-group-button');
  button.disabled = true;
  try {
    await Api.leaveConversation(conv.id);
    removeConversation(conv.id);
    location.replace('#/');
    announce(`You left ${name}`);
  } catch (err) {
    toast(err.message || 'Could not leave the group.');
  } finally {
    leaving = false;
    button.disabled = false;
  }
}

// ---------- rename ----------

function showRenameError(text) {
  const el = $('rename-error');
  el.textContent = text;
  el.hidden = !text;
}

function openRename() {
  const conv = getConversation(convId);
  if (!conv || !conv.isGroup) return;
  const input = $('rename-input');
  input.value = conv.title || '';
  input.placeholder = conversationTitle(conv);
  showRenameError('');
  $('rename-save-button').disabled = false;
  const dialog = $('rename-dialog');
  dialog.dataset.conversationId = conv.id;
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
  input.focus();
  input.select();
}

function closeRename() {
  const dialog = $('rename-dialog');
  if (!dialog || !dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

async function saveRename() {
  const dialog = $('rename-dialog');
  const id = dialog.dataset.conversationId;
  const conv = getConversation(id);
  if (!conv) return;
  const title = $('rename-input').value.trim();
  if (!title) {
    showRenameError('Enter a group name.');
    $('rename-input').focus();
    return;
  }
  if (title === (conv.title || '')) {
    closeRename();
    return;
  }
  const button = $('rename-save-button');
  button.disabled = true;
  showRenameError('');
  try {
    const { conversation } = await Api.renameConversation(id, title);
    upsertConversation(conversation);
    if (dialog.dataset.conversationId === id) closeRename();
    announce(`Renamed to ${title}`);
  } catch (err) {
    showRenameError(err.message || 'Could not save the name.');
  } finally {
    button.disabled = false;
  }
}

export function initGroupInfo() {
  $('group-info-back').addEventListener('click', () => {
    backTo(convId ? `#/c/${encodeURIComponent(convId)}` : '#/');
  });
  $('add-members-button').addEventListener('click', () => {
    if (convId) location.hash = `#/c/${encodeURIComponent(convId)}/add`;
  });
  $('leave-group-button').addEventListener('click', leave);
  $('rename-button').addEventListener('click', openRename);
  $('rename-cancel').addEventListener('click', closeRename);
  $('rename-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveRename();
  });
  $('rename-dialog').addEventListener('close', () => {
    if (convId) $('rename-button').focus({ preventScroll: true });
  });
  const refresh = (id) => {
    if (convId && (!id || id === convId)) render();
  };
  on('conversation', refresh);
  on('presence', () => refresh());
  on('me', () => refresh());
}
