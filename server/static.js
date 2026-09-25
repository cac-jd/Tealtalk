'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

async function statFile(file) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function sendText(res, status, text, extra) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

/**
 * Serves files from `publicDir`. Path traversal and dotfiles are refused; any other
 * unknown path falls back to index.html so client-side routes work.
 */
function createStaticHandler(publicDir) {
  const root = path.resolve(publicDir);

  async function serveFile(req, res, file, st) {
    const headers = {
      'Content-Type': mimeFor(file),
      'Cache-Control': 'no-cache',
      ETag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (path.basename(file) === 'sw.js' && path.dirname(file) === root) {
      headers['Service-Worker-Allowed'] = '/';
    }
    if (req.headers['if-none-match'] === headers.ETag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return async function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) {
      sendText(res, 400, 'Bad request');
      return;
    }
    const segments = decoded.split('/').filter(Boolean);
    if (segments.some((s) => s === '..' || s.startsWith('.'))) {
      sendText(res, 404, 'Not found');
      return;
    }
    const target = path.resolve(root, '.' + path.posix.sep + segments.join('/'));
    if (target !== root && !target.startsWith(root + path.sep)) {
      sendText(res, 404, 'Not found');
      return;
    }

    let file = target;
    let st = await statFile(file);
    if (!st) {
      const indexInDir = path.join(target, 'index.html');
      st = await statFile(indexInDir);
      if (st) file = indexInDir;
    }
    if (!st) {
      file = path.join(root, 'index.html');
      st = await statFile(file);
    }
    if (!st) {
      sendText(res, 404, 'Not found');
      return;
    }
    await serveFile(req, res, file, st);
  };
}

module.exports = { createStaticHandler, mimeFor };
