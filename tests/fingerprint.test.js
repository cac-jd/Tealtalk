'use strict';

// `npm run fingerprint` (scripts/fingerprint.js): the documented algorithm, determinism, and
// sensitivity to any change in the app's files.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fingerprint } = require('../scripts/fingerprint');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fingerprint.js');
const run = (dir) => execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' }).trim();
const hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function writeTree(root, files) {
  for (const [rel, content] of files) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

describe('app fingerprint script', () => {
  let tmp;
  const files = [
    ['index.html', '<!doctype html><title>TealTalk</title>'],
    ['app.js', 'export const x = 1;\n'],
    ['js/crypto/keys.js', 'export const k = 2;\n'],
    ['js/a.js', 'a'],
    ['icons/icon-192.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])],
    ['.well-known/x', 'dot'],
    ['sw.js', ''],
  ];
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tealtalk-fp-'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('matches an independent computation of the documented algorithm', () => {
    const dir = path.join(tmp, 'a');
    writeTree(dir, files);
    // sorted lines of `path + "\n" + sha256hex(file) + "\n"`, paths relative to the root with a leading '/'
    const expectedLines = files
      .map(([rel, content]) => [`/${rel}`, content])
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([p, content]) => `${p}\n${hex(content)}\n`);
    assert.deepEqual(
      expectedLines.map((l) => l.split('\n')[0]),
      ['/.well-known/x', '/app.js', '/icons/icon-192.png', '/index.html', '/js/a.js', '/js/crypto/keys.js', '/sw.js']
    );
    const expected = hex(expectedLines.join(''));
    const result = fingerprint(dir);
    assert.deepEqual(result.lines, expectedLines);
    assert.equal(result.fingerprint, expected);
    assert.equal(run(dir), expected);
    assert.match(run(dir), /^[0-9a-f]{64}$/);
  });

  test('deterministic: same files in another order or place give the same value', () => {
    const one = path.join(tmp, 'one');
    const two = path.join(tmp, 'elsewhere', 'two');
    writeTree(one, files);
    writeTree(two, [...files].reverse());
    // Timestamps and permissions don't matter, only paths and bytes.
    fs.utimesSync(path.join(two, 'app.js'), new Date(0), new Date(0));
    fs.chmodSync(path.join(two, 'sw.js'), 0o600);
    assert.equal(run(one), run(two));
    assert.equal(run(one), run(one));
  });

  test('any change to a file, a name or the set of files changes it', () => {
    const base = path.join(tmp, 'base');
    writeTree(base, files);
    const original = run(base);
    const variant = (name, mutate) => {
      const dir = path.join(tmp, name);
      writeTree(dir, files);
      mutate(dir);
      return run(dir);
    };
    const results = [
      variant('edited', (d) => fs.appendFileSync(path.join(d, 'app.js'), ' ')),
      variant('byte', (d) => fs.writeFileSync(path.join(d, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 254]))),
      variant('renamed', (d) => fs.renameSync(path.join(d, 'js', 'a.js'), path.join(d, 'js', 'b.js'))),
      variant('moved', (d) => {
        fs.mkdirSync(path.join(d, 'lib'));
        fs.renameSync(path.join(d, 'js', 'a.js'), path.join(d, 'lib', 'a.js'));
      }),
      variant('added', (d) => fs.writeFileSync(path.join(d, 'extra.js'), '')),
      variant('removed', (d) => fs.rmSync(path.join(d, 'sw.js'))),
    ];
    for (const r of results) assert.notEqual(r, original);
    assert.equal(new Set(results).size, results.length);
  });

  test('npm run fingerprint prints the fingerprint of public/', () => {
    const out = execFileSync('npm', ['run', '--silent', 'fingerprint'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    assert.match(out, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'index.html')));
  });
});
