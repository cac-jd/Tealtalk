// New chat: search people, pick one (1:1) or several (group).

import { Api } from '../api.js';
import { h, clear, avatar, debounce } from '../dom.js';
import { upsertConversation } from '../store.js';
import { toast, icon, ICONS } from './common.js';

const $ = (id) => document.getElementById(id);

/** userId -> User */
const selected = new Map();
let results = [];
let searchSeq = 0;
let creating = false;

function setHint(text) {
  const el = $('search-hint');
  el.textContent = text;
  el.hidden = !text;
}

function renderResults() {
  const list = $('user-results');
  clear(list);
  for (const user of results) {
    const isSelected = selected.has(user.id);
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
            'aria-pressed': isSelected ? 'true' : 'false',
            onclick: () => toggle(user),
          },
          avatar(user.id, user.displayName),
          h(
            'span',
            { class: 'names' },
            h('span', { class: 'display', text: user.displayName }),
            h('span', { class: 'username', text: `@${user.username}` }),
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
    location.hash = '#/';
  });
}

export function openNewChat() {
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
  clear($('user-results'));
  clear($('selected-chips'));
}
