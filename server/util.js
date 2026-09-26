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

/** Read a whole request body into a Buffer, enforcing a byte limit (413 when exceeded). */
function readBody(req, limit) {
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
      resolve(Buffer.concat(chunks, size));
    });
    req.on('error', () => fail(new HttpError(400, 'Bad request')));
    req.on('aborted', () => fail(new HttpError(400, 'Request aborted')));
  });
}

/** Read and parse a JSON object body, enforcing a byte limit. An empty body parses as {}. */
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  let value;
  try {
    value = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  return value;
}

/**
 * Read an application/x-www-form-urlencoded body (e.g. a Twilio webhook), enforcing a byte limit.
 * Returns the decoded [name, value] pairs in their original order (415 for other content types).
 */
async function readForm(req, limit) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new HttpError(415, 'Expected application/x-www-form-urlencoded');
  }
  const buf = await readBody(req, limit);
  return [...new URLSearchParams(buf.toString('utf8'))];
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
  readBody,
  readJson,
  readForm,
  parseTarget,
  hasControlChars,
};
