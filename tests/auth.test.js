'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, request, register, uniqueName } = require('./helpers');

describe('auth', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test('health needs no auth', async () => {
    const res = await request(app, 'GET', '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  test('register returns 201 with token and normalized user', async () => {
    const res = await request(app, 'POST', '/api/register', {
      body: { username: '  Sam_One ', password: 'password123', displayName: '  Sam  ' },
    });
    assert.equal(res.status, 201);
    assert.equal(typeof res.body.token, 'string');
    assert.ok(res.body.token.length >= 40);
    assert.match(res.body.user.id, /^u_/);
    assert.deepEqual(Object.keys(res.body.user).sort(), ['displayName', 'id', 'username']);
    assert.equal(res.body.user.username, 'sam_one');
    assert.equal(res.body.user.displayName, 'Sam');
  });

  test('display name defaults to the username', async () => {
    const name = uniqueName('dflt');
    const { user } = await register(app, name);
    assert.equal(user.displayName, name);
    const blank = await request(app, 'POST', '/api/register', {
      body: { username: uniqueName('blank'), password: 'password123', displayName: '   ' },
    });
    assert.equal(blank.status, 201);
    assert.equal(blank.body.user.displayName, blank.body.user.username);
  });

  test('register validation', async () => {
    const cases = [
      { username: 'ab', password: 'password123' },
      { username: 'a'.repeat(25), password: 'password123' },
      { username: 'bad name', password: 'password123' },
      { username: 'bad-name', password: 'password123' },
      { username: 'émile', password: 'password123' },
      { username: 123, password: 'password123' },
      { username: 'okname', password: 'short' },
      { username: 'okname', password: 'x'.repeat(201) },
      { username: 'okname', password: 12345678 },
      { username: 'okname', password: 'password123', displayName: 'x'.repeat(41) },
      { username: 'okname', password: 'password123', displayName: 42 },
      { password: 'password123' },
    ];
    for (const body of cases) {
      const res = await request(app, 'POST', '/api/register', { body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof res.body.error, 'string');
    }
  });

  test('bad JSON and non-object bodies are 400 without stack traces', async () => {
    const bad = await request(app, 'POST', '/api/register', { body: '{not json' });
    assert.equal(bad.status, 400);
    assert.ok(!/at .*\.js/.test(bad.text));
    const arr = await request(app, 'POST', '/api/register', { body: '[1,2]' });
    assert.equal(arr.status, 400);
  });

  test('oversized JSON body is 413', async () => {
    const res = await request(app, 'POST', '/api/register', {
      body: { username: 'bigbody', password: 'x'.repeat(70 * 1024) },
    });
    assert.equal(res.status, 413);
  });

  test('duplicate username is 409, case-insensitively', async () => {
    const name = uniqueName('dup');
    await register(app, name);
    const res = await request(app, 'POST', '/api/register', {
      body: { username: name.toUpperCase(), password: 'password123' },
    });
    assert.equal(res.status, 409);
  });

  test('login works, wrong password and unknown user are 401', async () => {
    const name = uniqueName('login');
    await register(app, name, { password: 'the right one' });
    const ok = await request(app, 'POST', '/api/login', { body: { username: name.toUpperCase(), password: 'the right one' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.username, name);
    assert.ok(ok.body.token);
    const wrong = await request(app, 'POST', '/api/login', { body: { username: name, password: 'the wrong one' } });
    assert.equal(wrong.status, 401);
    const unknown = await request(app, 'POST', '/api/login', { body: { username: 'nobody_here', password: 'whatever1' } });
    assert.equal(unknown.status, 401);
    const missing = await request(app, 'POST', '/api/login', { body: { username: name } });
    assert.equal(missing.status, 400);
  });

  test('me requires a valid token', async () => {
    const { token, user } = await register(app);
    assert.equal((await request(app, 'GET', '/api/me')).status, 401);
    assert.equal((await request(app, 'GET', '/api/me', { token: 'nope' })).status, 401);
    assert.equal((await request(app, 'GET', '/api/me', { headers: { Authorization: 'Basic abc' } })).status, 401);
    const me = await request(app, 'GET', '/api/me', { token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { user }); // no sms field any more
    // Query-string tokens are only for WS and attachments.
    assert.equal((await request(app, 'GET', `/api/me?token=${token}`)).status, 401);
  });

  test('PATCH /api/me updates display name with validation', async () => {
    const { token } = await register(app);
    const ok = await request(app, 'PATCH', '/api/me', { token, body: { displayName: '  New Name ' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.displayName, 'New Name');
    assert.equal((await request(app, 'GET', '/api/me', { token })).body.user.displayName, 'New Name');
    for (const displayName of ['', '   ', 'x'.repeat(41), null, 5, 'bad\u0000name']) {
      const res = await request(app, 'PATCH', '/api/me', { token, body: { displayName } });
      assert.equal(res.status, 400, JSON.stringify(displayName));
    }
    assert.equal((await request(app, 'PATCH', '/api/me', { body: { displayName: 'x' } })).status, 401);
  });

  test('logout revokes only that token', async () => {
    const name = uniqueName('logout');
    const first = await register(app, name);
    const second = await request(app, 'POST', '/api/login', { body: { username: name, password: 'correct horse battery' } });
    const res = await request(app, 'POST', '/api/logout', { token: first.token });
    assert.equal(res.status, 204);
    assert.equal((await request(app, 'GET', '/api/me', { token: first.token })).status, 401);
    assert.equal((await request(app, 'GET', '/api/me', { token: second.body.token })).status, 200);
    assert.equal((await request(app, 'POST', '/api/logout', { token: first.token })).status, 401);
  });

  test('tokens are stored hashed, passwords with scrypt', async () => {
    const { token, user } = await register(app);
    const session = app.store.db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id);
    assert.notEqual(session.token_hash, token);
    assert.match(session.token_hash, /^[0-9a-f]{64}$/);
    const row = app.store.db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(user.id);
    assert.ok(!row.password_hash.includes('correct horse'));
    assert.ok(row.password_salt.length >= 16);
  });

  test('user search: prefix on username or display name, excludes me, max 20', async () => {
    const me = await register(app, 'zeta_me', { displayName: 'Zeta Me' });
    await register(app, 'zeta_one', { displayName: 'Someone' });
    await register(app, 'other_person', { displayName: 'Zeta Display' });
    await register(app, 'not_matching', { displayName: 'Nope' });
    const res = await request(app, 'GET', '/api/users/search?q=ZeT', { token: me.token });
    assert.equal(res.status, 200);
    const names = res.body.users.map((u) => u.username).sort();
    assert.deepEqual(names, ['other_person', 'zeta_one']);
    assert.deepEqual(Object.keys(res.body.users[0]).sort(), ['displayName', 'id', 'username']);

    // Infix is not a prefix match; LIKE wildcards are literal.
    assert.deepEqual((await request(app, 'GET', '/api/users/search?q=eta', { token: me.token })).body.users, []);
    assert.deepEqual((await request(app, 'GET', '/api/users/search?q=%25', { token: me.token })).body.users, []);
    assert.deepEqual((await request(app, 'GET', '/api/users/search?q=', { token: me.token })).body.users, []);

    for (let i = 0; i < 25; i++) await register(app, `many_${i}`);
    const many = await request(app, 'GET', '/api/users/search?q=many', { token: me.token });
    assert.equal(many.body.users.length, 20);
    assert.equal((await request(app, 'GET', '/api/users/search?q=zeta')).status, 401);
  });

  test('unknown API routes are JSON 404 and wrong methods 405', async () => {
    const res = await request(app, 'GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
    const m = await request(app, 'DELETE', '/api/me');
    assert.equal(m.status, 405);
  });
});

describe('rate limiting', () => {
  let app;
  before(async () => {
    app = await startApp({ rateLimit: { max: 20, windowMs: 10 * 60 * 1000 } });
  });
  after(() => app.close());

  test('login and register share a per-IP budget of 20 attempts', async () => {
    await register(app, 'ratelimited');
    let statuses = [];
    for (let i = 0; i < 19; i++) {
      const res = await request(app, 'POST', '/api/login', { body: { username: 'ratelimited', password: 'wrong password' } });
      statuses.push(res.status);
    }
    assert.ok(statuses.every((s) => s === 401), statuses.join());
    const limited = await request(app, 'POST', '/api/login', {
      body: { username: 'ratelimited', password: 'correct horse battery' },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const reg = await request(app, 'POST', '/api/register', { body: { username: 'another', password: 'password123' } });
    assert.equal(reg.status, 429);
    // Other endpoints are not affected.
    assert.equal((await request(app, 'GET', '/api/health')).status, 200);
    statuses = null;
  });
});

describe('signup code', () => {
  let app;
  before(async () => {
    app = await startApp({ signupCode: 'teal-2026' });
  });
  after(() => app.close());

  test('register requires the right code', async () => {
    const base = { username: uniqueName('code'), password: 'correct horse battery' };
    for (const signupCode of [undefined, '', 'nope', 'TEAL-2026', 42, 'teal-2026x']) {
      const res = await request(app, 'POST', '/api/register', { body: { ...base, signupCode } });
      assert.equal(res.status, 403, String(signupCode));
      assert.deepEqual(res.body, { error: "That signup code isn't right." });
    }
    assert.equal(app.store.usernameExists(base.username), false);
    const ok = await request(app, 'POST', '/api/register', { body: { ...base, signupCode: ' teal-2026 ' } });
    assert.equal(ok.status, 201);
    // Login never needs it.
    const login = await request(app, 'POST', '/api/login', { body: base });
    assert.equal(login.status, 200);
  });

  test('SIGNUP_CODE is read from the environment; blank means open signup', async () => {
    const saved = process.env.SIGNUP_CODE;
    try {
      process.env.SIGNUP_CODE = ' from-env ';
      const gated = await startApp({ signupCode: undefined });
      try {
        const body = { username: uniqueName('env'), password: 'correct horse battery' };
        assert.equal((await request(gated, 'POST', '/api/register', { body })).status, 403);
        assert.equal((await request(gated, 'POST', '/api/register', { body: { ...body, signupCode: 'from-env' } })).status, 201);
      } finally {
        await gated.close();
      }
      process.env.SIGNUP_CODE = '   ';
      const open = await startApp({ signupCode: undefined });
      try {
        const body = { username: uniqueName('open'), password: 'correct horse battery' };
        assert.equal((await request(open, 'POST', '/api/register', { body })).status, 201);
      } finally {
        await open.close();
      }
    } finally {
      if (saved === undefined) delete process.env.SIGNUP_CODE;
      else process.env.SIGNUP_CODE = saved;
    }
  });
});
