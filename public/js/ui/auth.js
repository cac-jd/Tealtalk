// Login / register screen.

import { Api, setToken } from '../api.js';
import { setMe } from '../store.js';

let mode = 'login'; // or 'register'

const $ = (id) => document.getElementById(id);

function setMode(next) {
  mode = next;
  const register = mode === 'register';
  $('auth-displayname-field').hidden = !register;
  $('auth-hint').hidden = !register;
  $('auth-submit').textContent = register ? 'Create account' : 'Log in';
  $('auth-toggle').textContent = register ? 'Log in' : 'Create account';
  $('auth-switch-text').textContent = register ? 'Already have an account?' : 'New to TealTalk?';
  $('auth-password').setAttribute('autocomplete', register ? 'new-password' : 'current-password');
  showError('');
}

function showError(text) {
  const el = $('auth-error');
  el.textContent = text;
  el.hidden = !text;
}

export function initAuth({ onAuthed }) {
  setMode('login');

  $('auth-toggle').addEventListener('click', () => {
    setMode(mode === 'login' ? 'register' : 'login');
    $('auth-username').focus();
  });

  let busy = false;
  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const username = $('auth-username').value.trim().toLowerCase();
    const password = $('auth-password').value;
    const displayName = $('auth-displayname').value.trim();
    if (!username || !password) {
      showError('Enter a username and password.');
      return;
    }
    busy = true;
    const submit = $('auth-submit');
    submit.disabled = true;
    showError('');
    try {
      const result =
        mode === 'register'
          ? await Api.register(username, password, displayName || undefined)
          : await Api.login(username, password);
      setToken(result.token);
      setMe(result.user);
      $('auth-password').value = '';
      $('auth-displayname').value = '';
      onAuthed();
    } catch (err) {
      showError(
        err.status === 401
          ? 'Wrong username or password.'
          : err.message || 'Something went wrong. Please try again.',
      );
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });
}

export function showAuth() {
  $('auth-password').value = '';
  showError('');
}
