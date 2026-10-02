#!/usr/bin/env node
'use strict';

// App fingerprint (docs/E2EE.md, "App fingerprint"): one SHA-256 over every file the server
// delivers as the app, so anyone can check that the app they were sent is the published release.
//
// Usage: npm run fingerprint            (fingerprints public/)
//        node scripts/fingerprint.js DIR (fingerprints another directory)
//
// The algorithm, exactly (the client computes the same value in Settings > About):
//   1. Take every regular file under public/, recursively (dotfiles included, symlinks and
//      directories themselves skipped).
//   2. For each file, its path is relative to public/, with '/' separators and a leading '/',
//      e.g. "/index.html", "/js/crypto/keys.js".
//   3. For each file, line = path + "\n" + lowercase hex SHA-256 of the file's bytes + "\n".
//   4. Sort the lines by path, comparing UTF-16 code units (JavaScript's default sort; the same
//      as byte order for ASCII paths).
//   5. fingerprint = lowercase hex SHA-256 of the UTF-8 bytes of all lines concatenated.
// No dependencies, Node's own crypto only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Every regular file under `root` as a POSIX path starting with '/'. */
function listFiles(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, childRel));
    else if (entry.isFile()) out.push(`/${childRel}`);
  }
  return out;
}

/** The fingerprint of directory `root`, plus the per-file lines it was computed from. */
function fingerprint(root) {
  const paths = listFiles(root).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = paths.map((p) => `${p}\n${sha256hex(fs.readFileSync(path.join(root, ...p.slice(1).split('/'))))}\n`);
  return { fingerprint: sha256hex(Buffer.from(lines.join(''), 'utf8')), lines };
}

module.exports = { fingerprint, listFiles };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
  try {
    console.log(fingerprint(root).fingerprint);
  } catch (err) {
    console.error(`Could not fingerprint ${root}: ${err && err.message}`);
    process.exit(1);
  }
}
