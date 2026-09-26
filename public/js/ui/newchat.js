// New chat: search people, pick one (1:1) or several (group).
// The same screen adds people to an existing group ("add mode").

import { Api } from '../api.js';
import { h, clear, avatar, debounce } from '../dom.js';
import { upsertConversation, getConversation, conversationTitle } from '../store.js';
import { toast, icon, ICONS, backTo } from './common.js';

const $ = (id) => document.getElementById(id);

/** userId -> User */
const selected = new Map();
let results = [];
let searchSeq = 0;
let creating = false;
/** Conversation id when adding people to a group, else null. */
let addTo = null;

function memberIds() {
  const conv = addTo && getConversation(addTo);
  return new Set(conv ? (conv.members || []).map((m) => m.id) : []);
}

function setHint(text) {
  const el = $('search-hint');
  el.textContent = text;
  el.hidden = !text;
}

function renderResults() {
  const list = $('user-results');
  clear(list);
  const already = memberIds();
  for (const user of results) {
    const isSelected = selected.has(user.id);
    const inGroup = already.has(user.id);
    list.appendChild(
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'user-result',
            dataset: { testid: 'user-result', userId: user.id },
            'aria-pressed': isSelected || inGroup ? 'true' : 'false',
            disabled: inGroup,
            onclick: () => toggle(user),
          },
          avatar(user.id, user.displayName),
          h(
            'span',
            { class: 'names' },
            h('span', { class: 'display', text: user.displayName }),
            h('span', { class: 'username', text: inGroup ? `@${user.username} · already in the group` : `@${user.username}` }),
          ),
          h('span', { class: 'check' }, icon(ICONS.check)),
        ),
      ),
    );
  }
}

function renderSelection() {
  const chips = $('selected-chips');
  clear(chips);
  for (const user of selected.values()) {
    chips.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'aria-label': `Remove ${user.displayName}`,
          onclick: () => toggle(user),
        },
        user.displayName,
        h('span', { class: 'chip-x', 'aria-hidden': 'true', text: '×' }),
      ),
    );
  }
  const button = $('create-chat-button');
  button.disabled = selected.size === 0 || creating;
  if (addTo) {
    button.textContent = selected.size > 1 ? `Add ${selected.size} people` : 'Add to group';
    return;
  }
  const title = $('group-title-input').value.trim();
  button.textContent = selected.size > 1 || (selected.size === 1 && title) ? 'Create group' : 'Start chat';
}

function toggle(user) {
  if (selected.has(user.id)) selected.delete(user.id);
  else selected.set(user.id, user);
  renderResults();
  renderSelection();
}

async function search(q) {
  const seq = ++searchSeq;
  if (!q) {
    results = [];
    renderResults();
    setHint(selected.size ? '' : 'Find people by their name or username.');
    return;
  }
  try {
    const { users } = await Api.searchUsers(q);
    if (seq !== searchSeq) return; // a newer search is on its way
    results = users;
    renderResults();
    setHint(users.length ? '' : `No one found for “${q}”.`);
  } catch (err) {
    if (seq !== searchSeq) return;
    setHint(err.isNetwork ? 'You are offline. Search needs a connection.' : err.message);
  }
}

const debouncedSearch = debounce((q) => search(q), 180);

async function create() {
  if (!selected.size || creating) return;
  creating = true;
  renderSelection();
  if (addTo) {
    const id = addTo;
    try {
      const { conversation } = await Api.addMembers(id, [...selected.keys()]);
      upsertConversation(conversation);
      location.replace(`#/c/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(err.message || 'Could not add them to the group.');
    } finally {
      creating = false;
      renderSelection();
    }
    return;
  }
  try {
    const title = $('group-title-input').value.trim();
    const { conversation } = await Api.createConversation([...selected.keys()], title || undefined);
    upsertConversation(conversation);
    location.replace(`#/c/${encodeURIComponent(conversation.id)}`);
  } catch (err) {
    toast(err.message || 'Could not create the chat.');
  } finally {
    creating = false;
    renderSelection();
  }
}

export function initNewChat() {
  $('user-search-input').addEventListener('input', (e) => debouncedSearch(e.target.value.trim()));
  $('user-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search(e.target.value.trim());
    }
  });
  $('group-title-input').addEventListener('input', renderSelection);
  $('group-title-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create();
    }
  });
  $('create-chat-button').addEventListener('click', create);
  $('new-chat-back').addEventListener('click', () => {
    if (addTo) backTo(`#/c/${encodeURIComponent(addTo)}/info`);
    else location.hash = '#/';
  });
}

/** `addToId`: add people to that group instead of starting a chat. */
export function openNewChat(addToId = null) {
  addTo = addToId;
  const conv = addTo && getConversation(addTo);
  $('new-chat-heading').textContent = addTo ? 'Add people' : 'New chat';
  $('new-chat-back').setAttribute('aria-label', addTo ? `Back to ${conversationTitle(conv) || 'the group'}` : 'Back to chats');
  $('group-title-field').hidden = !!addTo;
  selected.clear();
  results = [];
  searchSeq++;
  $('user-search-input').value = '';
  $('group-title-input').value = '';
  renderResults();
  renderSelection();
  setHint('Find people by their name or username.');
}

export function closeNewChat() {
  searchSeq++;
  results = [];
  selected.clear();
  addTo = null;
  clear($('user-results'));
  clear($('selected-chips'));
}
