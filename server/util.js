'use strict';

const crypto = require('node:crypto');

/** An error that maps directly onto an HTTP status and a safe, human readable message. */
class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers || null;
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self' ws: wss:",
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function setSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function sendEmpty(res, status = 204) {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

/** Read and parse a JSON object body, enforcing a byte limit. An empty body parses as {}. */
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (size === 0) {
        resolve({});
        return;
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(new HttpError(400, 'Body must be a JSON object'));
        return;
      }
      resolve(value);
    });
    req.on('error', () => fail(new HttpError(400, 'Bad request')));
    req.on('aborted', () => fail(new HttpError(400, 'Request aborted')));
  });
}

/** Split a raw request target into a pathname and URLSearchParams without letting `//host` be parsed as authority. */
function parseTarget(rawUrl) {
  const url = typeof rawUrl === 'string' ? rawUrl : '/';
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : url.slice(q + 1));
  return { pathname, query };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function hasControlChars(s) {
  return CONTROL_CHARS.test(s);
}

module.exports = {
  HttpError,
  newId,
  CSP,
  SECURITY_HEADERS,
  setSecurityHeaders,
  sendJson,
  sendEmpty,
  readJson,
  parseTarget,
  hasControlChars,
};
